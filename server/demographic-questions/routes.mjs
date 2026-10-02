import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { DEFAULT_DEMOGRAPHIC_QUESTIONS } from './defaults.mjs';

// Demographic Questionnaire (2026-10-01): per-research configurable question set, same
// requireAuth-only, scope-checked pattern as consent-sections/routes.mjs (not superadmin-gated —
// per-research instrument config a scoped researcher legitimately owns).
const router = Router();
router.use(requireAuth);

const MAX_PROMPT_LENGTH = 300;
const MAX_LABEL_LENGTH = 200;
const MAX_QUESTIONS = 40;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;
const QUESTION_TYPES = ['TEXT', 'SINGLE_CHOICE'];

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

function isValidPrompt(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_PROMPT_LENGTH;
}

function isValidLabel(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_LABEL_LENGTH;
}

async function seedDefaultsIfEmpty(sql, researchId) {
  const existing = await sql`SELECT 1 FROM "DemographicQuestion" WHERE "ResearchId" = ${researchId} LIMIT 1`;
  if (existing.length) return;
  for (let i = 0; i < DEFAULT_DEMOGRAPHIC_QUESTIONS.length; i++) {
    const q = DEFAULT_DEMOGRAPHIC_QUESTIONS[i];
    const rows = await sql`
      INSERT INTO "DemographicQuestion" ("ResearchId","SortOrder","QuestionType","PromptSr","PromptEn")
      VALUES (${researchId}, ${i}, ${q.type}, ${q.promptSr}, ${q.promptEn}) RETURNING "Id"
    `;
    const questionId = rows[0].Id;
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j];
      await sql`
        INSERT INTO "DemographicQuestionOption" ("QuestionId","SortOrder","LabelSr","LabelEn","IsOtherSpecify")
        VALUES (${questionId}, ${j}, ${o.labelSr}, ${o.labelEn}, ${o.isOtherSpecify})
      `;
    }
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

    // Existence check BEFORE seeding — same bug-fix precedent as consent-sections (seeding
    // against a nonexistent research would otherwise throw a raw FK-violation 500).
    const research = await sql`SELECT 1 FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }

    await seedDefaultsIfEmpty(sql, id);

    const questions = await sql`
      SELECT "Id","SortOrder","QuestionType","PromptSr","PromptEn" FROM "DemographicQuestion"
      WHERE "ResearchId" = ${id} ORDER BY "SortOrder"
    `;
    const qIds = questions.map((q) => q.Id);
    const options = qIds.length
      ? await sql`SELECT "Id","QuestionId","SortOrder","LabelSr","LabelEn","IsOtherSpecify" FROM "DemographicQuestionOption" WHERE "QuestionId" = ANY(${qIds}) ORDER BY "SortOrder"`
      : [];
    const optionsByQuestion = new Map();
    for (const o of options) {
      const list = optionsByQuestion.get(o.QuestionId) ?? [];
      list.push({ id: o.Id, labelSr: o.LabelSr, labelEn: o.LabelEn, isOtherSpecify: o.IsOtherSpecify });
      optionsByQuestion.set(o.QuestionId, list);
    }

    res.json({
      questions: questions.map((q) => ({
        id: q.Id, type: q.QuestionType, promptSr: q.PromptSr, promptEn: q.PromptEn,
        options: optionsByQuestion.get(q.Id) ?? [],
      })),
    });
  } catch (err) {
    console.error('[demographic-questions] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Replaces the entire question set (and each SINGLE_CHOICE question's whole option list) in one
// call — same delete-then-reinsert-whole-array pattern as consent-sections' PUT, just nested one
// level deeper. No cross-request transaction (confirmed non-transactional convention throughout
// this codebase's delete+reinsert routes).
router.put('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { questions } = req.body ?? {};
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > MAX_QUESTIONS) {
    res.status(400).json({ error: `questions must be a non-empty array (up to ${MAX_QUESTIONS} entries)` });
    return;
  }
  for (const q of questions) {
    if (!QUESTION_TYPES.includes(q?.type)) {
      res.status(400).json({ error: 'Each question needs a valid type (TEXT or SINGLE_CHOICE)' });
      return;
    }
    if (!isValidPrompt(q?.promptSr) || !isValidPrompt(q?.promptEn)) {
      res.status(400).json({ error: `Each question needs non-empty promptSr/promptEn (up to ${MAX_PROMPT_LENGTH} characters)` });
      return;
    }
    if (q.type === 'SINGLE_CHOICE') {
      if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
        res.status(400).json({ error: `A SINGLE_CHOICE question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` });
        return;
      }
      for (const o of q.options) {
        if (!isValidLabel(o?.labelSr) || !isValidLabel(o?.labelEn)) {
          res.status(400).json({ error: `Each option needs non-empty labelSr/labelEn (up to ${MAX_LABEL_LENGTH} characters)` });
          return;
        }
      }
    }
  }

  try {
    const sql = getDb();
    await sql`DELETE FROM "DemographicQuestion" WHERE "ResearchId" = ${id}`;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const rows = await sql`
        INSERT INTO "DemographicQuestion" ("ResearchId","SortOrder","QuestionType","PromptSr","PromptEn")
        VALUES (${id}, ${i}, ${q.type}, ${q.promptSr.trim()}, ${q.promptEn.trim()}) RETURNING "Id"
      `;
      const questionId = rows[0].Id;
      if (q.type === 'SINGLE_CHOICE') {
        for (let j = 0; j < q.options.length; j++) {
          const o = q.options[j];
          await sql`
            INSERT INTO "DemographicQuestionOption" ("QuestionId","SortOrder","LabelSr","LabelEn","IsOtherSpecify")
            VALUES (${questionId}, ${j}, ${o.labelSr.trim()}, ${o.labelEn.trim()}, ${!!o.isOtherSpecify})
          `;
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[demographic-questions] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
