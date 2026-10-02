import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { computeDescriptiveStats, findParticipantRow } from './descriptive-stats.mjs';
import { validateGoogleFormsUpload } from './validate-upload.mjs';
import * as r2 from '../storage/r2.mjs';

// Task Configuration Phase 2 (2026-08-19): generic multi-file upload/download for a research's
// Google Forms/Generic task materials — many files per research (no uniqueness constraint,
// unlike EegRecording's one-per-participant), stored as BYTEA (binary-safe, unlike
// EegRecording's TEXT — survey exports/attachments can be XLSX/PDF/etc., not just CSV). Same
// multer-memoryStorage + error-wrapper pattern as server/eeg/routes.mjs.
const router = Router();
router.use(requireAuth);

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB per file, same ceiling as EEG uploads.
const MAX_FILES_PER_UPLOAD = 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD } });

function scopeGuard(req, res, id) {
  try {
    resolveResearchScope(req.researcher, id);
    return true;
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

/** Fetches a TaskFile row's bytes — from R2 when it has a StorageKey (uploaded while R2 was
 *  configured), or straight from the "FileContent" BYTEA column otherwise (old rows, or any
 *  environment without R2 credentials). Every read path (download, CSV parsing for descriptive
 *  stats / participant-answers) goes through this instead of assuming "FileContent" is populated. */
async function readTaskFileBytes(row) {
  if (row.StorageKey) return r2.getObject(row.StorageKey);
  return Buffer.from(row.FileContent);
}

// multer errors (file too large, too many files) surface via its own callback, not inside the
// async route handler — they fire one middleware step earlier, same reasoning as eeg/routes.mjs.
function uploadFiles(req, res, next) {
  upload.array('files', MAX_FILES_PER_UPLOAD)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB per file)` });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ error: `Too many files (max ${MAX_FILES_PER_UPLOAD} per upload)` });
        return;
      }
      console.error('[task-files] upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

router.get('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "OriginalFilename", "ContentType", "FileSizeBytes", "UploadedAt"
      FROM "TaskFile" WHERE "ResearchId" = ${id} ORDER BY "UploadedAt" DESC
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id, originalFilename: r.OriginalFilename, contentType: r.ContentType,
        fileSizeBytes: r.FileSizeBytes, uploadedAt: r.UploadedAt,
      }))
    );
  } catch (err) {
    console.error('[task-files] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:researchId', uploadFiles, async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const files = req.files;
  if (!files || !files.length) {
    res.status(400).json({ error: 'At least one file is required (field name "files")' });
    return;
  }

  try {
    const sql = getDb();
    // Verify the research exists before inserting — otherwise a bad id would throw a raw FK-
    // violation error instead of a clean 404 (same fix already applied for consent-sections).
    // Also fetches TaskType — needed right below to decide whether the CSV-only/form-match rules
    // apply at all (2026-09-08 follow-up: those rules are Google-Forms-specific).
    const research = await sql`SELECT "TaskType" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }

    if (research[0].TaskType === 'GOOGLE_FORMS') {
      const questionRows = await sql`SELECT "ColumnKey" FROM "TaskFormQuestion" WHERE "ResearchId" = ${id}`;
      const validation = validateGoogleFormsUpload(files, questionRows.map((r) => ({ columnKey: r.ColumnKey })));
      if (!validation.ok) {
        // Nothing is inserted when any file fails — an all-or-nothing batch keeps the error
        // message unambiguous (no need to also report which files DID make it through).
        res.status(400).json({ error: 'UPLOAD_VALIDATION_FAILED', details: validation.errors });
        return;
      }
    }

    const inserted = [];
    for (const file of files) {
      // Upload to R2 first (outside the DB round trip) when configured — the DB row then only
      // ever carries the StorageKey, never the bytes themselves. An R2 failure here throws before
      // any row is inserted, so a half-uploaded file never becomes a DB row with a dangling key.
      let storageKey = null;
      let dbContent = file.buffer;
      if (r2.isConfigured()) {
        storageKey = await r2.putObject(r2.buildKey('task-files', id, file.originalname), file.buffer, file.mimetype);
        dbContent = null;
      }
      const rows = await sql`
        INSERT INTO "TaskFile" ("ResearchId", "OriginalFilename", "ContentType", "FileContent", "FileSizeBytes", "StorageKey")
        VALUES (${id}, ${file.originalname}, ${file.mimetype || null}, ${dbContent}, ${file.size}, ${storageKey})
        RETURNING "Id", "OriginalFilename", "ContentType", "FileSizeBytes", "UploadedAt"
      `;
      const r = rows[0];
      inserted.push({
        id: r.Id, originalFilename: r.OriginalFilename, contentType: r.ContentType,
        fileSizeBytes: r.FileSizeBytes, uploadedAt: r.UploadedAt,
      });
    }
    res.status(201).json(inserted);
  } catch (err) {
    console.error('[task-files] upload error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/:fileId/download', async (req, res) => {
  const id = Number(req.params.researchId);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(fileId) || fileId <= 0) {
    res.status(400).json({ error: 'Invalid research or file id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "OriginalFilename", "ContentType", "FileContent", "StorageKey" FROM "TaskFile"
      WHERE "Id" = ${fileId} AND "ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const r = rows[0];
    const bytes = await readTaskFileBytes(r);
    res.setHeader('Content-Type', r.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${r.OriginalFilename}"`);
    res.send(bytes);
  } catch (err) {
    console.error('[task-files] download error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:researchId/:fileId', async (req, res) => {
  const id = Number(req.params.researchId);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(fileId) || fileId <= 0) {
    res.status(400).json({ error: 'Invalid research or file id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      DELETE FROM "TaskFile" WHERE "Id" = ${fileId} AND "ResearchId" = ${id} RETURNING "Id", "StorageKey"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    // Best-effort — the DB row is already gone (the source of truth for "does this file exist"),
    // so a dangling R2 object on failure is a storage-cost leak, not a correctness problem.
    if (rows[0].StorageKey) {
      try {
        await r2.deleteObject(rows[0].StorageKey);
      } catch (err) {
        console.error('[task-files] R2 delete failed (DB row already removed):', err);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[task-files] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Descriptive statistics (Part G of the platform re-architecture, 2026-09-07) — computed
// on-demand from the research's most-recently-uploaded .csv TaskFile (survey-sized data, cheap
// enough to recompute every read rather than caching), joined against TaskFormQuestion for
// friendly labels/types. No CSV upload yet, or none of them is a .csv, both 404 NO_CSV_FILE —
// XLSX/PDF attachments alongside the results CSV are ignored for this purpose.
router.get('/:researchId/descriptive-stats', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const fileRows = await sql`
      SELECT "Id", "OriginalFilename", "FileContent", "StorageKey" FROM "TaskFile"
      WHERE "ResearchId" = ${id} AND "OriginalFilename" ILIKE '%.csv'
      ORDER BY "UploadedAt" DESC LIMIT 1
    `;
    if (!fileRows.length) {
      res.status(404).json({ error: 'NO_CSV_FILE' });
      return;
    }
    const questionRows = await sql`
      SELECT "ColumnKey", "Label", "QuestionType", "IsParticipantIdColumn" FROM "TaskFormQuestion"
      WHERE "ResearchId" = ${id} ORDER BY "SortOrder"
    `;
    const questions = questionRows.map((r) => ({ columnKey: r.ColumnKey, label: r.Label, questionType: r.QuestionType }));
    const idColumnKey = questionRows.find((r) => r.IsParticipantIdColumn)?.ColumnKey ?? null;

    const csvText = (await readTaskFileBytes(fileRows[0])).toString('utf8');
    let stats;
    try {
      stats = computeDescriptiveStats(csvText, questions, idColumnKey);
    } catch (err) {
      console.error('[task-files] CSV parse error:', err?.message ?? err);
      res.status(400).json({ error: 'CSV_PARSE_ERROR', detail: err?.message ?? 'Unknown error' });
      return;
    }

    // Participant↔survey-row matching (2026-09-08 follow-up) — only computed when a researcher
    // has actually designated an ID column; `null` (not an empty object) signals "not configured"
    // to the frontend, distinct from "configured, but nobody has responded yet".
    let participantMatch = null;
    if (idColumnKey) {
      const participants = await sql`
        SELECT "ParticipantId", "FirstName", "LastName" FROM "Participant" WHERE "ResearchId" = ${id}
      `;
      const respondedIds = new Set(stats.participantIdValues);
      const notResponded = participants
        .filter((p) => !respondedIds.has(p.ParticipantId))
        .map((p) => ({ participantId: p.ParticipantId, firstName: p.FirstName, lastName: p.LastName }));
      participantMatch = {
        idColumnKey,
        totalParticipants: participants.length,
        matchedCount: participants.length - notResponded.length,
        notResponded,
      };
    }

    res.json({ sourceFilename: fileRows[0].OriginalFilename, rowCount: stats.rowCount, columns: stats.columns, participantMatch });
  } catch (err) {
    console.error('[task-files] descriptive-stats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Per-participant survey answers (2026-09-08 follow-up) — the counterpart to descriptive-stats'
// aggregate view, for Participant Detail's "Odgovori na anketu" section. `matched:false` covers
// every "nothing to show" case uniformly (no ID column configured, no CSV uploaded yet, or this
// specific participant's id doesn't appear in the CSV) — the frontend renders one clear empty
// state regardless of which of those it actually is.
router.get('/:researchId/participant-answers/:participantId', async (req, res) => {
  const id = Number(req.params.researchId);
  const participantId = req.params.participantId;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const questionRows = await sql`
      SELECT "ColumnKey", "Label", "IsParticipantIdColumn" FROM "TaskFormQuestion" WHERE "ResearchId" = ${id}
    `;
    const idColumnKey = questionRows.find((r) => r.IsParticipantIdColumn)?.ColumnKey ?? null;
    if (!idColumnKey) {
      res.json({ matched: false, answers: null });
      return;
    }

    const fileRows = await sql`
      SELECT "FileContent", "StorageKey" FROM "TaskFile"
      WHERE "ResearchId" = ${id} AND "OriginalFilename" ILIKE '%.csv'
      ORDER BY "UploadedAt" DESC LIMIT 1
    `;
    if (!fileRows.length) {
      res.json({ matched: false, answers: null });
      return;
    }

    const csvText = (await readTaskFileBytes(fileRows[0])).toString('utf8');
    const questions = questionRows.map((r) => ({ columnKey: r.ColumnKey, label: r.Label }));
    let answers;
    try {
      answers = findParticipantRow(csvText, idColumnKey, participantId, questions);
    } catch (err) {
      console.error('[task-files] participant-answers CSV parse error:', err?.message ?? err);
      res.status(400).json({ error: 'CSV_PARSE_ERROR' });
      return;
    }
    res.json({ matched: answers !== null, answers });
  } catch (err) {
    console.error('[task-files] participant-answers error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
