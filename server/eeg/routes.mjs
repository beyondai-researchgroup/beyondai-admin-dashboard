import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { resolveParticipantByBareId, AMBIGUOUS_PARTICIPANT } from '../participants/resolve.mjs';
import { parseInsight5Csv, buildSegments, downsampleSeries, avgSignalQuality, RECOGNIZED_DEVICE } from './insight5.mjs';
import * as r2 from '../storage/r2.mjs';

const router = Router();
router.use(requireAuth);

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB — raw CSV is stored directly in Postgres (TEXT).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

const PREVIEW_DEFAULT_LIMIT = 200;
const PREVIEW_MAX_LIMIT = 2000;

/** Fetches a participant's stored EEG CSV text — from R2 when the row has a StorageKey, or the
 *  "RawCsv" TEXT column otherwise (old rows, or R2 unconfigured). Every read site below goes
 *  through this instead of assuming "RawCsv" is populated. */
async function readEegCsv(row) {
  if (row.StorageKey) return r2.getObjectText(row.StorageKey);
  return row.RawCsv;
}

/** Naive CSV split — fine for plain numeric EEG export CSVs, not quote/escape aware. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { columns: [], dataLines: [] };
  const columns = lines[0].split(',').map((c) => c.trim());
  return { columns, dataLines: lines.slice(1) };
}

function rowToObject(columns, line) {
  const cells = line.split(',');
  const row = {};
  columns.forEach((col, i) => {
    row[col] = cells[i] !== undefined ? cells[i].trim() : null;
  });
  return row;
}

/** Looks up the participant's ResearchId and authorizes the request against it — EEG routes
 *  are keyed by participantId, not researchId, so scope has to be resolved this way round
 *  instead of the usual `resolveResearchScope(req.researcher, req.query.researchId)`.
 *
 *  Item 1 of the "platform improvements round 2" plan — ParticipantId is scoped per research now,
 *  not globally unique, and EegRecording has no ResearchId column of its own to filter by, so
 *  every EegRecording query below must key off ParticipantGuid (resolved here, once, correctly)
 *  instead of the bare ParticipantId — otherwise a collision could silently read/write the wrong
 *  research's EEG data. A genuinely ambiguous id fails loud (409) rather than picking one. Returns
 *  `{ researchId, participantGuid }` on success, or null (having already sent a response). */
async function authorizeForParticipant(req, res, participantId) {
  const sql = getDb();
  const participant = await resolveParticipantByBareId(sql, participantId);
  if (participant === AMBIGUOUS_PARTICIPANT) {
    res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
    return null;
  }
  if (!participant) {
    res.status(404).json({ error: 'Participant not found' });
    return null;
  }
  try {
    resolveResearchScope(req.researcher, participant.ResearchId);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return null;
    }
    throw err;
  }
  return { researchId: participant.ResearchId, participantGuid: participant.Guid };
}

