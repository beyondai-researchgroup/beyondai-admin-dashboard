import crypto from 'node:crypto';
import { buildTeamInviteEmail } from '../email/teamInviteEmail.mjs';
import { sendMail } from '../email/mailer.mjs';

// Shared by both write paths that can add an EXISTING researcher to a research they aren't
// already on (server/researches/routes.mjs's PUT /:id/team/:researcherId, and
// server/researchers/routes.mjs's PUT /:id whole-set-replace) — 2026-09-08, per the user's
// explicit request that adding an existing researcher to a research requires them to accept an
// emailed invite before they can see that research's data, regardless of which admin surface
// initiated it.
const INVITE_TTL_MS = 48 * 60 * 60 * 1000; // 48h — same as ResearcherInviteToken's own TTL.

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * If (researcherId, researchId) is already an accepted member, applies the role change
 * immediately (no invite needed) — {status: 'updated'}. Otherwise ensures a pending
 * ResearchTeamInvite exists — {status: 'invited', emailSent, resent}. The email is only actually
 * (re-)sent when a fresh invite is created or a stale one had expired — a still-pending, unexpired
 * invite just gets its role silently updated (no resend) so that saving an unrelated profile edit
 * on the superadmin's whole-set-replace path (PUT /api/admin/researchers/:id, which re-processes
 * every currently-targeted research id on every save) doesn't spam a repeat invite email each
 * time. Best-effort on the email send (logged, not thrown) — this is a repeat-safe action,
 * unlike the new-account invite where a failed send is a genuine dead end.
 */
export async function inviteOrAssign(sql, { researcherId, researchId, role, actorResearcherId, researcherEmail, researcherLang, researchName }) {
  const existingMember = await sql`
    SELECT 1 FROM "ResearcherResearch" WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId} LIMIT 1
  `;
  if (existingMember.length) {
    await sql`
      UPDATE "ResearcherResearch" SET "Role" = ${role}
      WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId}
    `;
    return { status: 'updated' };
  }

  const existingInvite = await sql`
    SELECT "ExpiresAt" FROM "ResearchTeamInvite" WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId} LIMIT 1
  `;
  const needsFreshToken = !existingInvite.length || new Date(existingInvite[0].ExpiresAt) < new Date();

  let token;
  if (needsFreshToken) {
    token = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await sql`
      INSERT INTO "ResearchTeamInvite" ("ResearcherId", "ResearchId", "Role", "Token", "ExpiresAt", "CreatedByResearcherId")
      VALUES (${researcherId}, ${researchId}, ${role}, ${token}, ${expiresAt}, ${actorResearcherId ?? null})
      ON CONFLICT ("ResearcherId", "ResearchId") DO UPDATE SET
        "Role" = EXCLUDED."Role", "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt",
        "CreatedByResearcherId" = EXCLUDED."CreatedByResearcherId", "CreatedAt" = NOW()
    `;
  } else {
    // Still pending and not expired — just keep the stored role in sync, no new token, no resend.
    await sql`
      UPDATE "ResearchTeamInvite" SET "Role" = ${role}
      WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId}
    `;
    return { status: 'invited', emailSent: true, resent: false };
  }

  let emailSent = true;
  if (researcherEmail) {
    try {
      const appUrl = process.env.ADMIN_DASHBOARD_APP_URL || '';
      const acceptUrl = `${appUrl}/accept-team-invite/${token}`;
      const lang = researcherLang === 'en' ? 'en' : 'sr';
      const { subject, html } = buildTeamInviteEmail(lang, { acceptUrl, researchName });
      await sendMail({ to: researcherEmail, subject, html });
    } catch (mailErr) {
      console.error('[team-invite] invite email send failed:', mailErr);
      emailSent = false;
    }
  } else {
    emailSent = false;
  }

  return { status: 'invited', emailSent, resent: true };
}

/** Deletes a pending invite for the pair, if one exists. Used wherever a researchId drops out of
 *  a submitted set (or an explicit "withdraw invite" action) before it was ever accepted. */
export async function withdrawInviteIfPending(sql, { researcherId, researchId }) {
  const rows = await sql`
    DELETE FROM "ResearchTeamInvite" WHERE "ResearcherId" = ${researcherId} AND "ResearchId" = ${researchId} RETURNING "Id"
  `;
  return rows.length > 0;
}
