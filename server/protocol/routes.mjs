import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { seedDefaultsIfEmpty as seedConsentDefaults } from '../consent-sections/routes.mjs';
import { seedDefaultsIfEmpty as seedDemographicDefaults } from '../demographic-questions/routes.mjs';

// Research protocol (2026-10): the researcher-defined, ordered list of steps a participant goes
// through. Only researches created with FlowMode='PROTOCOL' have one; every CLASSIC research (the
// original BeyondAI flow, incl. the study in progress) is rejected here with NOT_PROTOCOL, so this
// router can never touch it. The participant never sees the protocol — only the researcher does.
const router = Router();
router.use(requireAuth);

export const STEP_TYPES = ['CONSENT', 'DEMOGRAPHIC', 'QUESTIONNAIRE', 'REI40', 'BIGFIVE', 'NASA_TLX', 'EXTERNAL_LINK', 'MESSAGE', 'MANUAL', 'EXPERIMENT'];
// Result tables hold one row per participant for these, so a protocol can contain each only once.
// EXPERIMENT (the "experimental session") is a singleton too: a research has one main task.
const SINGLETON_TYPES = ['CONSENT', 'DEMOGRAPHIC', 'REI40', 'BIGFIVE', 'NASA_TLX', 'EXPERIMENT'];
// Kinds of task an EXPERIMENT step can wrap (stored as Config.taskKind). SHEETS and CODE_REVIEW belong to the
// platform owner's own researches, so only a superadmin may newly choose them.
export const TASK_KINDS = ['GENERIC_TASK', 'GOOGLE_FORM', 'SHEETS', 'CODE_REVIEW', 'OTHER'];
const SUPERADMIN_TASK_KINDS = ['SHEETS', 'CODE_REVIEW'];
const REVIEW_MODES = ['AI', 'REPORT', 'HYBRID'];
const DELIVERIES = ['AUTO', 'AFTER_DELAY', 'MANUAL'];
const MAX_STEPS = 30;
const MAX_TITLE = 200;
const MAX_MESSAGE = 2000;
const MAX_URL = 1000;
const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];

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

const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isOptionalText = (v, max) => v == null || v === '' || (typeof v === 'string' && v.length <= max);

function mapStep(r, started) {
  return {
    id: r.Id,
    stepType: r.StepType,
    titleSr: r.TitleSr,
    titleEn: r.TitleEn,
    questionnaireId: r.QuestionnaireId,
    config: r.Config ?? {},
    delivery: r.Delivery,
    delayDays: r.DelayDays,
    emailMessageSr: r.EmailMessageSr,
    emailMessageEn: r.EmailMessageEn,
    // Participants who already have a row for this step: the step is then locked against deletion,
    // retyping and reordering (their progress would otherwise point at the wrong step).
    participantsStarted: started.get(r.Id) ?? 0,
  };
}