router.get('/:participantId', async (req, res) => {
  const { participantId } = req.params;
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const rows = await sql`
      SELECT "OriginalFilename", "DeviceType", "RowCount", "Columns", "UploadedAt"
      FROM "EegRecording" WHERE "ParticipantGuid" = ${auth.participantGuid} LIMIT 1
    `;
    if (!rows.length) {
      res.json({ exists: false });
      return;
    }
    const r = rows[0];
    res.json({
      exists: true,
      originalFilename: r.OriginalFilename,
      deviceType: r.DeviceType,
      rowCount: r.RowCount,
      columns: JSON.parse(r.Columns),
      uploadedAt: r.UploadedAt,
    });
  } catch (err) {
    console.error('[eeg] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:participantId/preview', async (req, res) => {
  const { participantId } = req.params;
  const limit = Math.min(Math.max(Number(req.query.limit) || PREVIEW_DEFAULT_LIMIT, 1), PREVIEW_MAX_LIMIT);
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const rows = await sql`SELECT "RawCsv", "Columns", "StorageKey" FROM "EegRecording" WHERE "ParticipantGuid" = ${auth.participantGuid} LIMIT 1`;
    if (!rows.length) {
      res.json({ columns: [], rows: [] });
      return;
    }
    const { columns, dataLines } = parseCsv(await readEegCsv(rows[0]));
    res.json({ columns, rows: dataLines.slice(0, limit).map((line) => rowToObject(columns, line)) });
  } catch (err) {
    console.error('[eeg] preview error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Recognized-format interpretation: composite band-power-derived indices (Engagement, Cognitive
// Load, Frontal Asymmetry) over time, plus a per-session-marker comparison — see insight5.mjs for
// why no FFT/DSP is needed here (the collector app's "pow" stream already gives band power, not
// raw voltage). Re-parses the full stored CSV on every call rather than caching a derived copy —
// simplest option, and this endpoint isn't hit often enough to matter.
router.get('/:participantId/interpretation', async (req, res) => {
  const { participantId } = req.params;
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();

    // Skip parsing entirely for a research configured with any device other than the
    // recognized one — matches the upload-time validation above and the Participant Detail
    // page's own gating, so a coincidentally-matching CSV from a different device never
    // surfaces interpretation charts it shouldn't.
    const deviceRows = await sql`SELECT "EegDeviceType" FROM "Research" WHERE "Id" = ${auth.researchId} LIMIT 1`;
    if (deviceRows[0]?.EegDeviceType !== RECOGNIZED_DEVICE) {
      res.json({ recognized: false });
      return;
    }

    const rows = await sql`SELECT "RawCsv", "StorageKey" FROM "EegRecording" WHERE "ParticipantGuid" = ${auth.participantGuid} LIMIT 1`;
    if (!rows.length) {
      res.json({ recognized: false });
      return;
    }

    const parsed = parseInsight5Csv(await readEegCsv(rows[0]));
    if (!parsed.recognized) {
      res.json({ recognized: false });
      return;
    }

    res.json({
      recognized: true,
      markers: parsed.markers.map((m) => ({ code: m.code, timestamp: m.timestamp })),
      series: downsampleSeries(parsed.dataRows),
      segments: buildSegments(parsed.markers, parsed.dataRows),
      avgSignalQuality: avgSignalQuality(parsed.dataRows),
    });
  } catch (err) {
    console.error('[eeg] interpretation error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:participantId/download', async (req, res) => {
  const { participantId } = req.params;
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const rows = await sql`SELECT "OriginalFilename", "RawCsv", "StorageKey" FROM "EegRecording" WHERE "ParticipantGuid" = ${auth.participantGuid} LIMIT 1`;
    if (!rows.length) {
      res.status(404).json({ error: 'No EEG recording for this participant' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].OriginalFilename || `${participantId}-eeg.csv`}"`);
    res.send(await readEegCsv(rows[0]));
  } catch (err) {
    console.error('[eeg] download error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// multer errors (e.g. file too large) surface via its own callback, not inside the async route
// handler below — they never reach that handler's try/catch since they happen one middleware
// step earlier, so they're handled right here instead.
function uploadSingleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB)` });
        return;
      }
      console.error('[eeg] upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

router.post('/:participantId', uploadSingleFile, async (req, res) => {
  const { participantId } = req.params;
  try {
    // A falsy return here always means authorizeForParticipant already sent an error response
    // (404/403/409 AMBIGUOUS_PARTICIPANT_ID) and we should bail out.
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    if (!req.file) {
      res.status(400).json({ error: 'A CSV file is required (field name "file")' });
      return;
    }

    const rawCsv = req.file.buffer.toString('utf8');
    const { columns, dataLines } = parseCsv(rawCsv);
    if (!columns.length) {
      res.status(400).json({ error: 'CSV file appears to be empty' });
      return;
    }

    const sql = getDb();
    const deviceRows = await sql`SELECT "EegDeviceType" FROM "Research" WHERE "Id" = ${auth.researchId} LIMIT 1`;
    const deviceType = deviceRows[0]?.EegDeviceType ?? null;

    // Only the recognized device gets format-validated at upload time — any other configured
    // device accepts whatever CSV shape it produces (download/preview-only, never parsed here).
    if (deviceType === RECOGNIZED_DEVICE && !parseInsight5Csv(rawCsv).recognized) {
      res.status(400).json({
        error: 'INVALID_FORMAT',
        message: `File does not match the expected ${RECOGNIZED_DEVICE} CSV format (columns/header mismatch).`,
      });
      return;
    }

    // Same R2-or-DB split as task-files/routes.mjs's upload — when configured, the CSV text goes
    // to R2 and "RawCsv" is left NULL for this row; a prior R2-backed recording's old object is
    // intentionally left behind (storage-cost leak, not correctness) rather than risk deleting it
    // before the new upload's own INSERT has actually committed.
    let storageKey = null;
    let dbRawCsv = rawCsv;
    if (r2.isConfigured()) {
      storageKey = await r2.putObject(r2.buildKey('eeg', participantId, req.file.originalname), req.file.buffer, 'text/csv');
      dbRawCsv = null;
    }

    // Conflict target moved from (ParticipantId) to (ParticipantGuid) — auto-populated by the
    // set_participant_guid trigger from ParticipantId before the conflict check runs.
    await sql`
      INSERT INTO "EegRecording" ("ParticipantId", "OriginalFilename", "DeviceType", "RawCsv", "RowCount", "Columns", "StorageKey")
      VALUES (${participantId}, ${req.file.originalname}, ${deviceType}, ${dbRawCsv}, ${dataLines.length}, ${JSON.stringify(columns)}, ${storageKey})
      ON CONFLICT ("ParticipantGuid") DO UPDATE SET
        "OriginalFilename" = EXCLUDED."OriginalFilename",
        "DeviceType" = EXCLUDED."DeviceType",
        "RawCsv" = EXCLUDED."RawCsv",
        "RowCount" = EXCLUDED."RowCount",
        "Columns" = EXCLUDED."Columns",
        "StorageKey" = EXCLUDED."StorageKey",
        "UploadedAt" = NOW()
    `;
    res.status(201).json({ ok: true, rowCount: dataLines.length, columns });
  } catch (err) {
    console.error('[eeg] upload error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:participantId', async (req, res) => {
  const { participantId } = req.params;
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const deleted = await sql`DELETE FROM "EegRecording" WHERE "ParticipantGuid" = ${auth.participantGuid} RETURNING "StorageKey"`;
    if (deleted[0]?.StorageKey) {
      try {
        await r2.deleteObject(deleted[0].StorageKey);
      } catch (err) {
        console.error('[eeg] R2 delete failed (DB row already removed):', err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[eeg] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
