import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { toCsv } from '../results/csv.mjs';
import { withCodes } from '../participants/code.mjs';

// Results of the researcher-authored questionnaires of a PROTOCOL research (2026-10). Own router at its
// own base path, like demographic-results and results-export: never folded into a router with
// parameterized siblings. Answers are keyed by the item's stable ItemKey, so editing an item's wording
// never detaches the answers already given. Aggregates are computed in JS from the stored Answers JSONB
// (items are researcher-authored and few) instead of building per-item SQL.
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

const round = (n, d = 3) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Sample standard deviation (n - 1); null below two values. */
function sd(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

/** A Likert answer as scored: a reverse-scored item counts as (points + 1 - answer). */
function scored(item, value) {
  return item.reverseScored ? item.scalePoints + 1 - value : value;
}

function mapItem(r) {
  return {
    itemKey: r.ItemKey,
    type: r.ItemType,
    promptSr: r.PromptSr,
    promptEn: r.PromptEn,
    options: Array.isArray(r.Options) ? r.Options : [],
    scalePoints: r.ScalePoints,
    subscale: r.Subscale,
    reverseScored: r.ReverseScored,
  };
}

async function loadQuestionnaire(sql, researchId, questionnaireId) {
  const qs = await sql`SELECT "Id","TitleSr","TitleEn" FROM "Questionnaire" WHERE "Id" = ${questionnaireId} AND "ResearchId" = ${researchId}`;
  if (!qs.length) return null;
  const items = await sql`
    SELECT "ItemKey","ItemType","PromptSr","PromptEn","Options","ScalePoints","Subscale","ReverseScored"
    FROM "QuestionnaireItem" WHERE "QuestionnaireId" = ${questionnaireId} ORDER BY "SortOrder"
  `;
  return { id: qs[0].Id, titleSr: qs[0].TitleSr, titleEn: qs[0].TitleEn, items: items.map(mapItem) };
}

/** Steps (in protocol order) that use this questionnaire: one questionnaire can be a repeated measure. */
async function loadSteps(sql, researchId, questionnaireId) {
  const rows = await sql`
    SELECT "Id","TitleSr","TitleEn","SortOrder" FROM "ResearchProtocolStep"
    WHERE "ResearchId" = ${researchId}
      AND ("QuestionnaireId" = ${questionnaireId}
           OR "Config" @> jsonb_build_object('questionnaireByGroup', jsonb_build_array(jsonb_build_object('questionnaireId', ${questionnaireId}::int))))
    ORDER BY "SortOrder"
  `;
  return rows.map((s) => ({ stepId: s.Id, titleSr: s.TitleSr, titleEn: s.TitleEn }));
}

async function loadResponses(sql, researchId, questionnaireId, stepId) {
  return sql`
    SELECT p."ParticipantId", g."Name" AS "GroupName", r."StepId", r."Language", r."Answers", r."SubmittedAt"
    FROM "QuestionnaireResponse" r
    JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
    LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    WHERE p."ResearchId" = ${researchId} AND r."QuestionnaireId" = ${questionnaireId}
      AND (${stepId}::int IS NULL OR r."StepId" = ${stepId}::int)
    ORDER BY r."SubmittedAt" DESC
  `;
}

/** Per-participant subscale score: mean of that participant's scored Likert answers in the subscale. */
function participantSubscaleScores(items, answers) {
  const bySubscale = new Map();
  for (const item of items) {
    if (item.type !== 'LIKERT' || !item.subscale) continue;
    const a = answers?.[item.itemKey];
    if (a == null) continue;
    const v = Number(a.value);
    if (!Number.isFinite(v)) continue;
    const list = bySubscale.get(item.subscale) ?? [];
    list.push(scored(item, v));
    bySubscale.set(item.subscale, list);
  }
  return new Map([...bySubscale].map(([name, values]) => [name, mean(values)]));
}

function subscaleNames(items) {
  return [...new Set(items.filter((i) => i.type === 'LIKERT' && i.subscale).map((i) => i.subscale))];
}

function aggregateItem(item, rows) {
  const base = { itemKey: item.itemKey, type: item.type, promptSr: item.promptSr, promptEn: item.promptEn };
  const answers = rows.map((r) => r.Answers?.[item.itemKey]).filter((a) => a != null);

  if (item.type === 'TEXT') {
    return { ...base, n: answers.length, textAnswers: answers.map((a) => a.value).filter(Boolean) };
  }
  if (item.type === 'NUMBER') {
    const values = answers.map((a) => Number(a.value)).filter(Number.isFinite);
    return {
      ...base, n: values.length, mean: round(mean(values)), sd: round(sd(values)),
      min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    };
  }
  if (item.type === 'LIKERT') {
    const values = answers.map((a) => Number(a.value)).filter(Number.isFinite);
    const distribution = Array.from({ length: item.scalePoints }, (_, i) => ({ point: i + 1, count: values.filter((v) => v === i + 1).length }));
    const scoredValues = values.map((v) => scored(item, v));
    return {
      ...base, n: values.length, scalePoints: item.scalePoints, reverseScored: item.reverseScored, subscale: item.subscale,
      distribution, rawMean: round(mean(values)), scoredMean: round(mean(scoredValues)), scoredSd: round(sd(scoredValues)),
    };
  }
  // SINGLE_CHOICE / MULTI_CHOICE: how many participants picked each option
  const counts = new Map(item.options.map((o) => [o.key, 0]));
  const otherTexts = [];
  for (const a of answers) {
    const picked = Array.isArray(a.value) ? a.value : [a.value];
    for (const k of picked) if (counts.has(k)) counts.set(k, counts.get(k) + 1);
    if (a.otherText) otherTexts.push(a.otherText);
  }
  return {
    ...base, n: answers.length,
    optionCounts: item.options.map((o) => ({ key: o.key, labelSr: o.labelSr, labelEn: o.labelEn, count: counts.get(o.key) ?? 0 })),
    otherTexts,
  };
}

function cellText(item, a) {
  if (a == null) return '';
  if (item.type === 'SINGLE_CHOICE' || item.type === 'MULTI_CHOICE') {
    const picked = Array.isArray(a.value) ? a.value : [a.value];
    const labels = picked.map((k) => item.options.find((o) => o.key === k)?.labelSr ?? '').filter(Boolean);
    const text = labels.join('; ');
    return a.otherText ? `${text} - ${a.otherText}` : text;
  }
  return a.value ?? '';
}

function parseIds(req, res) {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return null;
  }
  if (!scopeGuard(req, res, researchId)) return null;
  let questionnaireId = null;
  if (req.params.questionnaireId !== undefined) {
    questionnaireId = Number(req.params.questionnaireId);
    if (!Number.isInteger(questionnaireId) || questionnaireId <= 0) {
      res.status(400).json({ error: 'Invalid questionnaire id' });
      return null;
    }
  }
  let stepId = null;
  if (req.query.stepId !== undefined && req.query.stepId !== '') {
    stepId = Number(req.query.stepId);
    if (!Number.isInteger(stepId) || stepId <= 0) {
      res.status(400).json({ error: 'Invalid step id' });
      return null;
    }
  }
  return { researchId, questionnaireId, stepId };
}

