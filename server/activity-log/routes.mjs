import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { resolveParticipantByBareId, AMBIGUOUS_PARTICIPANT } from '../participants/resolve.mjs';
import * as r2 from '../storage/r2.mjs';

// Per-review-session activity logs, written by code-review-ai's ActivityLogService and persisted
// into "ActivityLog" by its StudyService when a session ends. Read-only here — the Admin
// Dashboard never writes one; it just renders the stored CSV as a table and hands back the
// original file on request.
//
// Own router mounted at its own base path, same anti-route-collision discipline as
// generic-task-results/task-config: a parameterized route registered after a path-segment-
// colliding one can silently steal its matches, so this stays fully separate.
const router = Router();
router.use(requireAuth);

/** Unlike the EEG routes' naive comma split, this CSV genuinely needs a real parser — the
 *  Detail column carries free text (chat messages, decision comments) that ActivityLogService
 *  quotes and escapes whenever it contains a comma, quote, or newline. */
function parseActivityCsv(rawCsv) {
  const records = parse(rawCsv, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  if (!records.length) return { columns: [], rows: [] };

  const columns = records[0].map((c) => String(c).trim());
  const rows = records.slice(1).map((cells) => {
    const row = {};
    columns.forEach((col, i) => {
      row[col] = cells[i] !== undefined ? cells[i] : null;
    });
    return row;
  });
  return { columns, rows };
}

/** Same reasoning as eeg/routes.mjs's authorizeForParticipant: these routes are keyed by
 *  participantId, not researchId, and "ActivityLog" has no ResearchId column of its own — so
 *  scope has to be resolved through the participant, and every query below keys off the
 *  resolved ParticipantGuid rather than the (per-research, non-globally-unique) bare id.
 *  Returns `{ researchId, participantGuid }`, or null having already sent a response. */
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

// GET /api/admin/activity-log/:participantId — metadata for every session this participant ran.
// Deliberately excludes "RawCsv": a session log can be large and this powers a summary list.
router.get('/:participantId', async (req, res) => {
  const { participantId } = req.params;
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const rows = await sql`
      SELECT a."Id", a."SessionId", s."Name" AS "SessionName", a."ReviewMode",
             a."OriginalFilename", a."RowCount", a."SavedAt"
      FROM "ActivityLog" a
      JOIN "Sessions" s ON s."Id" = a."SessionId"
      WHERE a."ParticipantGuid" = ${auth.participantGuid}
      ORDER BY a."SessionId"
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id,
        sessionId: r.SessionId,
        sessionName: r.SessionName,
        reviewMode: r.ReviewMode,
        originalFilename: r.OriginalFilename,
        rowCount: r.RowCount,
        savedAt: r.SavedAt,
      }))
    );
  } catch (err) {
    console.error('[activity-log] list failed', err);
    res.status(500).json({ error: 'Failed to load activity logs' });
  }
});

// GET /api/admin/activity-log/:participantId/:sessionId — the stored CSV parsed into
// columns + rows, ready to render as a plain table.
router.get('/:participantId/:sessionId', async (req, res) => {
  const { participantId } = req.params;
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const found = await sql`
      SELECT a."SessionId", s."Name" AS "SessionName", a."ReviewMode", a."OriginalFilename",
             a."RawCsv", a."RowCount", a."SavedAt", a."StorageKey"
      FROM "ActivityLog" a
      JOIN "Sessions" s ON s."Id" = a."SessionId"
      WHERE a."ParticipantGuid" = ${auth.participantGuid} AND a."SessionId" = ${sessionId}
      LIMIT 1
    `;
    if (!found.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const log = found[0];
    const rawCsv = log.StorageKey ? await r2.getObjectText(log.StorageKey) : log.RawCsv;
    const { columns, rows } = parseActivityCsv(rawCsv);
    res.json({
      sessionId: log.SessionId,
      sessionName: log.SessionName,
      reviewMode: log.ReviewMode,
      originalFilename: log.OriginalFilename,
      rowCount: log.RowCount,
      savedAt: log.SavedAt,
      columns,
      rows,
    });
  } catch (err) {
    console.error('[activity-log] detail failed', err);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
});

// GET /api/admin/activity-log/:participantId/:sessionId/download — the original CSV, untouched.
router.get('/:participantId/:sessionId/download', async (req, res) => {
  const { participantId } = req.params;
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }
  try {
    const auth = await authorizeForParticipant(req, res, participantId);
    if (!auth) return;

    const sql = getDb();
    const found = await sql`
      SELECT "OriginalFilename", "RawCsv", "StorageKey" FROM "ActivityLog"
      WHERE "ParticipantGuid" = ${auth.participantGuid} AND "SessionId" = ${sessionId}
      LIMIT 1
    `;
    if (!found.length) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const rawCsv = found[0].StorageKey ? await r2.getObjectText(found[0].StorageKey) : found[0].RawCsv;
    const filename = String(found[0].OriginalFilename).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(rawCsv);
  } catch (err) {
    console.error('[activity-log] download failed', err);
    res.status(500).json({ error: 'Failed to download activity log' });
  }
});

export default router;
