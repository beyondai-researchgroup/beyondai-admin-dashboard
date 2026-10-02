// Day-before-session reminder (2026-08-20) — an in-process setInterval, not an external cron:
// no scheduled-job infrastructure exists anywhere in this app (confirmed via exploration before
// this was built) and none is being introduced. Runs every REMINDER_INTERVAL_MS, and once
// immediately at server startup so a fresh deploy doesn't wait a full interval before the first
// check. Ticking many times a day is intentional/harmless — the dedup guard below ensures at
// most one SESSION_REMINDER notification per (research, day) regardless of how many times this
// fires.
import { getDb } from '../db.mjs';
import { notifyResearchMembers } from './create.mjs';

export const REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

export async function runSessionReminderCheck() {
  const sql = getDb();
  try {
    // Every research with at least one scheduled (assigned + timed) participant-session
    // tomorrow.
    const rows = await sql`
      SELECT DISTINCT es."ResearchId", es."SessionDate", res."Name" AS "ResearchName",
        (SELECT COUNT(*)::int FROM "ParticipantSession" ps2
         WHERE ps2."ExperimentalSessionId" = es."Id" AND ps2."ScheduledTime" IS NOT NULL) AS "SessionCount"
      FROM "ExperimentalSession" es
      JOIN "ParticipantSession" ps ON ps."ExperimentalSessionId" = es."Id"
      JOIN "Research" res ON res."Id" = es."ResearchId"
      WHERE es."SessionDate" = (CURRENT_DATE + INTERVAL '1 day')::date
        AND ps."ScheduledTime" IS NOT NULL
    `;

    for (const row of rows) {
      const researchId = row.ResearchId;

      // Dedup: skip if a SESSION_REMINDER notification for this research was already created
      // today (regardless of which of possibly several tomorrow-dated sessions triggered it).
      const already = await sql`
        SELECT 1 FROM "Notification"
        WHERE "ResearchId" = ${researchId} AND "Type" = 'SESSION_REMINDER' AND "CreatedAt"::date = CURRENT_DATE
        LIMIT 1
      `;
      if (already.length > 0) continue;

      const researchName = row.ResearchName;
      const sessionCount = row.SessionCount;
      await notifyResearchMembers(sql, {
        researchId,
        type: 'SESSION_REMINDER',
        actorResearcherId: -1, // no human actor — notify every member, nobody excluded
        buildMessage: (lang) =>
          lang === 'en'
            ? `Reminder: "${researchName}" has ${sessionCount} scheduled participant session(s) tomorrow.`
            : `Podsetnik: istraživanje „${researchName}" ima ${sessionCount} zakazanih sesija sutra.`,
      });
    }
  } catch (err) {
    console.error('[notifications] session reminder check failed:', err);
  }
}

export function startSessionReminderJob() {
  runSessionReminderCheck();
  setInterval(runSessionReminderCheck, REMINDER_INTERVAL_MS);
}
