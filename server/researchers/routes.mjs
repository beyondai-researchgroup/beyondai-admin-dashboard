import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.mjs';
import { requireAuth, requireSuperAdmin } from '../auth/middleware.mjs';
import { sendMail } from '../email/mailer.mjs';
import { buildResearcherInviteEmail } from '../email/researcherInviteEmail.mjs';
import { dateOnly } from '../date-only.mjs';
import { RESEARCHER_ROLES } from '../roles.mjs';
import { inviteOrAssign, withdrawInviteIfPending } from './team-invite.mjs';

// Superadmin-only researcher account management (Phase B, 2026-08-18; reworked 2026-08-20 into a
// full profile system — see admin_dashboard_followup_2026_08_20 memory). A researcher's assigned
// researches are managed here as a set (via researchIds) — see
// Sql/016_researcher_research_many_to_many.sql.
//
// Creating a NEW researcher (2026-08-20) no longer takes a password directly — it generates a
// random one (bcrypt-hashed, satisfies PasswordHash NOT NULL, never surfaced anywhere — the
// researcher never authenticates with it) and MustChangePassword=TRUE, issues a
// ResearcherInviteToken, and emails a magic-link invite (server/researcher-invite/routes.mjs
// resolves it, public, no requireAuth). "Add an existing researcher" doesn't go through this
// route at all — the frontend just calls PUT /:id on the existing account with an expanded
// researchIds set, no new invite sent.
const router = Router();
router.use(requireAuth, requireSuperAdmin);

const MAX_NAME_LENGTH = 100;
const MAX_COUNTRY_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000; // 48h — longer than the 24h participant-facing survey
// links, since this is a one-time account setup rather than a repeatable link.
const ACADEMIC_STATUSES = ['PHD_STUDENT', 'MASTER', 'DOCTOR'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidResearchIds(v) {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0) && new Set(v).size === v.length;
}

// Role granularity (Phase 6) — researchRoles is an OPTIONAL {researchId: role} map alongside
// researchIds. Any id not present in it (including every call from before this phase existed)
// defaults to 'OWNER' — today's full-access behavior, unchanged. A value present for an id NOT
// in researchIds is simply ignored (harmless — nothing reads it), rather than a validation error,
// keeping this backward-compatible with the simplest possible caller.
function isValidResearchRoles(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([id, role]) => Number.isInteger(Number(id)) && RESEARCHER_ROLES.includes(role));
}

function roleFor(researchRoles, id) {
  return researchRoles?.[id] ?? researchRoles?.[String(id)] ?? 'OWNER';
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function isOptionalString(v, max) {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.length <= max);
}

function mapResearcher(r, researches) {
  return {
    id: r.Id,
    email: r.Email,
    firstName: r.FirstName,
    lastName: r.LastName,
    dateOfBirth: dateOnly(r.DateOfBirth),
    academicStatus: r.AcademicStatus,
    country: r.Country,
    isSuperAdmin: r.IsSuperAdmin,
    createdAt: r.CreatedAt,
    mustChangePassword: r.MustChangePassword,
    researches: researches ?? [],
  };
}

