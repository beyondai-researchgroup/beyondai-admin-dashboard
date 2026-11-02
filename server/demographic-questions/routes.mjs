import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { DEFAULT_DEMOGRAPHIC_QUESTIONS, GENERIC_DEMOGRAPHIC_QUESTIONS } from './defaults.mjs';

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

export async function seedDefaultsIfEmpty(sql, researchId) {
  const existing = await sql`SELECT 1 FROM "DemographicQuestion" WHERE "ResearchId" = ${researchId} LIMIT 1`;
  if (existing.length) return;
  // A research built with the researcher's own protocol starts from a neutral set, not the BeyondAI study's questions.
  const mode = await sql`SELECT "FlowMode" FROM "Research" WHERE "Id" = ${researchId}`;
  const template = mode[0]?.FlowMode === 'PROTOCOL' ? GENERIC_DEMOGRAPHIC_QUESTIONS : DEFAULT_DEMOGRAPHIC_QUESTIONS;
  for (let i = 0; i < template.length; i++) {
    const q = template[i];
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

// Saves the whole question set in one call, as an UPSERT BY ID (replaces the old delete-then-reinsert).
// A stored DemographicResponse.Answers is keyed by question id and holds the chosen option id, so
// re-creating questions/options on every save (new ids) detached every already-given answer from its
// question (found 2026-10-13). Now: an incoming question/option that carries an id of this research is
// UPDATEd in place (id kept), one without an id is INSERTed, and an existing one missing from the
// payload is DELETEd — but only when no participant answered it (otherwise 409: the question text
// would be lost for those answers).
// No cross-request transaction (same non-transactional convention as consent-sections).
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

    const existingQuestions = await sql`
      SELECT "Id","QuestionType" FROM "DemographicQuestion" WHERE "ResearchId" = ${id}
    `;
    const existingById = new Map(existingQuestions.map((q) => [q.Id, q]));
    const existingIds = existingQuestions.map((q) => q.Id);
    const existingOptions = existingIds.length
      ? await sql`SELECT "Id","QuestionId" FROM "DemographicQuestionOption" WHERE "QuestionId" = ANY(${existingIds})`
      : [];

    // What participants of THIS research have actually answered: question ids, and the option ids picked.
    const responses = await sql`
      SELECT r."Answers" FROM "DemographicResponse" r
      JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
      WHERE p."ResearchId" = ${id}
    `;
    const answeredQuestions = new Set();
    const pickedOptions = new Set();
    for (const r of responses) {
      for (const [qid, a] of Object.entries(r.Answers ?? {})) {
        answeredQuestions.add(Number(qid));
        if (a?.value != null && a.value !== '') pickedOptions.add(Number(a.value));
      }
    }

    // Incoming ids must belong to this research (never adopt another research's rows).
    const withIds = questions.filter((q) => q.id != null);
    for (const q of withIds) {
      if (!existingById.has(Number(q.id))) {
        res.status(400).json({ error: 'Unknown question id for this research' });
        return;
      }
    }
    const keptQuestionIds = new Set(withIds.map((q) => Number(q.id)));
    if (keptQuestionIds.size !== withIds.length) {
      res.status(400).json({ error: 'Duplicate question id in payload' });
      return;
    }

    // Guard 1: removing a question somebody answered.
    for (const eq of existingQuestions) {
      if (!keptQuestionIds.has(eq.Id) && answeredQuestions.has(eq.Id)) {
        res.status(409).json({ error: 'QUESTION_HAS_ANSWERS', questionId: eq.Id });
        return;
      }
    }
    // Guard 2: changing the type of an answered question.
    for (const q of withIds) {
      const prev = existingById.get(Number(q.id));
      if (prev.QuestionType !== q.type && answeredQuestions.has(prev.Id)) {
        res.status(409).json({ error: 'QUESTION_HAS_ANSWERS', questionId: prev.Id });
        return;
      }
    }
    // Guard 3: removing an option that was picked.
    const incomingOptionIds = new Set();
    for (const q of questions) {
      if (q.type !== 'SINGLE_CHOICE') continue;
      for (const o of q.options) if (o.id != null) incomingOptionIds.add(Number(o.id));
    }
    for (const eo of existingOptions) {
      if (!incomingOptionIds.has(eo.Id) && pickedOptions.has(eo.Id)) {
        res.status(409).json({ error: 'OPTION_HAS_ANSWERS', optionId: eo.Id });
        return;
      }
    }
    // Incoming option ids must belong to the question they are sent under.
    const optionQuestion = new Map(existingOptions.map((o) => [o.Id, o.QuestionId]));
    for (const q of questions) {
      if (q.type !== 'SINGLE_CHOICE') continue;
      for (const o of q.options) {
        if (o.id != null && (q.id == null || optionQuestion.get(Number(o.id)) !== Number(q.id))) {
          res.status(400).json({ error: 'Unknown option id for this question' });
          return;
        }
      }
    }

    // Delete what was removed (no answers reference it, checked above).
    for (const eq of existingQuestions) {
      if (!keptQuestionIds.has(eq.Id)) await sql`DELETE FROM "DemographicQuestion" WHERE "Id" = ${eq.Id}`;
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      let questionId;
      if (q.id != null) {
        questionId = Number(q.id);
        await sql`
          UPDATE "DemographicQuestion"
          SET "SortOrder" = ${i}, "QuestionType" = ${q.type}, "PromptSr" = ${q.promptSr.trim()}, "PromptEn" = ${q.promptEn.trim()}
          WHERE "Id" = ${questionId} AND "ResearchId" = ${id}
        `;
      } else {
        const rows = await sql`
          INSERT INTO "DemographicQuestion" ("ResearchId","SortOrder","QuestionType","PromptSr","PromptEn")
          VALUES (${id}, ${i}, ${q.type}, ${q.promptSr.trim()}, ${q.promptEn.trim()}) RETURNING "Id"
        `;
        questionId = rows[0].Id;
      }

      if (q.type !== 'SINGLE_CHOICE') {
        // A TEXT question has no options; drop any left over from a previous SINGLE_CHOICE form
        // (only reachable for an unanswered question — guard 2 blocks answered type changes).
        await sql`DELETE FROM "DemographicQuestionOption" WHERE "QuestionId" = ${questionId}`;
        continue;
      }

      const keptOptionIds = q.options.filter((o) => o.id != null).map((o) => Number(o.id));
      await sql`
        DELETE FROM "DemographicQuestionOption"
        WHERE "QuestionId" = ${questionId} AND NOT ("Id" = ANY(${keptOptionIds}::int[]))
      `;
      for (let j = 0; j < q.options.length; j++) {
        const o = q.options[j];
        if (o.id != null) {
          await sql`
            UPDATE "DemographicQuestionOption"
            SET "SortOrder" = ${j}, "LabelSr" = ${o.labelSr.trim()}, "LabelEn" = ${o.labelEn.trim()}, "IsOtherSpecify" = ${!!o.isOtherSpecify}
            WHERE "Id" = ${Number(o.id)} AND "QuestionId" = ${questionId}
          `;
        } else {
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
