// Shared notification fan-out helper (2026-08-20). "Who should be notified about research X" is
// every researcher currently assigned to it via ResearcherResearch, PLUS every superadmin (they
// aren't rows in that join table — scope.mjs treats them as seeing everything) — always excluding
// the researcher who triggered the event themselves (they don't need to be told about their own
// action). Resolved fresh from the DB each time (not the JWT's cached researchIds), since this
// needs to reach every current member, not just the acting researcher's own stale-by-design view.
import { getDb } from '../db.mjs';

/**
 * @param {ReturnType<typeof getDb>} sql
 * @param {{
 *   researchId: number,
 *   type: string,
 *   actorResearcherId: number,
 *   buildMessage: (lang: 'sr' | 'en') => string,
 * }} params
 */
export async function notifyResearchMembers(sql, { researchId, type, actorResearcherId, buildMessage }) {
  const recipients = await sql`
    SELECT DISTINCT r."Id", r."Language"
    FROM "Researcher" r
    WHERE r."IsSuperAdmin" = TRUE
       OR r."Id" IN (SELECT "ResearcherId" FROM "ResearcherResearch" WHERE "ResearchId" = ${researchId})
  `;

  for (const r of recipients) {
    if (r.Id === actorResearcherId) continue;
    const lang = r.Language === 'en' ? 'en' : 'sr';
    const message = buildMessage(lang);
    await sql`
      INSERT INTO "Notification" ("ResearcherId", "ResearchId", "Type", "Message")
      VALUES (${r.Id}, ${researchId}, ${type}, ${message})
    `;
  }
}
