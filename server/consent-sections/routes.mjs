import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { DEFAULT_CONSENT_SECTIONS, DEFAULT_CHECKBOX_TEXT_SR, DEFAULT_CHECKBOX_TEXT_EN } from './defaults.mjs';

// Phase C of platform-ification: per-research configurable Consent Form. Any authenticated
// researcher can read/edit their own research's config (same requireAuth-only, scope-checked
// pattern as study-config/routes.mjs — not superadmin-gated, since this is per-research
// instrument config a scoped researcher legitimately owns).
const router = Router();
router.use(requireAuth);

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 5000;
const MAX_SECTIONS = 40;

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

function isOptionalTitle(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= MAX_TITLE_LENGTH);
}

function isValidBody(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_BODY_LENGTH;
}

async function seedDefaultsIfEmpty(sql, researchId) {
  const existing = await sql`SELECT 1 FROM "ConsentSection" WHERE "ResearchId" = ${researchId} LIMIT 1`;
  if (existing.length) return;
  for (let i = 0; i < DEFAULT_CONSENT_SECTIONS.length; i++) {
    const s = DEFAULT_CONSENT_SECTIONS[i];
    await sql`
      INSERT INTO "ConsentSection" ("ResearchId", "SortOrder", "TitleSr", "TitleEn", "BodySr", "BodyEn")
      VALUES (${researchId}, ${i}, ${s.titleSr}, ${s.titleEn}, ${s.bodySr}, ${s.bodyEn})
    `;
  }
  await sql`
    UPDATE "Research" SET
      "ConsentCheckboxTextSr" = COALESCE("ConsentCheckboxTextSr", ${DEFAULT_CHECKBOX_TEXT_SR}),
      "ConsentCheckboxTextEn" = COALESCE("ConsentCheckboxTextEn", ${DEFAULT_CHECKBOX_TEXT_EN})
    WHERE "Id" = ${researchId}
  `;
}

router.get('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();

    // Check existence BEFORE seeding — seedDefaultsIfEmpty's INSERTs carry a "ResearchId"
    // FK, so seeding against a nonexistent research would throw a raw FK-violation error
    // instead of a clean 404.
    const research = await sql`
      SELECT "ConsentCheckboxTextSr", "ConsentCheckboxTextEn" FROM "Research" WHERE "Id" = ${id} LIMIT 1
    `;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }

    await seedDefaultsIfEmpty(sql, id);

    const sections = await sql`
      SELECT "Id", "SortOrder", "TitleSr", "TitleEn", "BodySr", "BodyEn"
      FROM "ConsentSection" WHERE "ResearchId" = ${id} ORDER BY "SortOrder"
    `;

    res.json({
      sections: sections.map((s) => ({
        id: s.Id, titleSr: s.TitleSr, titleEn: s.TitleEn, bodySr: s.BodySr, bodyEn: s.BodyEn,
      })),
      checkboxTextSr: research[0].ConsentCheckboxTextSr ?? DEFAULT_CHECKBOX_TEXT_SR,
      checkboxTextEn: research[0].ConsentCheckboxTextEn ?? DEFAULT_CHECKBOX_TEXT_EN,
    });
  } catch (err) {
    console.error('[consent-sections] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Replaces the entire section set + checkbox text in one call — same delete-then-reinsert
// pattern as ResearcherResearch's PUT (Phase B), simpler and just as correct as an incremental
// diff at this scale, and makes reordering trivial (the client just resubmits its whole
// reordered array; SortOrder = array index).
router.put('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { sections, checkboxTextSr, checkboxTextEn } = req.body ?? {};
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > MAX_SECTIONS) {
    res.status(400).json({ error: `sections must be a non-empty array (up to ${MAX_SECTIONS} entries)` });
    return;
  }
  for (const s of sections) {
    if (!isOptionalTitle(s?.titleSr) || !isOptionalTitle(s?.titleEn) || !isValidBody(s?.bodySr) || !isValidBody(s?.bodyEn)) {
      res.status(400).json({ error: 'Each section needs a non-empty bodySr/bodyEn (within length limits); titleSr/titleEn are optional' });
      return;
    }
  }
  if (!isValidBody(checkboxTextSr) || !isValidBody(checkboxTextEn)) {
    res.status(400).json({ error: 'checkboxTextSr and checkboxTextEn are both required' });
    return;
  }

  try {
    const sql = getDb();
    await sql`DELETE FROM "ConsentSection" WHERE "ResearchId" = ${id}`;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      await sql`
        INSERT INTO "ConsentSection" ("ResearchId", "SortOrder", "TitleSr", "TitleEn", "BodySr", "BodyEn")
        VALUES (${id}, ${i}, ${s.titleSr || null}, ${s.titleEn || null}, ${s.bodySr.trim()}, ${s.bodyEn.trim()})
      `;
    }
    const rows = await sql`
      UPDATE "Research" SET "ConsentCheckboxTextSr" = ${checkboxTextSr.trim()}, "ConsentCheckboxTextEn" = ${checkboxTextEn.trim()}
      WHERE "Id" = ${id} RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[consent-sections] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
