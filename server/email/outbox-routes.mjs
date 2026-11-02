import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { drainOutbox, outboxStats } from './outbox.mjs';

// The researcher's view of the mail queue of one research (2026-10-30): how many messages wait, how many failed, how much of
// today's allowance is used, plus "send now" and "try the failed ones again". Mounted at /api/admin/mail-outbox.
const router = Router();
router.use(requireAuth);

const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];

function parseResearch(req, res, write = false) {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return null;
  }
  try {
    resolveResearchScope(req.researcher, id);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return null;
    }
    throw err;
  }
  if (write && !hasMinRole(req.researcher, id, WRITE_ROLES)) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return null;
  }
  return id;
}

router.get('/:researchId', async (req, res) => {
  const researchId = parseResearch(req, res);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const failed = await sql`
      SELECT o."Id", o."ToEmail", o."Subject", o."LastError", o."Attempts", p."ParticipantId"
      FROM "EmailOutbox" o LEFT JOIN "Participant" p ON p."Guid" = o."ParticipantGuid"
      WHERE o."ResearchId" = ${researchId} AND o."Status" = 'FAILED' ORDER BY o."Id" DESC LIMIT 20
    `;
    res.json({
      ...(await outboxStats(sql, researchId)),
      failedItems: failed.map((f) => ({ id: f.Id, participantId: f.ParticipantId ?? null, to: f.ToEmail, subject: f.Subject, error: f.LastError, attempts: f.Attempts })),
    });
  } catch (err) {
    console.error('[mail-outbox] stats error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// "Send now": a drain right away, within the same limits as the automatic one.
router.post('/:researchId/drain', async (req, res) => {
  const researchId = parseResearch(req, res, true);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const result = await drainOutbox(sql, { budgetMs: 40_000 });
    res.json({ ...result, ...(await outboxStats(sql, researchId)) });
  } catch (err) {
    console.error('[mail-outbox] drain error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Gives the failed messages another go (their attempt counter starts again).
router.post('/:researchId/retry-failed', async (req, res) => {
  const researchId = parseResearch(req, res, true);
  if (researchId == null) return;
  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "EmailOutbox" SET "Status" = 'PENDING', "Attempts" = 0, "NextAttemptAt" = NOW(), "LastError" = NULL
      WHERE "ResearchId" = ${researchId} AND "Status" = 'FAILED' RETURNING "Id"
    `;
    res.json({ ok: true, requeued: rows.length });
  } catch (err) {
    console.error('[mail-outbox] retry error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/cron/mail-outbox (Bearer CRON_SECRET): the drain that runs on a schedule. Vercel's own cron only runs once a
 * day on the free plan, so a scheduled GitHub Action calls this every few minutes (see .github/workflows/mail-outbox.yml).
 */
export async function mailOutboxCronHandler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  try {
    res.json({ ok: true, ...(await drainOutbox(getDb(), { budgetMs: 50_000 })) });
  } catch (err) {
    console.error('[mail-outbox] cron error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export default router;