// Questionnaires of this research that appear in its protocol (what the Results menu lists).
router.get('/:researchId', async (req, res) => {
  const ids = parseIds(req, res);
  if (!ids) return;
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT q."Id", q."TitleSr", q."TitleEn",
             (SELECT COUNT(*)::int FROM "QuestionnaireResponse" r WHERE r."QuestionnaireId" = q."Id") AS "ResponseCount"
      FROM "Questionnaire" q
      WHERE q."ResearchId" = ${ids.researchId}
        AND EXISTS (SELECT 1 FROM "ResearchProtocolStep" s WHERE (s."QuestionnaireId" = q."Id" OR s."Config" @> jsonb_build_object('questionnaireByGroup', jsonb_build_array(jsonb_build_object('questionnaireId', q."Id")))))
      ORDER BY q."CreatedAt", q."Id"
    `;
    res.json({ questionnaires: rows.map((r) => ({ id: r.Id, titleSr: r.TitleSr, titleEn: r.TitleEn, responseCount: r.ResponseCount })) });
  } catch (err) {
    console.error('[questionnaire-results] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/:questionnaireId', async (req, res) => {
  const ids = parseIds(req, res);
  if (!ids) return;
  try {
    const sql = getDb();
    const questionnaire = await loadQuestionnaire(sql, ids.researchId, ids.questionnaireId);
    if (!questionnaire) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const steps = await loadSteps(sql, ids.researchId, ids.questionnaireId);
    if (ids.stepId != null && !steps.some((s) => s.stepId === ids.stepId)) {
      res.status(404).json({ error: 'STEP_NOT_FOUND' });
      return;
    }
    const rows = await loadResponses(sql, ids.researchId, ids.questionnaireId, ids.stepId);
    const names = subscaleNames(questionnaire.items);
    const stepTitle = new Map(steps.map((s) => [s.stepId, s]));

    if (req.query.mode === 'aggregate') {
      const perParticipant = rows.map((r) => participantSubscaleScores(questionnaire.items, r.Answers));
      const subscales = names.map((name) => {
        const values = perParticipant.map((m) => m.get(name)).filter((v) => v != null);
        return {
          name,
          itemCount: questionnaire.items.filter((i) => i.type === 'LIKERT' && i.subscale === name).length,
          n: values.length, mean: round(mean(values)), sd: round(sd(values)),
        };
      });
      res.json({
        questionnaire: { id: questionnaire.id, titleSr: questionnaire.titleSr, titleEn: questionnaire.titleEn },
        steps,
        totalResponses: rows.length,
        subscales,
        items: questionnaire.items.map((item) => aggregateItem(item, rows)),
      });
      return;
    }

    res.json({
      questionnaire: { id: questionnaire.id, titleSr: questionnaire.titleSr, titleEn: questionnaire.titleEn },
      steps,
      subscales: names,
      items: questionnaire.items.map((i) => ({
        itemKey: i.itemKey, type: i.type, promptSr: i.promptSr, promptEn: i.promptEn,
        options: i.options.map((o) => ({ key: o.key, labelSr: o.labelSr, labelEn: o.labelEn, isOther: !!o.isOther })),
        scalePoints: i.scalePoints, subscale: i.subscale, reverseScored: i.reverseScored,
      })),
      responses: rows.map((r) => ({
        participantId: r.ParticipantId,
        groupName: r.GroupName ?? null,
        stepId: r.StepId,
        stepTitleSr: stepTitle.get(r.StepId)?.titleSr ?? null,
        stepTitleEn: stepTitle.get(r.StepId)?.titleEn ?? null,
        language: r.Language,
        answers: r.Answers,
        submittedAt: r.SubmittedAt,
        subscaleScores: Object.fromEntries([...participantSubscaleScores(questionnaire.items, r.Answers)].map(([k, v]) => [k, round(v)])),
      })),
    });
  } catch (err) {
    console.error('[questionnaire-results] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/:questionnaireId/export', async (req, res) => {
  const ids = parseIds(req, res);
  if (!ids) return;
  try {
    const sql = getDb();
    const questionnaire = await loadQuestionnaire(sql, ids.researchId, ids.questionnaireId);
    if (!questionnaire) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const steps = await loadSteps(sql, ids.researchId, ids.questionnaireId);
    const stepTitle = new Map(steps.map((s) => [s.stepId, s.titleSr]));
    const rows = await loadResponses(sql, ids.researchId, ids.questionnaireId, ids.stepId);
    const names = subscaleNames(questionnaire.items);
    const hasGroups = (await sql`SELECT 1 FROM "ResearchGroup" WHERE "ResearchId" = ${ids.researchId} LIMIT 1`).length > 0;

    // One column per item. The header is the Serbian wording plus the first 8 characters of the stable
    // ItemKey, so two items with the same wording never collapse into one column and a re-edited
    // wording can still be traced to the same item. A Likert cell is the raw answer; the reverse-scored
    // result lives in the subscale columns.
    const headerOf = (item) => `${item.promptSr} [${item.itemKey.slice(0, 8)}]`;
    const csvRows = rows.map((r) => {
      const out = { ParticipantId: r.ParticipantId };
      // The Group column only exists for a research that defines groups, so every other export keeps its old shape.
      if (hasGroups) out.Group = r.GroupName ?? '';
      Object.assign(out, { Step: stepTitle.get(r.StepId) ?? '', Language: r.Language, SubmittedAt: r.SubmittedAt });
      for (const item of questionnaire.items) out[headerOf(item)] = cellText(item, r.Answers?.[item.itemKey]);
      const sub = participantSubscaleScores(questionnaire.items, r.Answers);
      for (const name of names) out[`Subscale: ${name}`] = round(sub.get(name)) ?? '';
      return out;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="questionnaire-${ids.questionnaireId}-results.csv"`);
    res.send(toCsv(await withCodes(sql, ids.researchId, csvRows)));
  } catch (err) {
    console.error('[questionnaire-results] export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
