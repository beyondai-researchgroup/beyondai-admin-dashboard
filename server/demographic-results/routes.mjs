import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { toCsv } from '../results/csv.mjs';

// Demographic Questionnaire results (2026-10-01) — own router, mounted at its own base path,
// never folded into results/routes.mjs: this project has twice hit the "a route registered after
// a path-segment-colliding parameterized route silently steals its matches" bug class
// (experimental-sessions, task-config), and results-export/routes.mjs's own header comment
// documents the same reasoning for staying fully separate.
const router = Router();
router.use(requireAuth);

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

async function loadQuestions(sql, researchId) {
  const questions = await sql`
    SELECT "Id","SortOrder","QuestionType","PromptSr","PromptEn" FROM "DemographicQuestion"
    WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder"
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
  return questions.map((q) => ({
    id: q.Id, type: q.QuestionType, promptSr: q.PromptSr, promptEn: q.PromptEn,
    options: optionsByQuestion.get(q.Id) ?? [],
  }));
}

async function loadResponses(sql, researchId) {
  return sql`
    SELECT p."ParticipantId", r."Language", r."Answers", r."CompletedAt"
    FROM "DemographicResponse" r
    JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
    WHERE p."ResearchId" = ${researchId}
    ORDER BY r."CompletedAt" DESC
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
    const questions = await loadQuestions(sql, id);
    const rows = await loadResponses(sql, id);

    if (req.query.mode === 'aggregate') {
      // Frequency breakdown computed in JS from the fetched Answers JSONB rows — not dynamic
      // per-question SQL, deliberately avoiding a dynamic-column-list SQL-injection surface for
      // admin-authored question/option content (same computation-shape idea the old, now fully
      // removed, Custom Instrument Builder used for its own results?mode=aggregate).
      const aggregate = questions.map((q) => {
        if (q.type === 'TEXT') {
          return {
            questionId: q.id, type: q.type, promptSr: q.promptSr, promptEn: q.promptEn,
            textAnswers: rows.map((r) => r.Answers?.[String(q.id)]?.value).filter(Boolean),
          };
        }
        const counts = new Map();
        for (const o of q.options) counts.set(o.id, 0);
        const otherTexts = [];
        for (const r of rows) {
          const a = r.Answers?.[String(q.id)];
          if (!a) continue;
          const optionId = Number(a.value);
          if (counts.has(optionId)) counts.set(optionId, counts.get(optionId) + 1);
          const opt = q.options.find((o) => o.id === optionId);
          if (opt?.isOtherSpecify && a.otherText) otherTexts.push(a.otherText);
        }
        return {
          questionId: q.id, type: q.type, promptSr: q.promptSr, promptEn: q.promptEn,
          optionCounts: q.options.map((o) => ({ optionId: o.id, labelSr: o.labelSr, labelEn: o.labelEn, count: counts.get(o.id) ?? 0 })),
          otherTexts,
        };
      });
      res.json({ totalResponses: rows.length, questions: aggregate });
      return;
    }

    res.json({
      questions,
      responses: rows.map((r) => ({
        participantId: r.ParticipantId, language: r.Language, answers: r.Answers, completedAt: r.CompletedAt,
      })),
    });
  } catch (err) {
    console.error('[demographic-results] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/export', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const questions = await loadQuestions(sql, id);
    const rows = await loadResponses(sql, id);

    // Flatten: one CSV column per question (Serbian prompt as header), plus ParticipantId/
    // Language/CompletedAt. A SINGLE_CHOICE cell renders the chosen option's Serbian label (plus
    // " - <otherText>" when Other-specify was chosen); a TEXT cell is the raw free-text answer.
    const csvRows = rows.map((r) => {
      const out = { ParticipantId: r.ParticipantId, Language: r.Language, CompletedAt: r.CompletedAt };
      for (const q of questions) {
        const a = r.Answers?.[String(q.id)];
        if (!a) { out[q.promptSr] = ''; continue; }
        if (q.type === 'TEXT') { out[q.promptSr] = a.value ?? ''; continue; }
        const opt = q.options.find((o) => String(o.id) === String(a.value));
        out[q.promptSr] = opt ? (opt.isOtherSpecify && a.otherText ? `${opt.labelSr} - ${a.otherText}` : opt.labelSr) : '';
      }
      return out;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="demographic-results.csv"');
    res.send(toCsv(csvRows));
  } catch (err) {
    console.error('[demographic-results] export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
