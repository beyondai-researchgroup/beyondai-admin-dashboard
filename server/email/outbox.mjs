// Outbox for the e-mails of the research protocol and the sheets links (2026-10-30).
//
// Why: the free mail relay (Apps Script) sends about 100 recipients a day, and a serverless function has about 60 s, so a
// bulk send that loops over sendMail either hits the quota (the message is lost) or the time limit (half the participants
// are skipped). Here every message is written to EmailOutbox first; a drain sends them, never more than MAIL_DAILY_LIMIT in
// any 24 hours, and keeps what the relay refused for a later attempt. Nothing is lost, it only may take more days.
import { sendMail } from './mailer.mjs';
import { runInBackground } from '../background.mjs';

/** How many messages may be SENT in any 24 hours (the relay's own limit is 100; the rest is left for one-off mails). */
export const dailyLimit = () => Number(process.env.MAIL_DAILY_LIMIT) || 90;
const MAX_ATTEMPTS = 6;
const STUCK_AFTER_MS = 5 * 60 * 1000;
/** The relay's wording when its daily quota is used up. */
const QUOTA_ERROR = /too many times|quota|limit exceeded|rate limit/i;

/** Writes one message to the queue. Returns its id. */
export async function enqueueMail(sql, { researchId = null, participantGuid = null, stepId = null, to, subject, html, fromName = null }) {
  const rows = await sql`
    INSERT INTO "EmailOutbox" ("ResearchId","ParticipantGuid","StepId","ToEmail","Subject","Html","FromName")
    VALUES (${researchId}, ${participantGuid}, ${stepId}, ${to}, ${subject}, ${html}, ${fromName})
    RETURNING "Id"
  `;
  return rows[0].Id;
}

/** Messages sent in the last 24 hours (all researches: the relay's quota is shared). */
async function sentLast24h(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS n FROM "EmailOutbox" WHERE "Status" = 'SENT' AND "SentAt" > NOW() - INTERVAL '24 hours'`;
  return rows[0].n;
}

/** Takes up to `n` due messages for this drain (a message another drain is sending is skipped; a stuck one is taken again). */
async function claim(sql, n) {
  if (n <= 0) return [];
  return sql`
    UPDATE "EmailOutbox" o SET "Status" = 'SENDING', "ClaimedAt" = NOW(), "Attempts" = o."Attempts" + 1
    WHERE o."Id" IN (
      SELECT "Id" FROM "EmailOutbox"
      WHERE ("Status" = 'PENDING' AND "NextAttemptAt" <= NOW())
         OR ("Status" = 'SENDING' AND "ClaimedAt" < NOW() - make_interval(secs => ${STUCK_AFTER_MS / 1000}))
      ORDER BY "Id" LIMIT ${n} FOR UPDATE SKIP LOCKED
    )
    RETURNING o."Id", o."ToEmail", o."Subject", o."Html", o."FromName", o."Attempts"
  `;
}

/**
 * Sends what is due, within the daily limit and a time budget.
 * @returns {{ sent: number, failed: number, deferred: number, limitReached: boolean, stoppedByQuota: boolean }}
 */
export async function drainOutbox(sql, { budgetMs = 40_000 } = {}) {
  const started = Date.now();
  const result = { sent: 0, failed: 0, deferred: 0, limitReached: false, stoppedByQuota: false };
  const limit = dailyLimit();
  let used = await sentLast24h(sql);
  while (Date.now() - started < budgetMs) {
    const room = limit - used;
    if (room <= 0) { result.limitReached = true; break; }
    const batch = await claim(sql, Math.min(room, 10));
    if (!batch.length) break;
    for (const m of batch) {
      if (Date.now() - started >= budgetMs) {
        // out of time: give it back untouched (the attempt did not happen)
        await sql`UPDATE "EmailOutbox" SET "Status" = 'PENDING', "Attempts" = "Attempts" - 1, "ClaimedAt" = NULL WHERE "Id" = ${m.Id}`;
        continue;
      }
      try {
        await sendMail({ to: m.ToEmail, subject: m.Subject, html: m.Html, fromName: m.FromName ?? undefined });
        await sql`UPDATE "EmailOutbox" SET "Status" = 'SENT', "SentAt" = NOW(), "ClaimedAt" = NULL, "LastError" = NULL WHERE "Id" = ${m.Id}`;
        result.sent++;
        used++;
      } catch (err) {
        const msg = String(err?.message ?? err).slice(0, 500);
        if (QUOTA_ERROR.test(msg)) {
          // the relay's own quota is used up: keep the message and stop for a few hours
          await sql`UPDATE "EmailOutbox" SET "Status" = 'PENDING', "Attempts" = "Attempts" - 1, "ClaimedAt" = NULL, "NextAttemptAt" = NOW() + INTERVAL '3 hours', "LastError" = ${msg} WHERE "Id" = ${m.Id}`;
          result.deferred++;
          result.stoppedByQuota = true;
        } else if (m.Attempts >= MAX_ATTEMPTS) {
          await sql`UPDATE "EmailOutbox" SET "Status" = 'FAILED', "ClaimedAt" = NULL, "LastError" = ${msg} WHERE "Id" = ${m.Id}`;
          result.failed++;
        } else {
          // transient: try again later, a little later each time (10, 20, 40 ... minutes)
          const minutes = 10 * 2 ** (m.Attempts - 1);
          await sql`UPDATE "EmailOutbox" SET "Status" = 'PENDING', "ClaimedAt" = NULL, "NextAttemptAt" = NOW() + make_interval(mins => ${minutes}), "LastError" = ${msg} WHERE "Id" = ${m.Id}`;
          result.deferred++;
        }
      }
    }
    if (result.stoppedByQuota) break;
  }
  return result;
}

let draining = false;

/**
 * Starts a drain without making the caller wait: on Vercel the work is registered with waitUntil (so the function stays
 * alive after it has answered), locally it simply runs on. One drain at a time per process. MAIL_OUTBOX_INLINE=true makes
 * it wait instead (used by the tests, which look at the mails right after a request).
 */
export async function kickOutbox(sql) {
  if (draining) return;
  const work = async () => {
    draining = true;
    try {
      await drainOutbox(sql, { budgetMs: 45_000 });
    } finally {
      draining = false;
    }
  };
  if (process.env.MAIL_OUTBOX_INLINE === 'true') await work();
  else runInBackground(work, 'mail outbox');
}

/** What the researcher sees: how many wait, how many failed, how much of today's allowance is used. */
export async function outboxStats(sql, researchId) {
  const rows = await sql`
    SELECT COUNT(*) FILTER (WHERE "Status" IN ('PENDING','SENDING'))::int AS "Pending",
           COUNT(*) FILTER (WHERE "Status" = 'FAILED')::int AS "Failed",
           MIN("NextAttemptAt") FILTER (WHERE "Status" = 'PENDING') AS "NextAttemptAt"
    FROM "EmailOutbox" WHERE "ResearchId" = ${researchId}
  `;
  return {
    pending: rows[0].Pending,
    failed: rows[0].Failed,
    nextAttemptAt: rows[0].NextAttemptAt ?? null,
    sentLast24h: await sentLast24h(sql),
    dailyLimit: dailyLimit(),
  };
}
