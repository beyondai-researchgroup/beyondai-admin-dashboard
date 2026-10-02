import { Router } from 'express';
import { getDb } from '../db.mjs';
import { notifyResearchMembers } from '../notifications/create.mjs';

// Public — no requireAuth (per the user's explicit choice: the emailed token alone is the
// authentication, no login required to accept — same trust model as every other magic-link flow
// in this platform). Mirrors server/researcher-invite/routes.mjs's resolve/accept shape exactly:
// NOT_FOUND -> EXPIRED -> ALREADY_ACCEPTED tiering. "Already accepted" is inferred from a
// matching ResearcherResearch row already existing — no separate "used" flag on the invite row
// itself, same infer-completion-from-downstream-state pattern SurveyAccessToken/
// ResearcherInviteToken already established.
const router = Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

async function resolveInvite(sql, token) {
  const rows = await sql`
    SELECT ti."Id" AS "InviteId", ti."ResearcherId", ti."ResearchId", ti."Role", ti."ExpiresAt",
           r."FirstName", res."Name" AS "ResearchName"
    FROM "ResearchTeamInvite" ti
    JOIN "Researcher" r ON r."Id" = ti."ResearcherId"
    JOIN "Research" res ON res."Id" = ti."ResearchId"
    WHERE ti."Token" = ${token}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function alreadyAccepted(sql, { researcherId, researchId }) {
  const rows = await sql`
    SELECT 1 FROM "ResearcherResearch" WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId} LIMIT 1
  `;
  return rows.length > 0;
}

router.get('/:token', async (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  try {
    const sql = getDb();
    const row = await resolveInvite(sql, token);
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (await alreadyAccepted(sql, { researcherId: row.ResearcherId, researchId: row.ResearchId })) {
      res.status(409).json({ error: 'ALREADY_ACCEPTED' });
      return;
    }
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }
    res.json({ researchName: row.ResearchName, researcherFirstName: row.FirstName });
  } catch (err) {
    console.error('[team-invite] resolve error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:token/accept', async (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  try {
    const sql = getDb();
    const row = await resolveInvite(sql, token);
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (await alreadyAccepted(sql, { researcherId: row.ResearcherId, researchId: row.ResearchId })) {
      res.status(409).json({ error: 'ALREADY_ACCEPTED' });
      return;
    }
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }

    await sql`
      INSERT INTO "ResearcherResearch" ("ResearcherId", "ResearchId", "Role")
      VALUES (${row.ResearcherId}, ${row.ResearchId}, ${row.Role})
      ON CONFLICT ("ResearcherId", "ResearchId") DO NOTHING
    `;
    // Unlike SurveyAccessToken/ResearcherInviteToken's own "leave it in place" precedent, this
    // invite row IS deleted on acceptance — caught live during this feature's own verification:
    // leaving it in place made an accepted researcher appear TWICE in the Team list (once
    // 'active' from ResearcherResearch, once still 'pending' from the lingering invite row,
    // since GET /:id/team's pending-invites query has no other way to know it was already acted
    // on). Deleting it here is simpler and more correct than adding a NOT EXISTS exclusion to
    // every pending-invite read query — resolution/accept would already 409 ALREADY_ACCEPTED via
    // the ResearcherResearch existence check even if this delete somehow didn't happen.
    await sql`DELETE FROM "ResearchTeamInvite" WHERE "ResearcherId" = ${row.ResearcherId} AND "ResearchId" = ${row.ResearchId}`;

    // 2026-09-09 — let the rest of the team (and any superadmin) know someone actually joined,
    // instead of them having to notice on their next visit to the Team list. Own try/catch so a
    // notification hiccup can never turn a successful accept into a 500 — everything needed
    // (ResearchId/ResearchName/the accepting researcher's own FirstName) is already resolved
    // above, no extra query.
    try {
      await notifyResearchMembers(sql, {
        researchId: row.ResearchId,
        type: 'TEAM_INVITE_ACCEPTED',
        actorResearcherId: row.ResearcherId,
        buildMessage: (lang) =>
          lang === 'en'
            ? `${row.FirstName} joined the research "${row.ResearchName}".`
            : `${row.FirstName} se pridružio/la istraživanju „${row.ResearchName}".`,
      });
    } catch (notifyErr) {
      console.error('[team-invite] notification fan-out failed:', notifyErr);
    }

    res.json({ ok: true, researchName: row.ResearchName });
  } catch (err) {
    console.error('[team-invite] accept error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
