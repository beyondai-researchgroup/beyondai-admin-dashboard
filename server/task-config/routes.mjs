import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';

// Task Configuration — Phase 1 (2026-08-19): a research picks a "Task Type", the thing its
// participants' materials/results center on. Phase 2 adds GoogleFormsUrl/TaskInstructions —
// kept on a SEPARATE PUT (/:researchId/details) from the TaskType one, since they save on
// different triggers (TaskType auto-saves the instant the dropdown changes; the Google
// Forms/Generic layouts save via an explicit form submit, like every other per-research
// settings form in this app). Same requireAuth-only, scope-guarded, narrow-PUT pattern as
// study-config/routes.mjs — never touches researches/routes.mjs's own fields (Name/Description/
// etc.), so pages can't clobber each other.
const router = Router();
router.use(requireAuth);

const MAX_GOOGLE_FORMS_URL_LENGTH = 2000;
const MAX_TASK_INSTRUCTIONS_LENGTH = 5000;

// Adding a 4th type later is exactly this: append here + a new small frontend component + a
// new @switch case in task-config.component.html — same low-cost extensibility pattern this
// codebase already uses for REI40_VARIANTS.
export const TASK_TYPES = ['PR_REVIEW', 'GOOGLE_FORMS', 'GENERIC'];

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

router.get('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "TaskType", "GoogleFormsUrl", "TaskInstructions" FROM "Research" WHERE "Id" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({
      taskType: rows[0].TaskType,
      taskTypes: TASK_TYPES,
      googleFormsUrl: rows[0].GoogleFormsUrl,
      taskInstructions: rows[0].TaskInstructions,
    });
  } catch (err) {
    console.error('[task-config] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { taskType } = req.body ?? {};
  if (typeof taskType !== 'string' || !TASK_TYPES.includes(taskType)) {
    res.status(400).json({ error: `taskType must be one of: ${TASK_TYPES.join(', ')}` });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "Research" SET "TaskType" = ${taskType} WHERE "Id" = ${id} RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[task-config] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function isOptionalString(v, max) {
  return v === undefined || v === null || (typeof v === 'string' && v.length <= max);
}

// Saves the Google Forms link / Generic instructions text. Both fields are accepted regardless
// of the research's current TaskType (no server-side gating on which fields "belong" to which
// type — harmless to have a GoogleFormsUrl saved while TaskType is 'GENERIC', for instance, and
// keeps this endpoint simple; the frontend only ever shows/edits the field relevant to the
// currently-selected type).
router.put('/:researchId/details', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { googleFormsUrl, taskInstructions } = req.body ?? {};
  if (!isOptionalString(googleFormsUrl, MAX_GOOGLE_FORMS_URL_LENGTH)) {
    res.status(400).json({ error: `googleFormsUrl must be a string up to ${MAX_GOOGLE_FORMS_URL_LENGTH} characters, or omitted` });
    return;
  }
  if (!isOptionalString(taskInstructions, MAX_TASK_INSTRUCTIONS_LENGTH)) {
    res.status(400).json({ error: `taskInstructions must be a string up to ${MAX_TASK_INSTRUCTIONS_LENGTH} characters, or omitted` });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "Research"
      SET "GoogleFormsUrl" = ${googleFormsUrl?.trim() || null}, "TaskInstructions" = ${taskInstructions?.trim() || null}
      WHERE "Id" = ${id}
      RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[task-config] details update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
