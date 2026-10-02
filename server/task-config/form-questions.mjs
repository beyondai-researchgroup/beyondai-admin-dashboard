// Google Forms question metadata (Part G of the platform re-architecture, 2026-09-07) — one
// TaskFormQuestion row per question, regardless of whether it was auto-read via the Forms API or
// typed in by hand, so descriptive-stats.mjs never needs to branch on Source. Two write paths,
// both full-replace (delete-then-reinsert, SortOrder = array index — same pattern used throughout
// this codebase for reorderable lists): POST read-structure replaces everything with a fresh
// Google Forms read; PUT questions replaces everything with whatever the client sends (letting a
// researcher hand-edit a Google-sourced row, or build the whole list manually with no connection
// at all).
import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { decrypt } from '../google-forms/tokenCrypto.mjs';
import { extractFormId, readFormStructure } from '../google-forms/formsApi.mjs';

const router = Router();
router.use(requireAuth);

const QUESTION_TYPES = ['NUMBER', 'TEXT', 'LIKERT', 'CHOICE'];
const SOURCES = ['GOOGLE_FORMS', 'MANUAL'];
const MAX_COLUMN_KEY_LENGTH = 500;
const MAX_LABEL_LENGTH = 500;
const MAX_QUESTIONS = 200;

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

function mapRow(r) {
  return {
    id: r.Id, columnKey: r.ColumnKey, label: r.Label, questionType: r.QuestionType, source: r.Source,
    // 2026-09-08 follow-up — the CSV column a researcher designated as the participant-
    // identifying one, letting each survey row be matched back to an imported Participant. At
    // most one per research (DB-enforced via a partial unique index on IsParticipantIdColumn).
    isParticipantIdColumn: r.IsParticipantIdColumn,
  };
}

router.get('/:researchId/questions', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "ColumnKey", "Label", "QuestionType", "Source", "IsParticipantIdColumn" FROM "TaskFormQuestion"
      WHERE "ResearchId" = ${id} ORDER BY "SortOrder"
    `;
    res.json({ questions: rows.map(mapRow) });
  } catch (err) {
    console.error('[task-config/form-questions] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:researchId/questions', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { questions } = req.body ?? {};
  if (!Array.isArray(questions) || questions.length > MAX_QUESTIONS) {
    res.status(400).json({ error: `questions must be an array of at most ${MAX_QUESTIONS} items` });
    return;
  }
  let idColumnCount = 0;
  for (const q of questions) {
    if (
      typeof q?.columnKey !== 'string' || !q.columnKey.trim() || q.columnKey.length > MAX_COLUMN_KEY_LENGTH ||
      typeof q?.label !== 'string' || !q.label.trim() || q.label.length > MAX_LABEL_LENGTH ||
      !QUESTION_TYPES.includes(q?.questionType) ||
      !SOURCES.includes(q?.source) ||
      (q?.isParticipantIdColumn !== undefined && typeof q.isParticipantIdColumn !== 'boolean')
    ) {
      res.status(400).json({ error: 'Each question needs columnKey, label, a valid questionType, a valid source, and an optional boolean isParticipantIdColumn' });
      return;
    }
    if (q.isParticipantIdColumn) idColumnCount++;
  }
  if (idColumnCount > 1) {
    // The client (a radio-style control) should never actually produce this — this is the
    // server-side backstop, same role the partial unique index plays at the DB level.
    res.status(400).json({ error: 'At most one question can be isParticipantIdColumn' });
    return;
  }

  try {
    const sql = getDb();
    const exists = await sql`SELECT 1 FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!exists.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }

    await sql`DELETE FROM "TaskFormQuestion" WHERE "ResearchId" = ${id}`;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await sql`
        INSERT INTO "TaskFormQuestion" ("ResearchId", "ColumnKey", "Label", "QuestionType", "SortOrder", "Source", "IsParticipantIdColumn")
        VALUES (${id}, ${q.columnKey.trim()}, ${q.label.trim()}, ${q.questionType}, ${i}, ${q.source}, ${!!q.isParticipantIdColumn})
      `;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[task-config/form-questions] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Reads the research's saved GoogleFormsUrl via the Forms API, using the CALLING researcher's
// own connected Google account (not necessarily whoever set up the research) — replaces the
// whole TaskFormQuestion set with a fresh Source='GOOGLE_FORMS' read.
router.post('/:researchId/read-structure', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const researcherRows = await sql`
      SELECT "GoogleFormsRefreshTokenEnc" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const encToken = researcherRows[0]?.GoogleFormsRefreshTokenEnc;
    if (!encToken) {
      res.status(400).json({ error: 'NOT_CONNECTED' });
      return;
    }

    const researchRows = await sql`SELECT "GoogleFormsUrl" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!researchRows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const formId = extractFormId(researchRows[0].GoogleFormsUrl);
    if (!formId) {
      res.status(400).json({ error: 'NO_FORM_URL' });
      return;
    }

    let questions;
    try {
      questions = await readFormStructure(decrypt(encToken), formId);
    } catch (err) {
      console.error('[task-config/form-questions] Forms API read failed:', err?.message ?? err);
      res.status(502).json({ error: 'FORMS_API_ERROR', detail: err?.message ?? 'Unknown error' });
      return;
    }

    // Preserve the researcher's earlier participant-ID-column designation across a fresh
    // read, matched by ColumnKey — a re-read is a full replace otherwise, and silently losing
    // this flag every time "Pročitaj strukturu ankete" is clicked again would be a real trap.
    const previousIdColumn = await sql`
      SELECT "ColumnKey" FROM "TaskFormQuestion" WHERE "ResearchId" = ${id} AND "IsParticipantIdColumn" LIMIT 1
    `;
    const idColumnKey = previousIdColumn[0]?.ColumnKey ?? null;

    await sql`DELETE FROM "TaskFormQuestion" WHERE "ResearchId" = ${id}`;
    for (const q of questions) {
      await sql`
        INSERT INTO "TaskFormQuestion" ("ResearchId", "ColumnKey", "Label", "QuestionType", "SortOrder", "Source", "IsParticipantIdColumn")
        VALUES (${id}, ${q.columnKey}, ${q.label}, ${q.questionType}, ${q.sortOrder}, 'GOOGLE_FORMS', ${q.columnKey === idColumnKey})
      `;
    }

    const rows = await sql`
      SELECT "Id", "ColumnKey", "Label", "QuestionType", "Source", "IsParticipantIdColumn" FROM "TaskFormQuestion"
      WHERE "ResearchId" = ${id} ORDER BY "SortOrder"
    `;
    res.json({ questions: rows.map(mapRow) });
  } catch (err) {
    console.error('[task-config/form-questions] read-structure error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
