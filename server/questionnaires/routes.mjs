import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';

// Researcher-authored questionnaires (research-protocol feature, 2026-10). Each questionnaire belongs
// to one research and is made of items (Likert / single choice / multiple choice / text / number).
//
// Answers are stored keyed by QuestionnaireItem.ItemKey (a stable uuid), and a choice option carries
// its own stable `key` inside Options — so editing a questionnaire never detaches already-given
// answers (the bug the demographic-questions PUT had until 2026-10-13). Once any participant has
// answered, the structure is locked (no removing/retyping items, no removing choice options, no
// changing the number of scale points); wording can still be corrected.
const router = Router();
router.use(requireAuth);

const MAX_TITLE = 200;
const MAX_PROMPT = 500;
const MAX_LABEL = 200;
const MAX_SUBSCALE = 100;
const MAX_ITEMS = 100;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;
const ITEM_TYPES = ['LIKERT', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT', 'NUMBER'];
const CHOICE_TYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE'];
const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function writeGuard(req, res, researchId) {
  if (hasMinRole(req.researcher, researchId, WRITE_ROLES)) return true;
  res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
  return false;
}

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isOptionalText = (v, max) => v == null || v === '' || (typeof v === 'string' && v.length <= max);

/** Validates one incoming item and returns a normalized copy, or an error string. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid item' };
  if (!ITEM_TYPES.includes(raw.itemType)) return { error: 'Each item needs a valid itemType' };
  if (!isText(raw.promptSr, MAX_PROMPT) || !isText(raw.promptEn, MAX_PROMPT)) {
    return { error: `Each item needs non-empty promptSr/promptEn (up to ${MAX_PROMPT} characters)` };
  }
  if (raw.itemKey != null && !(typeof raw.itemKey === 'string' && UUID_RE.test(raw.itemKey))) {
    return { error: 'Invalid itemKey' };
  }
  if (!isOptionalText(raw.subscale, MAX_SUBSCALE)) return { error: `subscale is up to ${MAX_SUBSCALE} characters` };

  const item = {
    itemKey: raw.itemKey ? raw.itemKey.toLowerCase() : null,
    itemType: raw.itemType,
    promptSr: raw.promptSr.trim(),
    promptEn: raw.promptEn.trim(),
    options: [],
    scalePoints: null,
    scaleLabels: null,
    subscale: raw.subscale && raw.subscale.trim() ? raw.subscale.trim() : null,
    reverseScored: false,
    required: raw.required !== false,
  };

  if (raw.itemType === 'LIKERT') {
    const points = raw.scalePoints == null ? 5 : Number(raw.scalePoints);
    if (!Number.isInteger(points) || points < 2 || points > 10) return { error: 'scalePoints must be an integer from 2 to 10' };
    item.scalePoints = points;
    item.reverseScored = raw.reverseScored === true;
    const l = raw.scaleLabels;
    if (l != null) {
      if (typeof l !== 'object') return { error: 'scaleLabels must be an object' };
      const out = {};
      for (const k of ['minSr', 'minEn', 'maxSr', 'maxEn']) {
        if (l[k] == null || l[k] === '') continue;
        if (!isText(l[k], 100)) return { error: 'scale labels are up to 100 characters' };
        out[k] = l[k].trim();
      }
      item.scaleLabels = Object.keys(out).length ? out : null;
    }
  }

  if (CHOICE_TYPES.includes(raw.itemType)) {
    if (!Array.isArray(raw.options) || raw.options.length < MIN_OPTIONS || raw.options.length > MAX_OPTIONS) {
      return { error: `A choice item needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options` };
    }
    const seen = new Set();
    for (const o of raw.options) {
      if (!o || !isText(o.labelSr, MAX_LABEL) || !isText(o.labelEn, MAX_LABEL)) {
        return { error: `Each option needs non-empty labelSr/labelEn (up to ${MAX_LABEL} characters)` };
      }
      if (o.key != null && !(typeof o.key === 'string' && UUID_RE.test(o.key))) return { error: 'Invalid option key' };
      const key = o.key ? o.key.toLowerCase() : randomUUID();
      if (seen.has(key)) return { error: 'Duplicate option key' };
      seen.add(key);
      item.options.push({ key, labelSr: o.labelSr.trim(), labelEn: o.labelEn.trim(), isOther: o.isOther === true });
    }
  }
  return { item };
}

function validateQuestionnaireBody(body) {
  const { titleSr, titleEn, items } = body ?? {};
  if (!isText(titleSr, MAX_TITLE) || !isText(titleEn, MAX_TITLE)) {
    return { error: `titleSr/titleEn are required (up to ${MAX_TITLE} characters)` };
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return { error: `items must be a non-empty array (up to ${MAX_ITEMS} entries)` };
  }
  const normalized = [];
  for (const raw of items) {
    const r = normalizeItem(raw);
    if (r.error) return { error: r.error };
    normalized.push(r.item);
  }
  const keys = normalized.filter((i) => i.itemKey).map((i) => i.itemKey);
  if (new Set(keys).size !== keys.length) return { error: 'Duplicate itemKey in payload' };
  return { titleSr: titleSr.trim(), titleEn: titleEn.trim(), items: normalized };
}

function mapItem(r) {
  return {
    itemKey: r.ItemKey,
    itemType: r.ItemType,
    promptSr: r.PromptSr,
    promptEn: r.PromptEn,
    options: r.Options ?? [],
    scalePoints: r.ScalePoints,
    scaleLabels: r.ScaleLabels,
    subscale: r.Subscale,
    reverseScored: r.ReverseScored,
    required: r.Required,
  };
}

async function loadQuestionnaire(sql, researchId, questionnaireId) {
  const rows = await sql`
    SELECT "Id","TitleSr","TitleEn","CreatedAt" FROM "Questionnaire"
    WHERE "Id" = ${questionnaireId} AND "ResearchId" = ${researchId} LIMIT 1
  `;
  return rows[0] ?? null;
}

async function insertItem(sql, questionnaireId, it, sortOrder) {
  await sql`
    INSERT INTO "QuestionnaireItem"
      ("QuestionnaireId","ItemKey","SortOrder","ItemType","PromptSr","PromptEn","Options","ScalePoints","ScaleLabels","Subscale","ReverseScored","Required")
    VALUES (${questionnaireId}, ${it.itemKey ?? randomUUID()}, ${sortOrder}, ${it.itemType}, ${it.promptSr}, ${it.promptEn},
            ${JSON.stringify(it.options)}::jsonb, ${it.scalePoints}, ${it.scaleLabels ? JSON.stringify(it.scaleLabels) : null}::jsonb,
            ${it.subscale}, ${it.reverseScored}, ${it.required})
  `;
}

async function insertItems(sql, questionnaireId, items) {
  for (let i = 0; i < items.length; i++) await insertItem(sql, questionnaireId, items[i], i);
}

// List a research's questionnaires.
router.get('/:researchId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, researchId)) return;
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT q."Id", q."TitleSr", q."TitleEn", q."CreatedAt",
             (SELECT COUNT(*)::int FROM "QuestionnaireItem" i WHERE i."QuestionnaireId" = q."Id") AS "ItemCount",
             (SELECT COUNT(*)::int FROM "QuestionnaireResponse" r WHERE r."QuestionnaireId" = q."Id") AS "ResponseCount",
             (SELECT COUNT(*)::int FROM "ResearchProtocolStep" s WHERE (s."QuestionnaireId" = q."Id" OR s."Config" @> jsonb_build_object('questionnaireByGroup', jsonb_build_array(jsonb_build_object('questionnaireId', q."Id"))))) AS "StepCount"
      FROM "Questionnaire" q WHERE q."ResearchId" = ${researchId} ORDER BY q."CreatedAt", q."Id"
    `;
    res.json({
      questionnaires: rows.map((r) => ({
        id: r.Id, titleSr: r.TitleSr, titleEn: r.TitleEn, createdAt: r.CreatedAt,
        itemCount: r.ItemCount, responseCount: r.ResponseCount, usedInSteps: r.StepCount,
      })),
    });
  } catch (err) {
    console.error('[questionnaires] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// One questionnaire with its items.
router.get('/:researchId/:questionnaireId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  const questionnaireId = Number(req.params.questionnaireId);
  if (!Number.isInteger(researchId) || researchId <= 0 || !Number.isInteger(questionnaireId) || questionnaireId <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, researchId)) return;
  try {
    const sql = getDb();
    const q = await loadQuestionnaire(sql, researchId, questionnaireId);
    if (!q) {
      res.status(404).json({ error: 'Questionnaire not found' });
      return;
    }
    const items = await sql`
      SELECT "ItemKey","ItemType","PromptSr","PromptEn","Options","ScalePoints","ScaleLabels","Subscale","ReverseScored","Required"
      FROM "QuestionnaireItem" WHERE "QuestionnaireId" = ${questionnaireId} ORDER BY "SortOrder"
    `;
    const counts = await sql`
      SELECT (SELECT COUNT(*)::int FROM "QuestionnaireResponse" WHERE "QuestionnaireId" = ${questionnaireId}) AS "ResponseCount",
             (SELECT COUNT(*)::int FROM "ResearchProtocolStep" s WHERE s."ResearchId" = ${researchId} AND (s."QuestionnaireId" = ${questionnaireId}
               OR s."Config" @> jsonb_build_object('questionnaireByGroup', jsonb_build_array(jsonb_build_object('questionnaireId', ${questionnaireId}::int))))) AS "StepCount"
    `;
    res.json({
      id: q.Id, titleSr: q.TitleSr, titleEn: q.TitleEn, createdAt: q.CreatedAt,
      responseCount: counts[0].ResponseCount, usedInSteps: counts[0].StepCount,
      items: items.map(mapItem),
    });
  } catch (err) {
    console.error('[questionnaires] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Create.
router.post('/:researchId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, researchId) || !writeGuard(req, res, researchId)) return;
  const v = validateQuestionnaireBody(req.body);
  if (v.error) {
    res.status(400).json({ error: v.error });
    return;
  }
  try {
    const sql = getDb();
    const research = await sql`SELECT 1 FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const rows = await sql`
      INSERT INTO "Questionnaire" ("ResearchId","TitleSr","TitleEn") VALUES (${researchId}, ${v.titleSr}, ${v.titleEn}) RETURNING "Id"
    `;
    const id = rows[0].Id;
    await insertItems(sql, id, v.items);
    res.status(201).json({ id });
  } catch (err) {
    console.error('[questionnaires] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Update: items are upserted by ItemKey (kept = UPDATE in place, new = INSERT, missing = DELETE).
router.put('/:researchId/:questionnaireId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  const questionnaireId = Number(req.params.questionnaireId);
  if (!Number.isInteger(researchId) || researchId <= 0 || !Number.isInteger(questionnaireId) || questionnaireId <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, researchId) || !writeGuard(req, res, researchId)) return;
  const v = validateQuestionnaireBody(req.body);
  if (v.error) {
    res.status(400).json({ error: v.error });
    return;
  }
  try {
    const sql = getDb();
    const q = await loadQuestionnaire(sql, researchId, questionnaireId);
    if (!q) {
      res.status(404).json({ error: 'Questionnaire not found' });
      return;
    }
    const existing = await sql`
      SELECT "ItemKey","ItemType","Options","ScalePoints" FROM "QuestionnaireItem" WHERE "QuestionnaireId" = ${questionnaireId}
    `;
    const existingByKey = new Map(existing.map((e) => [e.ItemKey, e]));
    const responseCount = (await sql`SELECT COUNT(*)::int AS n FROM "QuestionnaireResponse" WHERE "QuestionnaireId" = ${questionnaireId}`)[0].n;
    const locked = responseCount > 0;

    for (const it of v.items) {
      if (it.itemKey && !existingByKey.has(it.itemKey)) {
        res.status(400).json({ error: 'Unknown itemKey for this questionnaire' });
        return;
      }
    }
    if (locked) {
      const keptKeys = new Set(v.items.filter((i) => i.itemKey).map((i) => i.itemKey));
      for (const e of existing) {
        if (!keptKeys.has(e.ItemKey)) {
          res.status(409).json({ error: 'ITEM_HAS_ANSWERS', itemKey: e.ItemKey });
          return;
        }
      }
      for (const it of v.items) {
        if (!it.itemKey) continue;
        const prev = existingByKey.get(it.itemKey);
        if (prev.ItemType !== it.itemType) {
          res.status(409).json({ error: 'ITEM_HAS_ANSWERS', itemKey: it.itemKey });
          return;
        }
        if (it.itemType === 'LIKERT' && prev.ScalePoints !== it.scalePoints) {
          res.status(409).json({ error: 'SCALE_LOCKED', itemKey: it.itemKey });
          return;
        }
        if (CHOICE_TYPES.includes(it.itemType)) {
          const nextKeys = new Set(it.options.map((o) => o.key));
          for (const o of prev.Options ?? []) {
            if (!nextKeys.has(o.key)) {
              res.status(409).json({ error: 'OPTION_HAS_ANSWERS', itemKey: it.itemKey, optionKey: o.key });
              return;
            }
          }
        }
      }
    }

    await sql`UPDATE "Questionnaire" SET "TitleSr" = ${v.titleSr}, "TitleEn" = ${v.titleEn} WHERE "Id" = ${questionnaireId}`;
    const keptKeys = v.items.filter((i) => i.itemKey).map((i) => i.itemKey);
    await sql`
      DELETE FROM "QuestionnaireItem"
      WHERE "QuestionnaireId" = ${questionnaireId} AND NOT ("ItemKey" = ANY(${keptKeys}::uuid[]))
    `;
    for (let i = 0; i < v.items.length; i++) {
      const it = v.items[i];
      if (it.itemKey) {
        await sql`
          UPDATE "QuestionnaireItem"
          SET "SortOrder" = ${i}, "ItemType" = ${it.itemType}, "PromptSr" = ${it.promptSr}, "PromptEn" = ${it.promptEn},
              "Options" = ${JSON.stringify(it.options)}::jsonb, "ScalePoints" = ${it.scalePoints},
              "ScaleLabels" = ${it.scaleLabels ? JSON.stringify(it.scaleLabels) : null}::jsonb,
              "Subscale" = ${it.subscale}, "ReverseScored" = ${it.reverseScored}, "Required" = ${it.required}
          WHERE "ItemKey" = ${it.itemKey} AND "QuestionnaireId" = ${questionnaireId}
        `;
      } else {
        await insertItem(sql, questionnaireId, it, i);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[questionnaires] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Duplicate (new item keys) — the way to start a "new version" of a locked questionnaire.
router.post('/:researchId/:questionnaireId/duplicate', async (req, res) => {
  const researchId = Number(req.params.researchId);
  const questionnaireId = Number(req.params.questionnaireId);
  if (!Number.isInteger(researchId) || researchId <= 0 || !Number.isInteger(questionnaireId) || questionnaireId <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, researchId) || !writeGuard(req, res, researchId)) return;
  try {
    const sql = getDb();
    const q = await loadQuestionnaire(sql, researchId, questionnaireId);
    if (!q) {
      res.status(404).json({ error: 'Questionnaire not found' });
      return;
    }
    const items = await sql`
      SELECT "ItemType","PromptSr","PromptEn","Options","ScalePoints","ScaleLabels","Subscale","ReverseScored","Required"
      FROM "QuestionnaireItem" WHERE "QuestionnaireId" = ${questionnaireId} ORDER BY "SortOrder"
    `;
    const copy = await sql`
      INSERT INTO "Questionnaire" ("ResearchId","TitleSr","TitleEn")
      VALUES (${researchId}, ${(q.TitleSr + ' (kopija)').slice(0, MAX_TITLE)}, ${(q.TitleEn + ' (copy)').slice(0, MAX_TITLE)}) RETURNING "Id"
    `;
    const newId = copy[0].Id;
    await insertItems(sql, newId, items.map((r) => ({
      itemType: r.ItemType, promptSr: r.PromptSr, promptEn: r.PromptEn,
      // fresh option keys too: a copy is an independent instrument
      options: (r.Options ?? []).map((o) => ({ ...o, key: randomUUID() })),
      scalePoints: r.ScalePoints, scaleLabels: r.ScaleLabels, subscale: r.Subscale,
      reverseScored: r.ReverseScored, required: r.Required,
    })));
    res.status(201).json({ id: newId });
  } catch (err) {
    console.error('[questionnaires] duplicate error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete — only if no protocol step uses it and nobody has answered it.
router.delete('/:researchId/:questionnaireId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  const questionnaireId = Number(req.params.questionnaireId);
  if (!Number.isInteger(researchId) || researchId <= 0 || !Number.isInteger(questionnaireId) || questionnaireId <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, researchId) || !writeGuard(req, res, researchId)) return;
  try {
    const sql = getDb();
    const q = await loadQuestionnaire(sql, researchId, questionnaireId);
    if (!q) {
      res.status(404).json({ error: 'Questionnaire not found' });
      return;
    }
    const used = await sql`
      SELECT 1 FROM "ResearchProtocolStep" s
      WHERE s."ResearchId" = ${researchId} AND (s."QuestionnaireId" = ${questionnaireId}
        OR s."Config" @> jsonb_build_object('questionnaireByGroup', jsonb_build_array(jsonb_build_object('questionnaireId', ${questionnaireId}::int))))
      LIMIT 1`;
    if (used.length) {
      res.status(409).json({ error: 'QUESTIONNAIRE_IN_USE' });
      return;
    }
    const answered = await sql`SELECT 1 FROM "QuestionnaireResponse" WHERE "QuestionnaireId" = ${questionnaireId} LIMIT 1`;
    if (answered.length) {
      res.status(409).json({ error: 'QUESTIONNAIRE_HAS_ANSWERS' });
      return;
    }
    await sql`DELETE FROM "Questionnaire" WHERE "Id" = ${questionnaireId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[questionnaires] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
