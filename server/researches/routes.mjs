import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth, requireSuperAdmin } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { TASK_TYPES } from '../task-config/routes.mjs';
import { RESEARCHER_ROLES, hasMinRole } from '../roles.mjs';
import { generateUniqueSlug } from './slug.mjs';
import { inviteOrAssign, withdrawInviteIfPending } from '../researchers/team-invite.mjs';

const router = Router();
router.use(requireAuth);

const MAX_NAME_LENGTH = 150;
const MAX_TEXT_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ID_LENGTH = 200; // GitHub owner/repo

function maskToken(token) {
  if (!token) return null;
  return token.length <= 4 ? '••••' : `••••${token.slice(-4)}`;
}

function isOptionalString(v, max) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= max);
}

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

// ── Researches ──────────────────────────────────────────────────────────

// List every research — superadmin only (a scoped researcher only ever needs their own,
// fetched via GET /:id).
router.get('/', requireSuperAdmin, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT r."Id", r."Name", r."Description", r."University", r."City", r."Country", r."CreatedAt",
             r."UsesEeg", r."EegDeviceType", r."Slug",
             EXISTS (
               SELECT 1 FROM "ResearchPrConfig" prc WHERE prc."ResearchId" = r."Id"
             ) AS "HasPrConfig"
      FROM "Research" r
      ORDER BY r."Name"
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id,
        name: r.Name,
        description: r.Description,
        university: r.University,
        city: r.City,
        country: r.Country,
        createdAt: r.CreatedAt,
        hasPrConfig: r.HasPrConfig,
        usesEeg: r.UsesEeg,
        eegDeviceType: r.EegDeviceType,
        slug: r.Slug,
      }))
    );
  } catch (err) {
    console.error('[researches] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create a new research — superadmin only. This is what lets the whole study be replicated
// at a new university entirely from the Admin Dashboard, no manual SQL required anymore.
// EEG is deliberately not settable here — a new research always starts EEG-disabled
// (the "UsesEeg" column's own DEFAULT FALSE), configured afterward on the Study Configuration
// page, which is the only place that writes UsesEeg/EegDeviceType now.
//
// usesTlx/tlxCalculateScores/tlxIncludeWeightings/usesPsychTests/taskType are optional
// (2026-08-20) — the creation form can set them up front instead of every research always
// starting with the DB column defaults and needing a follow-up Configuration-page edit. All
// still fall back to the same defaults the columns themselves carry when omitted, so any other
// caller of this endpoint keeps working unchanged. rei40Variant/studyDisplayName/EEG stay
// edit-only (rei40Variant has its own post-creation lock semantics on the Configuration page;
// EEG is deliberately deferred per the comment above; studyDisplayName has no meaningful value
// before a name is even chosen, and falls back to Name anyway).
router.post('/', requireSuperAdmin, async (req, res) => {
  const {
    name, description, university, city, country,
    usesTlx, tlxCalculateScores, tlxIncludeWeightings, usesPsychTests, taskType, usesConsentForm,
    tracksParticipants, consentLanguageSr, consentLanguageEn,
  } = req.body ?? {};

  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: `name is required (up to ${MAX_NAME_LENGTH} characters)` });
    return;
  }
  if (
    !isOptionalString(description, MAX_DESCRIPTION_LENGTH) ||
    !isOptionalString(university, MAX_TEXT_LENGTH) ||
    !isOptionalString(city, MAX_TEXT_LENGTH) ||
    !isOptionalString(country, MAX_TEXT_LENGTH)
  ) {
    res.status(400).json({ error: 'description/university/city/country must be strings within length limits, or omitted' });
    return;
  }
  if (usesTlx !== undefined && typeof usesTlx !== 'boolean') {
    res.status(400).json({ error: 'usesTlx must be a boolean, or omitted' });
    return;
  }
  if (tlxCalculateScores !== undefined && typeof tlxCalculateScores !== 'boolean') {
    res.status(400).json({ error: 'tlxCalculateScores must be a boolean, or omitted' });
    return;
  }
  if (tlxIncludeWeightings !== undefined && typeof tlxIncludeWeightings !== 'boolean') {
    res.status(400).json({ error: 'tlxIncludeWeightings must be a boolean, or omitted' });
    return;
  }
  if (usesPsychTests !== undefined && typeof usesPsychTests !== 'boolean') {
    res.status(400).json({ error: 'usesPsychTests must be a boolean, or omitted' });
    return;
  }
  if (taskType !== undefined && !TASK_TYPES.includes(taskType)) {
    res.status(400).json({ error: `taskType must be one of: ${TASK_TYPES.join(', ')}, or omitted` });
    return;
  }
  if (usesConsentForm !== undefined && typeof usesConsentForm !== 'boolean') {
    res.status(400).json({ error: 'usesConsentForm must be a boolean, or omitted' });
    return;
  }
  if (tracksParticipants !== undefined && typeof tracksParticipants !== 'boolean') {
    res.status(400).json({ error: 'tracksParticipants must be a boolean, or omitted' });
    return;
  }
  if (consentLanguageSr !== undefined && typeof consentLanguageSr !== 'boolean') {
    res.status(400).json({ error: 'consentLanguageSr must be a boolean, or omitted' });
    return;
  }
  if (consentLanguageEn !== undefined && typeof consentLanguageEn !== 'boolean') {
    res.status(400).json({ error: 'consentLanguageEn must be a boolean, or omitted' });
    return;
  }
  if (consentLanguageSr === false && consentLanguageEn === false) {
    res.status(400).json({ error: 'At least one of consentLanguageSr/consentLanguageEn must be true' });
    return;
  }

  // PR-review structurally requires participants — never actually settable to false for that
  // task type, regardless of what the create form sends (mirrors study-config's own PUT-time
  // enforcement of the same rule).
  const effectiveTaskType = taskType ?? 'PR_REVIEW';
  const effectiveTracksParticipants = effectiveTaskType === 'PR_REVIEW' ? true : (tracksParticipants ?? true);

  try {
    const sql = getDb();
    const slug = await generateUniqueSlug(sql, name.trim());
    const rows = await sql`
      INSERT INTO "Research" ("Name", "Description", "University", "City", "Country",
                               "UsesTlx", "TlxCalculateScores", "TlxIncludeWeightings", "UsesPsychTests", "TaskType",
                               "UsesConsentForm", "TracksParticipants", "ConsentLanguageSr", "ConsentLanguageEn", "Slug")
      VALUES (${name.trim()}, ${description ?? null}, ${university ?? null}, ${city ?? null}, ${country ?? null},
              ${usesTlx ?? true}, ${tlxCalculateScores ?? true}, ${tlxIncludeWeightings ?? true},
              ${usesPsychTests ?? true}, ${effectiveTaskType}, ${usesConsentForm ?? true},
              ${effectiveTracksParticipants}, ${consentLanguageSr ?? true}, ${consentLanguageEn ?? true}, ${slug})
      RETURNING "Id", "Name", "Description", "University", "City", "Country", "CreatedAt", "UsesEeg", "EegDeviceType", "Slug"
    `;
    const r = rows[0];
    res.status(201).json({
      id: r.Id, name: r.Name, description: r.Description, university: r.University,
      city: r.City, country: r.Country, createdAt: r.CreatedAt, hasPrConfig: false,
      usesEeg: r.UsesEeg, eegDeviceType: r.EegDeviceType, slug: r.Slug,
    });
  } catch (err) {
    console.error('[researches] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Name", "Description", "University", "City", "Country", "CreatedAt", "UsesEeg", "EegDeviceType", "Slug"
      FROM "Research" WHERE "Id" = ${id} LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({
      id: r.Id, name: r.Name, description: r.Description, university: r.University,
      city: r.City, country: r.Country, createdAt: r.CreatedAt,
      usesEeg: r.UsesEeg, eegDeviceType: r.EegDeviceType, slug: r.Slug,
    });
  } catch (err) {
    console.error('[researches] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Edit a research's descriptive fields — superadmin only. Does not touch PR configs, EEG
// config (owned solely by the Study Configuration page's own PUT now — see
// server/study-config/routes.mjs, so there's exactly one write path for those columns), or
// scoping (ResearchId assignments), which are all managed separately.
router.put('/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }

  const { name, description, university, city, country } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: `name is required (up to ${MAX_NAME_LENGTH} characters)` });
    return;
  }
  if (
    !isOptionalString(description, MAX_DESCRIPTION_LENGTH) ||
    !isOptionalString(university, MAX_TEXT_LENGTH) ||
    !isOptionalString(city, MAX_TEXT_LENGTH) ||
    !isOptionalString(country, MAX_TEXT_LENGTH)
  ) {
    res.status(400).json({ error: 'description/university/city/country must be strings within length limits, or omitted' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "Research"
      SET "Name" = ${name.trim()}, "Description" = ${description ?? null},
          "University" = ${university ?? null}, "City" = ${city ?? null}, "Country" = ${country ?? null}
      WHERE "Id" = ${id}
      RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[researches] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PR configs (one research -> unlimited equally-active tasks, each with its own label;
//    at most one may be flagged as the Intro task) ───────────────────────

const MAX_LABEL_LENGTH = 40;

router.get('/:id/pr-configs', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Label", "GitHubOwner", "GitHubRepo", "GitHubPrNumber", "GitHubToken", "IsIntro", "CreatedAt"
      FROM "ResearchPrConfig"
      WHERE "ResearchId" = ${id}
      ORDER BY "IsIntro" DESC, "CreatedAt" ASC
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id,
        label: r.Label,
        owner: r.GitHubOwner,
        repo: r.GitHubRepo,
        prNumber: r.GitHubPrNumber,
        tokenMasked: maskToken(r.GitHubToken),
        isIntro: r.IsIntro,
        createdAt: r.CreatedAt,
      }))
    );
  } catch (err) {
    console.error('[researches] pr-configs list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Adds a brand-new PR task — every task is equally "active" (a real, assignable option), there is
// no single active/inactive state anymore. Always a fresh row with its own token — there is no
// "edit token" affordance, so a PAT can never be silently pre-filled/reused from a prior config.
router.post('/:id/pr-configs', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { label, owner, repo, prNumber, token, isIntro } = req.body ?? {};
  if (
    typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH ||
    typeof owner !== 'string' || !owner.trim() || owner.length > MAX_ID_LENGTH ||
    typeof repo !== 'string' || !repo.trim() || repo.length > MAX_ID_LENGTH ||
    !Number.isInteger(prNumber) || prNumber <= 0 ||
    typeof token !== 'string' || !token.trim()
  ) {
    res.status(400).json({ error: 'label, owner, repo, a positive integer prNumber, and a non-empty token are all required' });
    return;
  }

  try {
    const sql = getDb();
    const dup = await sql`SELECT 1 FROM "ResearchPrConfig" WHERE "ResearchId" = ${id} AND "Label" = ${label.trim()} LIMIT 1`;
    if (dup.length) {
      res.status(409).json({ error: 'LABEL_TAKEN' });
      return;
    }
    if (isIntro === true) {
      await sql`UPDATE "ResearchPrConfig" SET "IsIntro" = FALSE WHERE "ResearchId" = ${id} AND "IsIntro" = TRUE`;
    }
    const rows = await sql`
      INSERT INTO "ResearchPrConfig" ("ResearchId", "Label", "GitHubOwner", "GitHubRepo", "GitHubPrNumber", "GitHubToken", "IsIntro")
      VALUES (${id}, ${label.trim()}, ${owner.trim()}, ${repo.trim()}, ${prNumber}, ${token.trim()}, ${isIntro === true})
      RETURNING "Id", "Label", "GitHubOwner", "GitHubRepo", "GitHubPrNumber", "GitHubToken", "IsIntro", "CreatedAt"
    `;
    const r = rows[0];
    res.status(201).json({
      id: r.Id, label: r.Label, owner: r.GitHubOwner, repo: r.GitHubRepo, prNumber: r.GitHubPrNumber,
      tokenMasked: maskToken(r.GitHubToken), isIntro: r.IsIntro, createdAt: r.CreatedAt,
    });
  } catch (err) {
    console.error('[researches] pr-config create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Renames a task's label and/or (re)assigns it as the Intro task. The GitHub owner/repo/PR#/token
// are never editable here — only "add a new task" ever writes those, per the no-silent-token-reuse
// rule above.
router.put('/:id/pr-configs/:configId', async (req, res) => {
  const id = Number(req.params.id);
  const configId = Number(req.params.configId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(configId) || configId <= 0) {
    res.status(400).json({ error: 'Invalid research or config id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { label, isIntro } = req.body ?? {};
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL_LENGTH)) {
    res.status(400).json({ error: 'label must be a non-empty string' });
    return;
  }
  if (isIntro !== undefined && typeof isIntro !== 'boolean') {
    res.status(400).json({ error: 'isIntro must be a boolean' });
    return;
  }

  try {
    const sql = getDb();
    const owned = await sql`SELECT 1 FROM "ResearchPrConfig" WHERE "Id" = ${configId} AND "ResearchId" = ${id} LIMIT 1`;
    if (!owned.length) {
      res.status(404).json({ error: 'PR config not found for this research' });
      return;
    }
    if (label !== undefined) {
      const dup = await sql`
        SELECT 1 FROM "ResearchPrConfig" WHERE "ResearchId" = ${id} AND "Label" = ${label.trim()} AND "Id" != ${configId} LIMIT 1
      `;
      if (dup.length) {
        res.status(409).json({ error: 'LABEL_TAKEN' });
        return;
      }
      await sql`UPDATE "ResearchPrConfig" SET "Label" = ${label.trim()} WHERE "Id" = ${configId}`;
    }
    if (isIntro === true) {
      await sql`UPDATE "ResearchPrConfig" SET "IsIntro" = FALSE WHERE "ResearchId" = ${id} AND "IsIntro" = TRUE`;
      await sql`UPDATE "ResearchPrConfig" SET "IsIntro" = TRUE WHERE "Id" = ${configId}`;
    } else if (isIntro === false) {
      await sql`UPDATE "ResearchPrConfig" SET "IsIntro" = FALSE WHERE "Id" = ${configId}`;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[researches] pr-config update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Deletes a task — refused (409) if any participant session already references it, so removing
// one never silently orphans a participant's assigned PR.
router.delete('/:id/pr-configs/:configId', async (req, res) => {
  const id = Number(req.params.id);
  const configId = Number(req.params.configId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(configId) || configId <= 0) {
    res.status(400).json({ error: 'Invalid research or config id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const owned = await sql`SELECT 1 FROM "ResearchPrConfig" WHERE "Id" = ${configId} AND "ResearchId" = ${id} LIMIT 1`;
    if (!owned.length) {
      res.status(404).json({ error: 'PR config not found for this research' });
      return;
    }
    const inUse = await sql`SELECT 1 FROM "ParticipantSession" WHERE "PrConfigId" = ${configId} LIMIT 1`;
    if (inUse.length) {
      res.status(409).json({ error: 'IN_USE' });
      return;
    }
    await sql`DELETE FROM "ResearchPrConfig" WHERE "Id" = ${configId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researches] pr-config delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Team (Part B of the platform re-architecture, 2026-09-07) ───────────
//
// Lets a non-superadmin researcher who OWNS a research add any EXISTING researcher (picked from
// server/researchers/directory.mjs's read-only list) to it — only the superadmin can create a
// brand-new account (server/researchers/routes.mjs's invite flow, untouched). Deliberately a
// separate, narrow surface from that superadmin-only router: this never touches a researcher's
// own profile fields, only their ResearcherResearch membership for ONE research at a time.

// Any member of the research can view its team (matches resolveResearchScope's own
// membership-is-read-access convention — read access here isn't role-gated, only mutation is).
router.get('/:id/team', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const active = await sql`
      SELECT rr."Role", r."Id", r."FirstName", r."LastName", r."Email"
      FROM "ResearcherResearch" rr
      JOIN "Researcher" r ON r."Id" = rr."ResearcherId"
      WHERE rr."ResearchId" = ${id}
      ORDER BY r."FirstName", r."LastName"
    `;
    // 2026-09-08 — pending (not-yet-accepted) invites are merged into the same list with
    // status: 'pending', so the Team section renders one list/one badge instead of two blocks.
    const pending = await sql`
      SELECT ti."Role", r."Id", r."FirstName", r."LastName", r."Email"
      FROM "ResearchTeamInvite" ti
      JOIN "Researcher" r ON r."Id" = ti."ResearcherId"
      WHERE ti."ResearchId" = ${id} AND ti."ExpiresAt" > NOW()
      ORDER BY r."FirstName", r."LastName"
    `;
    res.json([
      ...active.map((r) => ({ id: r.Id, firstName: r.FirstName, lastName: r.LastName, email: r.Email, role: r.Role, status: 'active' })),
      ...pending.map((r) => ({ id: r.Id, firstName: r.FirstName, lastName: r.LastName, email: r.Email, role: r.Role, status: 'pending' })),
    ]);
  } catch (err) {
    console.error('[researches] team list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Add an existing researcher to this research, or change their role if already a member —
// OWNER-only. researcherId must already exist in "Researcher" (this never creates an account).
// 2026-09-08 — adding someone NOT already a member no longer grants access directly: it mints a
// ResearchTeamInvite and emails them (inviteOrAssign, server/researchers/team-invite.mjs); they
// only actually see this research's data once they accept (POST /api/team-invite/:token/accept).
// A role change on an EXISTING member still applies immediately — no invite needed, they already
// have access.
router.put('/:id/team/:researcherId', async (req, res) => {
  const id = Number(req.params.id);
  const researcherId = Number(req.params.researcherId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(researcherId) || researcherId <= 0) {
    res.status(400).json({ error: 'Invalid research or researcher id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;
  if (!hasMinRole(req.researcher, id, ['OWNER'])) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return;
  }

  const { role } = req.body ?? {};
  if (typeof role !== 'string' || !RESEARCHER_ROLES.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${RESEARCHER_ROLES.join(', ')}` });
    return;
  }

  try {
    const sql = getDb();
    const target = await sql`SELECT "Email", "Language" FROM "Researcher" WHERE "Id" = ${researcherId} LIMIT 1`;
    if (!target.length) {
      res.status(404).json({ error: 'Researcher not found' });
      return;
    }
    const research = await sql`SELECT "Name" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const result = await inviteOrAssign(sql, {
      researcherId, researchId: id, role, actorResearcherId: req.researcher.id,
      researcherEmail: target[0].Email, researcherLang: target[0].Language, researchName: research[0].Name,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[researches] team add/update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Remove a researcher from this research — OWNER-only. Refuses if the target is that research's
// last remaining OWNER (a research with zero owners is a dead end nobody can manage from here on),
// mirroring researcher-profile/routes.mjs's own "leave last research" guard style.
router.delete('/:id/team/:researcherId', async (req, res) => {
  const id = Number(req.params.id);
  const researcherId = Number(req.params.researcherId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(researcherId) || researcherId <= 0) {
    res.status(400).json({ error: 'Invalid research or researcher id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;
  if (!hasMinRole(req.researcher, id, ['OWNER'])) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return;
  }

  try {
    const sql = getDb();
    const target = await sql`
      SELECT "Role" FROM "ResearcherResearch" WHERE "ResearchId" = ${id} AND "ResearcherId" = ${researcherId} LIMIT 1
    `;
    if (!target.length) {
      // 2026-09-08 — this same endpoint doubles as "withdraw invite" for a not-yet-accepted
      // researcher: no accepted membership exists yet, but a pending ResearchTeamInvite might.
      const withdrew = await withdrawInviteIfPending(sql, { researcherId, researchId: id });
      if (withdrew) {
        res.json({ ok: true });
      } else {
        res.status(404).json({ error: 'Not a member of this research' });
      }
      return;
    }
    if (target[0].Role === 'OWNER') {
      const ownerCount = await sql`
        SELECT COUNT(*)::int AS "Count" FROM "ResearcherResearch" WHERE "ResearchId" = ${id} AND "Role" = 'OWNER'
      `;
      if (ownerCount[0].Count <= 1) {
        res.status(400).json({ error: 'LAST_OWNER' });
        return;
      }
    }
    await sql`DELETE FROM "ResearcherResearch" WHERE "ResearchId" = ${id} AND "ResearcherId" = ${researcherId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researches] team remove error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