async function loadResearch(sql, id) {
  const rows = await sql`SELECT "Id","FlowMode" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

async function loadSteps(sql, researchId) {
  const steps = await sql`
    SELECT "Id","StepType","TitleSr","TitleEn","QuestionnaireId","Config","Delivery","DelayDays","EmailMessageSr","EmailMessageEn"
    FROM "ResearchProtocolStep" WHERE "ResearchId" = ${researchId} ORDER BY "SortOrder", "Id"
  `;
  const counts = await sql`
    SELECT s."Id" AS "StepId", COUNT(pp."Id")::int AS "N"
    FROM "ResearchProtocolStep" s
    LEFT JOIN "ParticipantProtocolStep" pp ON pp."StepId" = s."Id" AND pp."Status" <> 'PENDING'
    WHERE s."ResearchId" = ${researchId} GROUP BY s."Id"
  `;
  return { steps, started: new Map(counts.map((c) => [c.StepId, c.N])) };
}

/** Validates one incoming step; returns a normalized copy or { error }. */
function normalizeStep(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Invalid step' };
  if (!STEP_TYPES.includes(raw.stepType)) return { error: 'Each step needs a valid stepType' };
  if (!isText(raw.titleSr, MAX_TITLE) || !isText(raw.titleEn, MAX_TITLE)) {
    return { error: `Each step needs titleSr/titleEn (up to ${MAX_TITLE} characters)` };
  }
  if (!isOptionalText(raw.emailMessageSr, MAX_MESSAGE) || !isOptionalText(raw.emailMessageEn, MAX_MESSAGE)) {
    return { error: `emailMessage is up to ${MAX_MESSAGE} characters` };
  }
  const t = raw.stepType;
  const step = {
    id: raw.id != null ? Number(raw.id) : null,
    stepType: t,
    titleSr: raw.titleSr.trim(),
    titleEn: raw.titleEn.trim(),
    questionnaireId: null,
    config: {},
    delivery: 'AUTO',
    delayDays: null,
    emailMessageSr: raw.emailMessageSr && raw.emailMessageSr.trim() ? raw.emailMessageSr.trim() : null,
    emailMessageEn: raw.emailMessageEn && raw.emailMessageEn.trim() ? raw.emailMessageEn.trim() : null,
  };
  if (raw.id != null && !Number.isInteger(step.id)) return { error: 'Invalid step id' };

  if (t === 'QUESTIONNAIRE') {
    const qid = Number(raw.questionnaireId);
    if (!Number.isInteger(qid) || qid <= 0) return { error: 'A questionnaire step needs a questionnaireId' };
    step.questionnaireId = qid;
    // "Open right after the table is handed in": the questionnaire opens on the hand-in page instead of arriving by e-mail.
    if (raw.config && raw.config.openImmediately === true) step.config = { openImmediately: true };
    // A different questionnaire per participant group: the step's own questionnaireId is the default, a group listed
    // here gets its own. Groups not listed (and people without a group) get the default.
    const byGroup = Array.isArray(raw.config?.questionnaireByGroup) ? raw.config.questionnaireByGroup : [];
    const seenGroups = new Set();
    const questionnaireByGroup = [];
    for (const m of byGroup) {
      const gid = Number(m?.groupId);
      const qid2 = Number(m?.questionnaireId);
      if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(qid2) || qid2 <= 0) return { error: 'Invalid questionnaireByGroup entry' };
      if (seenGroups.has(gid)) return { error: 'Duplicate group in questionnaireByGroup' };
      seenGroups.add(gid);
      // With the explicit per-group switch every group keeps its own entry; without it an entry equal to the default is redundant.
      if (raw.config?.byGroup === true || qid2 !== qid) questionnaireByGroup.push({ groupId: gid, questionnaireId: qid2 });
    }
    questionnaireByGroup.sort((a, b) => a.groupId - b.groupId);
    if (raw.config?.byGroup === true) step.config = { ...step.config, byGroup: true };
    if (questionnaireByGroup.length) step.config = { ...step.config, questionnaireByGroup };
  } else if (raw.questionnaireId != null) {
    return { error: 'Only a questionnaire step can reference a questionnaire' };
  }

  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {};
  if (t === 'EXTERNAL_LINK') {
    const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
    if (!url || url.length > MAX_URL || !/^https?:\/\/[^\s]+$/i.test(url)) return { error: 'An external link step needs a valid http(s) url' };
    step.config = { url };
  } else if (t === 'EXPERIMENT') {
    const taskKind = typeof cfg.taskKind === 'string' ? cfg.taskKind : '';
    if (!TASK_KINDS.includes(taskKind)) return { error: 'An experiment step needs a valid taskKind' };
    step.config = { taskKind };
    // "Other": a task the platform has no module for. The researcher describes it in words (the step's email text, which
    // is all the participant gets) and marks it done by hand, so the description is required in both languages.
    if (taskKind === 'OTHER' && (!step.emailMessageSr || !step.emailMessageEn)) return { error: 'An "other" task needs a description in both languages' };
    if (taskKind === 'CODE_REVIEW') {
      // Code Review AI: which review mode a participant gets (a default, optionally overridden per group) and whether
      // an Intro (practice) session comes first. The PR itself is chosen per participant, not here.
      if (!REVIEW_MODES.includes(cfg.defaultMode)) return { error: 'A code review step needs a defaultMode (AI, REPORT or HYBRID)' };
      const byGroup = Array.isArray(cfg.modeByGroup) ? cfg.modeByGroup : [];
      const seen = new Set();
      const modeByGroup = [];
      for (const m of byGroup) {
        const gid = Number(m?.groupId);
        if (!Number.isInteger(gid) || !REVIEW_MODES.includes(m?.mode)) return { error: 'Invalid modeByGroup entry' };
        if (seen.has(gid)) return { error: 'Duplicate group in modeByGroup' };
        seen.add(gid);
        modeByGroup.push({ groupId: gid, mode: m.mode });
      }
      step.config = { taskKind, defaultMode: cfg.defaultMode, modeByGroup, includeIntro: cfg.includeIntro === true };
    }
  } else if (t === 'MESSAGE' || t === 'MANUAL') {
    const bodySr = typeof cfg.bodySr === 'string' ? cfg.bodySr.trim() : '';
    const bodyEn = typeof cfg.bodyEn === 'string' ? cfg.bodyEn.trim() : '';
    if (bodySr.length > MAX_MESSAGE || bodyEn.length > MAX_MESSAGE) return { error: `body is up to ${MAX_MESSAGE} characters` };
    // A message is what the participant receives, so it is required; for a manual (in-person) step it is
    // only the researcher's own note.
    if (t === 'MESSAGE' && (!bodySr || !bodyEn)) return { error: 'A message step needs bodySr and bodyEn' };
    step.config = { bodySr, bodyEn };
  }

  // A manual step is, by definition, triggered by the researcher.
  const delivery = t === 'MANUAL' ? 'MANUAL' : (raw.delivery ?? 'AUTO');
  if (!DELIVERIES.includes(delivery)) return { error: 'Invalid delivery' };
  step.delivery = delivery;
  if (delivery === 'AFTER_DELAY') {
    const d = Number(raw.delayDays);
    if (!Number.isInteger(d) || d < 0 || d > 365) return { error: 'delayDays must be an integer from 0 to 365' };
    step.delayDays = d;
  }
  return { step };
}

router.get('/:researchId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, researchId)) return;
  try {
    const sql = getDb();
    const research = await loadResearch(sql, researchId);
    if (!research) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    if (research.FlowMode !== 'PROTOCOL') {
      res.status(400).json({ error: 'NOT_PROTOCOL' });
      return;
    }
    const { steps, started } = await loadSteps(sql, researchId);
    res.json({ flowMode: research.FlowMode, steps: steps.map((s) => mapStep(s, started)) });
  } catch (err) {
    console.error('[protocol] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Replaces the step list as an upsert by id: a step with an id of this research is UPDATEd in place,
// one without an id is INSERTed, an existing one missing from the payload is DELETEd (refused when
// participants already have progress on it).
router.put('/:researchId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, researchId)) return;
  if (!hasMinRole(req.researcher, researchId, WRITE_ROLES)) {
    res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
    return;
  }

  const { steps } = req.body ?? {};
  if (!Array.isArray(steps) || steps.length > MAX_STEPS) {
    res.status(400).json({ error: `steps must be an array (up to ${MAX_STEPS} entries)` });
    return;
  }
  const normalized = [];
  for (const raw of steps) {
    const r = normalizeStep(raw);
    if (r.error) {
      res.status(400).json({ error: r.error });
      return;
    }
    normalized.push(r.step);
  }
  for (const type of SINGLETON_TYPES) {
    if (normalized.filter((s) => s.stepType === type).length > 1) {
      res.status(400).json({ error: 'DUPLICATE_STEP_TYPE', stepType: type });
      return;
    }
  }

  try {
    const sql = getDb();
    const research = await loadResearch(sql, researchId);
    if (!research) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    if (research.FlowMode !== 'PROTOCOL') {
      res.status(400).json({ error: 'NOT_PROTOCOL' });
      return;
    }

    const { steps: existing, started } = await loadSteps(sql, researchId);
    const existingById = new Map(existing.map((e) => [e.Id, e]));
    for (const s of normalized) {
      if (s.id != null && !existingById.has(s.id)) {
        res.status(400).json({ error: 'Unknown step id for this research' });
        return;
      }
    }
    const keptIds = normalized.filter((s) => s.id != null).map((s) => s.id);
    if (new Set(keptIds).size !== keptIds.length) {
      res.status(400).json({ error: 'Duplicate step id in payload' });
      return;
    }

    // Questionnaires must belong to this research.
    const qIds = [...new Set(normalized.flatMap((s) => [
      ...(s.questionnaireId != null ? [s.questionnaireId] : []),
      ...(s.config?.questionnaireByGroup ?? []).map((m) => m.questionnaireId),
    ]))];
    if (qIds.length) {
      const own = await sql`SELECT "Id" FROM "Questionnaire" WHERE "ResearchId" = ${researchId} AND "Id" = ANY(${qIds})`;
      if (own.length !== qIds.length) {
        res.status(400).json({ error: 'Unknown questionnaire for this research' });
        return;
      }
    }

    // "Open immediately" only makes sense for a questionnaire that comes right after the Sheets task and is delivered automatically.
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i].config?.openImmediately !== true) continue;
      const prev = normalized[i - 1];
      if (!prev || prev.stepType !== 'EXPERIMENT' || prev.config?.taskKind !== 'SHEETS' || normalized[i].delivery !== 'AUTO') {
        res.status(400).json({ error: 'OPEN_IMMEDIATELY_INVALID' });
        return;
      }
    }

    // Group ids named in a code review step must be groups of this research.
    const reviewGroupIds = [...new Set([
      ...normalized.filter((s) => s.config?.taskKind === 'CODE_REVIEW').flatMap((s) => s.config.modeByGroup.map((m) => m.groupId)),
      ...normalized.flatMap((s) => (s.config?.questionnaireByGroup ?? []).map((m) => m.groupId)),
    ])];
    if (reviewGroupIds.length) {
      const own = await sql`SELECT "Id" FROM "ResearchGroup" WHERE "ResearchId" = ${researchId} AND "Id" = ANY(${reviewGroupIds})`;
      if (own.length !== reviewGroupIds.length) {
        res.status(400).json({ error: 'Unknown group in modeByGroup or questionnaireByGroup' });
        return;
      }
    }

    // A restricted task kind may only be newly chosen (or changed to) by a superadmin; a step that already has
    // that kind can be re-saved by anyone with write access, so an owner can still edit the rest of the protocol.
    for (const s of normalized) {
      if (s.stepType !== 'EXPERIMENT' || !SUPERADMIN_TASK_KINDS.includes(s.config.taskKind)) continue;
      const prevKind = s.id != null ? existingById.get(s.id)?.Config?.taskKind : null;
      if (prevKind !== s.config.taskKind && !req.researcher.isSuperAdmin) {
        res.status(403).json({ error: 'SUPERADMIN_ONLY_TASK_KIND' });
        return;
      }
    }

    // Locking: a step that participants already have progress on can't be removed or retyped, and the
    // order up to and including the last such step is frozen (you can only append / edit after it).
    const isStarted = (id) => (started.get(id) ?? 0) > 0;
    for (const e of existing) {
      if (isStarted(e.Id) && !keptIds.includes(e.Id)) {
        res.status(409).json({ error: 'PROTOCOL_LOCKED', reason: 'STEP_HAS_PROGRESS', stepId: e.Id });
        return;
      }
    }
    for (const s of normalized) {
      if (s.id == null) continue;
      const prev = existingById.get(s.id);
      // Once a participant started, the experiment's kind — and for Code Review its modes and intro setting, which
      // decide which sessions were created for people — can no longer change.
      const kindChanged = s.stepType === 'EXPERIMENT' && prev.StepType === 'EXPERIMENT'
        && (prev.Config?.taskKind !== s.config.taskKind
          || (s.config.taskKind === 'CODE_REVIEW' && JSON.stringify(prev.Config) !== JSON.stringify(s.config)));
      // Same for a questionnaire step: once anyone received it, its default and per-group questionnaires are fixed
      // (a link already sent resolves to the participant's questionnaire when opened, so it must not change underneath them).
      const questionnaireChoiceChanged = s.stepType === 'QUESTIONNAIRE' && prev.StepType === 'QUESTIONNAIRE'
        && JSON.stringify(prev.Config?.questionnaireByGroup ?? []) !== JSON.stringify(s.config?.questionnaireByGroup ?? []);
      if (isStarted(s.id) && (prev.StepType !== s.stepType || prev.QuestionnaireId !== s.questionnaireId || kindChanged || questionnaireChoiceChanged)) {
        res.status(409).json({ error: 'PROTOCOL_LOCKED', reason: 'STEP_HAS_PROGRESS', stepId: s.id });
        return;
      }
    }
    const lastStartedIdx = existing.map((e) => isStarted(e.Id)).lastIndexOf(true);
    if (lastStartedIdx >= 0) {
      const frozen = existing.slice(0, lastStartedIdx + 1).map((e) => e.Id);
      const nextHead = normalized.slice(0, frozen.length).map((s) => s.id);
      if (frozen.length !== nextHead.length || frozen.some((id, i) => id !== nextHead[i])) {
        res.status(409).json({ error: 'PROTOCOL_LOCKED', reason: 'ORDER_FROZEN' });
        return;
      }
    }

    for (const e of existing) {
      if (!keptIds.includes(e.Id)) await sql`DELETE FROM "ResearchProtocolStep" WHERE "Id" = ${e.Id}`;
    }
    for (let i = 0; i < normalized.length; i++) {
      const s = normalized[i];
      const cfg = JSON.stringify(s.config);
      if (s.id != null) {
        await sql`
          UPDATE "ResearchProtocolStep"
          SET "SortOrder" = ${i}, "StepType" = ${s.stepType}, "TitleSr" = ${s.titleSr}, "TitleEn" = ${s.titleEn},
              "QuestionnaireId" = ${s.questionnaireId}, "Config" = ${cfg}::jsonb, "Delivery" = ${s.delivery},
              "DelayDays" = ${s.delayDays}, "EmailMessageSr" = ${s.emailMessageSr}, "EmailMessageEn" = ${s.emailMessageEn}
          WHERE "Id" = ${s.id} AND "ResearchId" = ${researchId}
        `;
      } else {
        await sql`
          INSERT INTO "ResearchProtocolStep"
            ("ResearchId","SortOrder","StepType","TitleSr","TitleEn","QuestionnaireId","Config","Delivery","DelayDays","EmailMessageSr","EmailMessageEn")
          VALUES (${researchId}, ${i}, ${s.stepType}, ${s.titleSr}, ${s.titleEn}, ${s.questionnaireId}, ${cfg}::jsonb,
                  ${s.delivery}, ${s.delayDays}, ${s.emailMessageSr}, ${s.emailMessageEn})
        `;
      }
    }
    // A consent / demographic step shows the research's own consent sections / demographic questions
    // (edited on their own pages). Make sure they exist, so a participant never gets an empty page
    // just because the researcher never opened those pages.
    // The experiment step's task kind drives the research's legacy task settings, so the existing Task Configuration
    // page, the participant import and the sheets app see the right thing: GENERIC_TASK -> TaskType GENERIC,
    // GOOGLE_FORM -> GOOGLE_FORMS, SHEETS -> the sheets module is switched on.
    const experiment = normalized.find((s) => s.stepType === 'EXPERIMENT');
    if (experiment?.config.taskKind === 'GENERIC_TASK') await sql`UPDATE "Research" SET "TaskType" = 'GENERIC' WHERE "Id" = ${researchId}`;
    else if (experiment?.config.taskKind === 'GOOGLE_FORM') await sql`UPDATE "Research" SET "TaskType" = 'GOOGLE_FORMS' WHERE "Id" = ${researchId}`;
    else if (experiment?.config.taskKind === 'SHEETS') await sql`UPDATE "Research" SET "UsesSheets" = TRUE WHERE "Id" = ${researchId}`;
    else if (experiment?.config.taskKind === 'CODE_REVIEW') await sql`UPDATE "Research" SET "TaskType" = 'PR_REVIEW', "TracksParticipants" = TRUE WHERE "Id" = ${researchId}`;
    if (normalized.some((s) => s.stepType === 'CONSENT')) await seedConsentDefaults(sql, researchId);
    if (normalized.some((s) => s.stepType === 'DEMOGRAPHIC')) await seedDemographicDefaults(sql, researchId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[protocol] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