// List every researcher with their assigned researches.
router.get('/', async (req, res) => {
  try {
    const sql = getDb();
    const researchers = await sql`
      SELECT "Id", "Email", "FirstName", "LastName", "DateOfBirth", "AcademicStatus", "Country",
             "IsSuperAdmin", "CreatedAt", "MustChangePassword"
      FROM "Researcher" ORDER BY "FirstName", "LastName"
    `;
    const assignments = await sql`
      SELECT rr."ResearcherId", rr."ResearchId", rr."Role", res."Name" AS "ResearchName"
      FROM "ResearcherResearch" rr
      JOIN "Research" res ON res."Id" = rr."ResearchId"
    `;
    // 2026-09-08 — pending (not-yet-accepted) invites are merged into the same per-researcher
    // list with status: 'pending', so this list can show a badge instead of silently implying
    // access that doesn't exist yet.
    const invites = await sql`
      SELECT ti."ResearcherId", ti."ResearchId", ti."Role", res."Name" AS "ResearchName"
      FROM "ResearchTeamInvite" ti
      JOIN "Research" res ON res."Id" = ti."ResearchId"
      WHERE ti."ExpiresAt" > NOW()
    `;
    const byResearcher = new Map();
    for (const a of assignments) {
      const list = byResearcher.get(a.ResearcherId) ?? [];
      list.push({ id: a.ResearchId, name: a.ResearchName, role: a.Role, status: 'active' });
      byResearcher.set(a.ResearcherId, list);
    }
    for (const a of invites) {
      const list = byResearcher.get(a.ResearcherId) ?? [];
      list.push({ id: a.ResearchId, name: a.ResearchName, role: a.Role, status: 'pending' });
      byResearcher.set(a.ResearcherId, list);
    }

    res.json(
      researchers.map((r) =>
        mapResearcher(r, (byResearcher.get(r.Id) ?? []).sort((a, b) => a.name.localeCompare(b.name)))
      )
    );
  } catch (err) {
    console.error('[researchers] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create a brand-new researcher account + send an invite email. isSuperAdmin=true implies
// researchIds is ignored (a superadmin sees everything regardless of join rows — mirrors the old
// CHECK constraint's intent at the application layer instead of the DB layer now).
router.post('/', async (req, res) => {
  const { firstName, lastName, email, dateOfBirth, academicStatus, country, isSuperAdmin, researchIds, researchRoles, lang } =
    req.body ?? {};

  if (!isNonEmptyString(firstName, MAX_NAME_LENGTH) || !isNonEmptyString(lastName, MAX_NAME_LENGTH)) {
    res.status(400).json({ error: `firstName and lastName are required (up to ${MAX_NAME_LENGTH} characters)` });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== '' && isNaN(Date.parse(dateOfBirth))) {
    res.status(400).json({ error: 'dateOfBirth must be a valid date, or omitted' });
    return;
  }
  if (academicStatus !== undefined && academicStatus !== null && academicStatus !== '' && !ACADEMIC_STATUSES.includes(academicStatus)) {
    res.status(400).json({ error: `academicStatus must be one of: ${ACADEMIC_STATUSES.join(', ')}, or omitted` });
    return;
  }
  if (!isOptionalString(country, MAX_COUNTRY_LENGTH)) {
    res.status(400).json({ error: `country must be a string up to ${MAX_COUNTRY_LENGTH} characters, or omitted` });
    return;
  }
  if (typeof isSuperAdmin !== 'boolean') {
    res.status(400).json({ error: 'isSuperAdmin must be a boolean' });
    return;
  }
  if (!isValidResearchIds(researchIds ?? [])) {
    res.status(400).json({ error: 'researchIds must be an array of distinct positive integers' });
    return;
  }
  if (!isValidResearchRoles(researchRoles)) {
    res.status(400).json({ error: `researchRoles, if provided, must map research ids to one of: ${RESEARCHER_ROLES.join(', ')}` });
    return;
  }
  if (!isSuperAdmin && (researchIds ?? []).length === 0) {
    res.status(400).json({ error: 'A non-superadmin researcher needs at least one assigned research' });
    return;
  }

  try {
    const sql = getDb();
    const effectiveResearchIds = isSuperAdmin ? [] : researchIds;
    const trimmedEmail = email.trim();

    // Never surfaced anywhere — the account is only ever accessed via the invite flow below,
    // which sets a real password before MustChangePassword clears. Username mirrors the email
    // purely to satisfy the still-NOT-NULL legacy column; nothing reads it going forward.
    const randomPassword = crypto.randomBytes(24).toString('base64url');
    const passwordHash = bcrypt.hashSync(randomPassword, 10);

    const rows = await sql`
      INSERT INTO "Researcher"
        ("Username", "Email", "FirstName", "LastName", "DateOfBirth", "AcademicStatus", "Country",
         "PasswordHash", "IsSuperAdmin", "MustChangePassword")
      VALUES
        (${trimmedEmail}, ${trimmedEmail}, ${firstName.trim()}, ${lastName.trim()},
         ${dateOfBirth || null}, ${academicStatus || null}, ${country?.trim() || null},
         ${passwordHash}, ${isSuperAdmin}, TRUE)
      RETURNING "Id", "Email", "FirstName", "LastName", "DateOfBirth", "AcademicStatus", "Country",
                "IsSuperAdmin", "CreatedAt", "MustChangePassword"
    `;
    const r = rows[0];

    for (const rid of effectiveResearchIds) {
      await sql`
        INSERT INTO "ResearcherResearch" ("ResearcherId", "ResearchId", "Role")
        VALUES (${r.Id}, ${rid}, ${roleFor(researchRoles, rid)})
        ON CONFLICT ("ResearcherId", "ResearchId") DO NOTHING
      `;
    }

    // Issue the invite token + send the email. Best-effort is NOT appropriate here (unlike e.g.
    // calendar sync) — if the email genuinely fails to send, the researcher has no way to ever
    // access an account with a random password they were never shown, so a send failure is
    // surfaced to the superadmin as an error rather than silently swallowed.
    const inviteToken = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await sql`
      INSERT INTO "ResearcherInviteToken" ("ResearcherId", "Token", "ExpiresAt")
      VALUES (${r.Id}, ${inviteToken}, ${expiresAt})
    `;

    const appUrl = process.env.ADMIN_DASHBOARD_APP_URL || '';
    const acceptUrl = `${appUrl}/accept-invite/${inviteToken}`;
    const emailLang = lang === 'en' ? 'en' : 'sr';
    const { subject, html } = buildResearcherInviteEmail(emailLang, { acceptUrl });
    try {
      await sendMail({ to: trimmedEmail, subject, html });
    } catch (mailErr) {
      console.error('[researchers] invite email send failed:', mailErr);
      res.status(201).json({
        ...mapResearcher(r, []),
        inviteEmailSent: false,
      });
      return;
    }

    res.status(201).json({ ...mapResearcher(r, []), inviteEmailSent: true });
  } catch (err) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }
    console.error('[researchers] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Edit an existing researcher — role/research assignments, and (uncommonly) profile-field
// corrections a superadmin needs to make on someone else's behalf. Password is only changed if a
// non-empty newPassword is supplied (sets MustChangePassword back to FALSE too, since a superadmin
// setting a real password is itself a completed "account is now usable" event) — omitting it
// leaves the existing hash untouched, so editing assignments doesn't force a password reset. This
// is also the route "add an existing researcher to a research" uses — the frontend just resends
// this researcher's existing profile fields plus an expanded researchIds set, no new invite.
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid researcher id' });
    return;
  }

  const { firstName, lastName, email, dateOfBirth, academicStatus, country, newPassword, isSuperAdmin, researchIds, researchRoles } =
    req.body ?? {};
  if (!isNonEmptyString(firstName, MAX_NAME_LENGTH) || !isNonEmptyString(lastName, MAX_NAME_LENGTH)) {
    res.status(400).json({ error: `firstName and lastName are required (up to ${MAX_NAME_LENGTH} characters)` });
    return;
  }
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }
  if (dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== '' && isNaN(Date.parse(dateOfBirth))) {
    res.status(400).json({ error: 'dateOfBirth must be a valid date, or omitted' });
    return;
  }
  if (academicStatus !== undefined && academicStatus !== null && academicStatus !== '' && !ACADEMIC_STATUSES.includes(academicStatus)) {
    res.status(400).json({ error: `academicStatus must be one of: ${ACADEMIC_STATUSES.join(', ')}, or omitted` });
    return;
  }
  if (!isOptionalString(country, MAX_COUNTRY_LENGTH)) {
    res.status(400).json({ error: `country must be a string up to ${MAX_COUNTRY_LENGTH} characters, or omitted` });
    return;
  }
  if (newPassword !== undefined && newPassword !== null && newPassword !== '' &&
      (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH)) {
    res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters, or omitted` });
    return;
  }
  if (typeof isSuperAdmin !== 'boolean') {
    res.status(400).json({ error: 'isSuperAdmin must be a boolean' });
    return;
  }
  if (!isValidResearchIds(researchIds ?? [])) {
    res.status(400).json({ error: 'researchIds must be an array of distinct positive integers' });
    return;
  }
  if (!isValidResearchRoles(researchRoles)) {
    res.status(400).json({ error: `researchRoles, if provided, must map research ids to one of: ${RESEARCHER_ROLES.join(', ')}` });
    return;
  }
  if (!isSuperAdmin && (researchIds ?? []).length === 0) {
    res.status(400).json({ error: 'A non-superadmin researcher needs at least one assigned research' });
    return;
  }

  try {
    const sql = getDb();
    const effectiveResearchIds = isSuperAdmin ? [] : researchIds;
    const trimmedEmail = email.trim();

    let updatedRow;
    if (newPassword) {
      const passwordHash = bcrypt.hashSync(newPassword, 10);
      const rows = await sql`
        UPDATE "Researcher" SET
          "Email" = ${trimmedEmail}, "FirstName" = ${firstName.trim()}, "LastName" = ${lastName.trim()},
          "DateOfBirth" = ${dateOfBirth || null}, "AcademicStatus" = ${academicStatus || null}, "Country" = ${country?.trim() || null},
          "IsSuperAdmin" = ${isSuperAdmin}, "PasswordHash" = ${passwordHash}, "MustChangePassword" = FALSE
        WHERE "Id" = ${id} RETURNING "Id", "Language"
      `;
      if (!rows.length) { res.status(404).json({ error: 'Researcher not found' }); return; }
      updatedRow = rows[0];
    } else {
      const rows = await sql`
        UPDATE "Researcher" SET
          "Email" = ${trimmedEmail}, "FirstName" = ${firstName.trim()}, "LastName" = ${lastName.trim()},
          "DateOfBirth" = ${dateOfBirth || null}, "AcademicStatus" = ${academicStatus || null}, "Country" = ${country?.trim() || null},
          "IsSuperAdmin" = ${isSuperAdmin}
        WHERE "Id" = ${id} RETURNING "Id", "Language"
      `;
      if (!rows.length) { res.status(404).json({ error: 'Researcher not found' }); return; }
      updatedRow = rows[0];
    }

    // 2026-09-08 — reworked from a blind delete-then-reinsert into a real diff: a research id
    // that's already an ACCEPTED membership gets its role updated immediately (inviteOrAssign's
    // own existence check handles this); a genuinely NEW id gets a pending invite emailed
    // instead of instant access (same helper, same rule as the Team section's single-target add
    // — see server/researches/routes.mjs). Only ids actually dropped from the submitted set are
    // removed/withdrawn.
    const currentAccepted = await sql`SELECT "ResearchId" FROM "ResearcherResearch" WHERE "ResearcherId" = ${id}`;
    const currentPending = await sql`SELECT "ResearchId" FROM "ResearchTeamInvite" WHERE "ResearcherId" = ${id}`;
    const currentAcceptedIds = new Set(currentAccepted.map((r) => r.ResearchId));
    const currentPendingIds = new Set(currentPending.map((r) => r.ResearchId));
    const targetIds = new Set(effectiveResearchIds);

    let newInvites = 0;
    for (const rid of effectiveResearchIds) {
      // Research name is only actually used by inviteOrAssign for a genuinely new invite (an
      // already-accepted id just gets its role updated, no email) — a small research count per
      // researcher makes a per-id lookup here simpler and safer across both DB drivers than a
      // batch `= ANY(...)` query with no established precedent elsewhere in this codebase.
      let researchName;
      if (!currentAcceptedIds.has(rid)) {
        const nameRows = await sql`SELECT "Name" FROM "Research" WHERE "Id" = ${rid} LIMIT 1`;
        researchName = nameRows[0]?.Name;
      }
      const result = await inviteOrAssign(sql, {
        researcherId: id, researchId: rid, role: roleFor(researchRoles, rid), actorResearcherId: req.researcher?.id ?? null,
        researcherEmail: trimmedEmail, researcherLang: updatedRow.Language, researchName,
      });
      if (result.status === 'invited' && result.resent) newInvites++;
    }
    for (const rid of currentAcceptedIds) {
      if (!targetIds.has(rid)) await sql`DELETE FROM "ResearcherResearch" WHERE "ResearcherId" = ${id} AND "ResearchId" = ${rid}`;
    }
    for (const rid of currentPendingIds) {
      if (!targetIds.has(rid)) await withdrawInviteIfPending(sql, { researcherId: id, researchId: rid });
    }

    res.json({ ok: true, newInvites });
  } catch (err) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }
    console.error('[researchers] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete a researcher account. Refuses to delete the last remaining superadmin — otherwise the
// dashboard could be locked out of superadmin access entirely with no way back in short of a
// direct SQL fix.
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid researcher id' });
    return;
  }

  try {
    const sql = getDb();
    const target = await sql`SELECT "IsSuperAdmin" FROM "Researcher" WHERE "Id" = ${id} LIMIT 1`;
    if (!target.length) {
      res.status(404).json({ error: 'Researcher not found' });
      return;
    }
    if (target[0].IsSuperAdmin) {
      const superAdminCount = await sql`SELECT COUNT(*)::int AS "Count" FROM "Researcher" WHERE "IsSuperAdmin" = TRUE`;
      if (superAdminCount[0].Count <= 1) {
        res.status(400).json({ error: 'Cannot delete the last remaining superadmin' });
        return;
      }
    }
    await sql`DELETE FROM "Researcher" WHERE "Id" = ${id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researchers] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
