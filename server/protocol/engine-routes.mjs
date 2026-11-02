import crypto from 'node:crypto';
import { Router } from 'express';
import { getDb } from '../db.mjs';
import { advanceParticipant, advanceAllDue } from './engine.mjs';
import { drainOutbox } from '../email/outbox.mjs';

// Public-facing entry points of the protocol engine (not under /api/admin: the caller is another
// platform app, not a logged-in researcher). Authenticated with a shared secret header instead.
//
//   POST /api/protocol-engine/advance   { participantGuid }   — a module / the forms app reports that a
//     participant finished something, so their next step can go out right away. Idempotent.
//   GET  /api/cron/protocol-engine      — daily sweep (Vercel Cron, Bearer CRON_SECRET): sends due
//     scheduled steps and reconciles anything a missed notification left behind.
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/advance', async (req, res) => {
  if (!secretMatches(req.get('x-engine-secret'), process.env.PROTOCOL_ENGINE_SECRET)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  const guid = req.body?.participantGuid;
  if (typeof guid !== 'string' || !UUID_RE.test(guid)) {
    res.status(400).json({ error: 'Invalid participantGuid' });
    return;
  }
  try {
    const r = await advanceParticipant(getDb(), guid.toLowerCase());
    // A CLASSIC research (or an unknown participant) is not an error for the caller: nothing to do.
    res.json({ ok: r.ok, reason: r.reason ?? null, finished: !!r.finished });
  } catch (err) {
    console.error('[protocol-engine] advance error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** Handler for GET /api/cron/protocol-engine (mounted in server/index.mjs next to the other cron route). */
export async function protocolCronHandler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  try {
    const swept = await advanceAllDue(getDb());
    res.json({ ok: true, ...swept, mail: await drainOutbox(getDb(), { budgetMs: 30_000 }) });
  } catch (err) {
    console.error('[protocol-engine] cron error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

export default router;
