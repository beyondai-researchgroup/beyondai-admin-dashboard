import crypto from 'node:crypto';
import { enqueueMail, kickOutbox } from '../email/outbox.mjs';
import { buildProtocolStepEmail } from '../email/protocolStepEmail.mjs';
import { resolveBranding } from '../email/branding.mjs';
import { resolveSheetWorkbook, upsertSheetLink, loadSheetsWindow, sheetLinkExpiry } from '../sheets/resolve.mjs';

// Research-protocol engine (2026-10). Decides, for ONE participant of a PROTOCOL research, which step
// is next and delivers it: it detects completed steps, then (for the first step that is not done)
// sends the link by email right away, schedules it for later, or waits for the researcher —
// depending on the step's delivery setting. It is idempotent: calling it again never sends a step
// twice, so every trigger (a finished module reporting in, the daily cron, the researcher's button)
// can call it freely.
//
// The participant never sees the protocol: they only get the email for their next step. Status lives
// in ParticipantProtocolStep; a row only exists once a step has been engaged (a PENDING row for the
// current step when it is waiting on the researcher), so untouched later steps stay editable.

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches every other participant link
const DAY_MS = 24 * 60 * 60 * 1000;

const urls = () => ({
  FORMS: process.env.FORMS_APP_URL || 'http://localhost:4306',
  REI40: process.env.REI40_APP_URL || 'http://localhost:4300',
  BIGFIVE: process.env.BIGFIVE_APP_URL || 'http://localhost:4301',
  NASA_TLX: process.env.NASA_TLX_APP_URL || 'http://localhost:4201',
  DEMOGRAPHIC: process.env.DEMOGRAPHIC_APP_URL || 'http://localhost:4305',
  GENERIC_TASK: process.env.TASK_APP_URL || 'http://localhost:4304',
  CODE_REVIEW: process.env.CODE_REVIEW_APP_URL || 'http://localhost:4202',
  SHEETS: process.env.SHEETS_APP_URL || 'http://localhost:4307',
});

const generateToken = () => crypto.randomBytes(24).toString('base64url');

// The personal Code Review link is a participant's way back into the study for every session of the step (an Intro, then
// the main review), so — like the classic study's CODE_REVIEW link — it effectively never expires.
const CODE_REVIEW_TTL_MS = 100 * 365 * DAY_MS;
// Sessions table ids: 1 Intro, 2 AI, 3 Report, 4 Hybrid (the Code Review app derives the review mode from the session).
const REVIEW_SESSION_BY_MODE = { AI: 2, REPORT: 3, HYBRID: 4 };

/**
 * The sessions a Code Review step creates for one participant: the review mode comes from their group's override, else the
 * step's default; an optional Intro (practice) session comes first. null when no mode can be resolved.
 */
export function reviewPlan(step, participant) {
  const cfg = step.Config ?? {};
  const mode = (cfg.modeByGroup ?? []).find((m) => m.groupId === participant.GroupId)?.mode ?? cfg.defaultMode;
  if (!REVIEW_SESSION_BY_MODE[mode]) return null;
  const sessions = [];
  if (cfg.includeIntro) sessions.push({ sessionId: 1, seq: 1 });
  sessions.push({ sessionId: REVIEW_SESSION_BY_MODE[mode], seq: cfg.includeIntro ? 2 : 1 });
  return { mode, sessions };
}

/** Steps whose page the platform renders itself (forms app) get a ProtocolStepLink... */
const FORMS_STEP_TYPES = ['QUESTIONNAIRE', 'CONSENT', 'EXTERNAL_LINK'];
/** ...the existing module apps keep using their own SurveyAccessToken type. */
const MODULE_TOKEN_TYPES = { REI40: 'REI40', BIGFIVE: 'BIGFIVE', NASA_TLX: 'NASA_TLX', DEMOGRAPHIC: 'DEMOGRAPHIC' };

function resolveLang(participant, research) {
  if (participant.Language === 'sr' || participant.Language === 'en') return participant.Language;
  if (research.ConsentLanguageSr && !research.ConsentLanguageEn) return 'sr';
  if (research.ConsentLanguageEn && !research.ConsentLanguageSr) return 'en';
  return 'sr';
}

async function loadContext(sql, participantGuid) {
  const prow = await sql`
    SELECT p."Guid", p."ParticipantId", p."Email", p."Language", p."ConsentGivenAt", p."ResearchId", p."GroupId", p."ResearchTaskId", p."GenericTaskId", p."CodeReviewPrConfigId"
    FROM "Participant" p WHERE p."Guid" = ${participantGuid} LIMIT 1
  `;
  if (!prow.length) return null;
  const participant = prow[0];
  const rrow = await sql`
    SELECT "Id","FlowMode","Name","StudyDisplayName","EmailSenderName","ShowBeyondAiBranding","ConsentLanguageSr","ConsentLanguageEn","GoogleFormsUrl"
    FROM "Research" WHERE "Id" = ${participant.ResearchId} LIMIT 1
  `;
  const research = rrow[0];
  if (!research || research.FlowMode !== 'PROTOCOL') return null;
  const steps = await sql`
    SELECT "Id","StepType","TitleSr","TitleEn","QuestionnaireId","Config","Delivery","DelayDays","EmailMessageSr","EmailMessageEn"
    FROM "ResearchProtocolStep" WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"
  `;
  const rows = await sql`
    SELECT "StepId","Status","ScheduledFor","SentAt","CompletedAt","CompletedBy"
    FROM "ParticipantProtocolStep" WHERE "ParticipantGuid" = ${participantGuid}
  `;
  return { participant, research, steps, progress: new Map(rows.map((r) => [r.StepId, r])) };
}

/** Has the participant actually completed this step's module / form? (the source of truth is the result) */
async function isDone(sql, step, participant) {
  const guid = participant.Guid;
  switch (step.StepType) {
    case 'CONSENT': return participant.ConsentGivenAt != null;
    case 'DEMOGRAPHIC': return (await sql`SELECT 1 FROM "DemographicResponse" WHERE "ParticipantGuid" = ${guid} LIMIT 1`).length > 0;
    case 'REI40': return (await sql`SELECT 1 FROM "Rei40Result" WHERE "ParticipantGuid" = ${guid} LIMIT 1`).length > 0;
    case 'BIGFIVE': return (await sql`SELECT 1 FROM "BigFiveResult" WHERE "ParticipantGuid" = ${guid} LIMIT 1`).length > 0;
    case 'NASA_TLX': return (await sql`SELECT 1 FROM "TlxResult" WHERE "ParticipantGuid" = ${guid} LIMIT 1`).length > 0;
    case 'QUESTIONNAIRE':
      return (await sql`SELECT 1 FROM "QuestionnaireResponse" WHERE "ParticipantGuid" = ${guid} AND "StepId" = ${step.Id} LIMIT 1`).length > 0;
    case 'EXPERIMENT': {
      const kind = step.Config?.taskKind;
      if (kind === 'GENERIC_TASK') {
        return (await sql`SELECT 1 FROM "GenericTaskSubmission" WHERE "ParticipantGuid" = ${guid} LIMIT 1`).length > 0;
      }
      if (kind === 'SHEETS') {
        return (await sql`
          SELECT 1 FROM "SheetEntry" e JOIN "SheetWorkbook" w ON w."Id" = e."WorkbookId"
          WHERE w."ResearchId" = ${participant.ResearchId} AND e."ParticipantGuid" = ${guid} AND e."Status" = 'SUBMITTED' LIMIT 1
        `).length > 0;
      }
      if (kind === 'CODE_REVIEW') {
        // Done when every planned session is finished (NASA-TLX + the short questionnaire flip the flag at the very end).
        const plan = reviewPlan(step, participant);
        if (!plan) return false;
        const ids = plan.sessions.map((s) => s.sessionId);
        const rows = await sql`SELECT COUNT(*)::int AS n FROM "ParticipantSession" WHERE "ParticipantGuid" = ${guid} AND "SessionId" = ANY(${ids}) AND "IsFinished" = TRUE`;
        return rows[0].n === ids.length;
      }
      return false; // GOOGLE_FORM is confirmed by the participant in the forms app
    }
    default: return false; // EXTERNAL_LINK is completed by the forms app; MESSAGE / MANUAL are not detectable
  }
}

/** True for an EXPERIMENT step whose page is rendered by the forms app (a Google Form shown as an external link). */
const isFormsExperiment = (step) => step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'GOOGLE_FORM';

/** Creates (or refreshes, while unfinished) the participant's session rows for a Code Review step. */
async function ensureReviewSessions(sql, ctx, step) {
  const plan = reviewPlan(step, ctx.participant);
  for (const s of plan.sessions) {
    await sql`
      INSERT INTO "ParticipantSession" ("ParticipantId","ParticipantGuid","ResearchId","SessionId","SequenceOrder","PrConfigId")
      VALUES (${ctx.participant.ParticipantId}, ${ctx.participant.Guid}, ${ctx.research.Id}, ${s.sessionId}, ${s.seq},
              ${s.sessionId === 1 ? null : ctx.participant.CodeReviewPrConfigId})
      ON CONFLICT ("ParticipantGuid","SessionId") DO UPDATE
        SET "SequenceOrder" = EXCLUDED."SequenceOrder", "PrConfigId" = EXCLUDED."PrConfigId"
        WHERE "ParticipantSession"."IsFinished" = FALSE
    `;
  }
}

/** Why an EXPERIMENT step cannot be delivered yet (so a link that would open an empty page is never sent), or null. */
async function experimentBlocker(sql, ctx, step) {
  if (step.StepType !== 'EXPERIMENT') return null;
  const kind = step.Config?.taskKind;
  if (kind === 'GENERIC_TASK') return ctx.participant.GenericTaskId == null ? 'NO_TASK_ASSIGNED' : null;
  if (kind === 'GOOGLE_FORM') return /^https?:\/\//i.test(ctx.research.GoogleFormsUrl ?? '') ? null : 'NO_FORM_URL';
  if (kind === 'SHEETS') {
    // The participant's own template (by group and task). NO_WORKBOOK: the research has none at all; NO_TEMPLATE: it has some
    // but none fits this participant, so the link must not be sent.
    if (await resolveSheetWorkbook(sql, ctx.participant.Guid)) return null;
    const any = await sql`SELECT 1 FROM "SheetWorkbook" WHERE "ResearchId" = ${ctx.research.Id} LIMIT 1`;
    return any.length ? 'NO_TEMPLATE' : 'NO_WORKBOOK';
  }
  if (kind === 'CODE_REVIEW') {
    const plan = reviewPlan(step, ctx.participant);
    if (!plan) return 'NO_MODE';
    if (ctx.participant.CodeReviewPrConfigId == null) return 'NO_PR_ASSIGNED';
    if (step.Config?.includeIntro) {
      const intro = await sql`SELECT 1 FROM "ResearchPrConfig" WHERE "ResearchId" = ${ctx.research.Id} AND "IsIntro" = TRUE LIMIT 1`;
      if (!intro.length) return 'NO_INTRO_PR';
    }
    return null;
  }
  if (kind === 'OTHER') return null; // nothing to open: the description is the whole task
  return 'TASK_KIND_NOT_AVAILABLE';
}

async function setStatus(sql, guid, stepId, status, { scheduledFor = null, sent = false, completedBy = null } = {}) {
  await sql`
    INSERT INTO "ParticipantProtocolStep" ("ParticipantGuid","StepId","Status","ScheduledFor","SentAt","CompletedAt","CompletedBy")
    VALUES (${guid}, ${stepId}, ${status}, ${scheduledFor},
            ${sent || status === 'COMPLETED' ? new Date() : null}, ${status === 'COMPLETED' ? new Date() : null}, ${completedBy})
    ON CONFLICT ("ParticipantGuid","StepId") DO UPDATE SET
      "Status" = EXCLUDED."Status",
      "ScheduledFor" = EXCLUDED."ScheduledFor",
      "SentAt" = CASE WHEN ${sent} THEN NOW() ELSE COALESCE("ParticipantProtocolStep"."SentAt", EXCLUDED."SentAt") END,
      "CompletedAt" = CASE WHEN EXCLUDED."Status" = 'COMPLETED' THEN NOW() ELSE "ParticipantProtocolStep"."CompletedAt" END,
      "CompletedBy" = COALESCE(EXCLUDED."CompletedBy", "ParticipantProtocolStep"."CompletedBy")
  `;
}

/** Mints (replaces) the token of a step and returns its URL, or null for a step without a link. */
export async function mintStepUrl(sql, participant, step) {
  const participantGuid = participant.Guid;
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const u = urls();
  if (FORMS_STEP_TYPES.includes(step.StepType) || isFormsExperiment(step)) {
    await sql`
      INSERT INTO "ProtocolStepLink" ("Token","ParticipantGuid","StepId","ExpiresAt")
      VALUES (${token}, ${participantGuid}, ${step.Id}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid","StepId") DO UPDATE SET "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    return `${u.FORMS}/link/${token}`;
  }
  if (step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'CODE_REVIEW') {
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId","Token","ParticipantGuid","SurveyType","ExpiresAt")
      VALUES (${participant.ParticipantId}, ${token}, ${participantGuid}, 'CODE_REVIEW', ${new Date(Date.now() + CODE_REVIEW_TTL_MS)})
      ON CONFLICT ("ParticipantGuid","SurveyType") DO UPDATE SET "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    return `${u.CODE_REVIEW.replace(/\/$/, '')}/?link=${token}`;
  }
  if (step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'SHEETS') {
    const wb = await resolveSheetWorkbook(sql, participantGuid);
    if (!wb) return null;
    // Same upsert as the admin "Tabele" page: a new token replaces the old one but keeps the rules acknowledgement.
    const window = await loadSheetsWindow(sql, participant.ResearchId);
    await upsertSheetLink(sql, { token, workbookId: wb.Id, participantGuid, expiresAt: sheetLinkExpiry(window, TOKEN_TTL_MS) });
    return `${u.SHEETS}/link/${token}`;
  }
  const type = step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'GENERIC_TASK' ? 'GENERIC_TASK' : MODULE_TOKEN_TYPES[step.StepType];
  if (type) {
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId","Token","ParticipantGuid","SurveyType","ExpiresAt")
      VALUES (${participant.ParticipantId}, ${token}, ${participantGuid}, ${type}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid","SurveyType") DO UPDATE SET "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    return `${u[type]}/link/${token}`;
  }
  return null;
}

async function emailStep(sql, ctx, step, url, window = null) {
  const { participant, research } = ctx;
  const lang = resolveLang(participant, research);
  const message = lang === 'en' ? step.EmailMessageEn : step.EmailMessageSr;
  const body = step.StepType === 'MESSAGE'
    ? (lang === 'en' ? step.Config?.bodyEn : step.Config?.bodySr)
    : message;
  const branding = resolveBranding({ showBranding: research.ShowBeyondAiBranding, emailSenderName: research.EmailSenderName, studyDisplayName: research.StudyDisplayName, name: research.Name });
  const { subject, html } = buildProtocolStepEmail(lang, {
    url: step.StepType === 'MESSAGE' ? null : url,
    message: body,
    senderName: branding.senderName ?? research.Name,
    hideContact: branding.hideContact,
    window,
  });
  // Written to the outbox and sent by the drain, within the daily limit of the mail relay (a bulk start would otherwise hit
  // the quota or the function's time limit). The step counts as sent once its link exists and the message is queued.
  await enqueueMail(sql, {
    researchId: research.Id, participantGuid: participant.Guid, stepId: step.Id, to: participant.Email, subject, html,
    fromName: branding.senderName ?? research.Name,
  });
  await kickOutbox(sql);
}

/**
 * Delivers one step to the participant. Returns { ok: true } or { ok: false, reason }.
 *  - MANUAL step: nothing is sent; it is marked as waiting for the researcher (status SENT).
 *  - MESSAGE step: the message is emailed and the step is complete.
 *  - every other step: a link is minted and emailed; the step is SENT until the participant completes it.
 */
async function sendStep(sql, ctx, step) {
  const guid = ctx.participant.Guid;
  if (step.StepType === 'MANUAL') {
    await setStatus(sql, guid, step.Id, 'SENT', { sent: true });
    return { ok: true, sent: false };
  }
  if (!ctx.participant.Email) return { ok: false, reason: 'NO_EMAIL' };
  const blocker = await experimentBlocker(sql, ctx, step);
  if (blocker) return { ok: false, reason: blocker };
  if (step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'CODE_REVIEW') await ensureReviewSessions(sql, ctx, step);
  const url = step.StepType === 'MESSAGE' ? null : await mintStepUrl(sql, ctx.participant, step);
  try {
    const window = step.StepType === 'EXPERIMENT' && step.Config?.taskKind === 'SHEETS' ? await loadSheetsWindow(sql, ctx.participant.ResearchId) : null;
    await emailStep(sql, ctx, step, url, window);
  } catch (err) {
    console.error('[protocol-engine] email failed:', err?.message ?? err);
    return { ok: false, reason: 'EMAIL_FAILED' };
  }
  if (step.StepType === 'MESSAGE') await setStatus(sql, guid, step.Id, 'COMPLETED', { completedBy: 'AUTO' });
  else await setStatus(sql, guid, step.Id, 'SENT', { sent: true });
  return { ok: true, sent: true };
}

const isFinishedStatus = (s) => s === 'COMPLETED' || s === 'SKIPPED';

/**
 * Moves one participant forward as far as the protocol allows right now.
 * @param {object} opts
 *   start         — the researcher is starting this participant (creates the first row)
 *   forceStepId   — send this step now regardless of its delivery setting (researcher's "send now")
 * @returns {Promise<{ ok: boolean, reason?: string, sent: number[], current: number|null, finished: boolean }>}
 */
export async function advanceParticipant(sql, participantGuid, { start = false, forceStepId = null } = {}) {
  let ctx = await loadContext(sql, participantGuid);
  if (!ctx) return { ok: false, reason: 'NOT_PROTOCOL', sent: [], current: null, finished: false };
  if (ctx.steps.length === 0) return { ok: false, reason: 'EMPTY_PROTOCOL', sent: [], current: null, finished: false };
  if (ctx.progress.size === 0 && !start) return { ok: true, reason: 'NOT_STARTED', sent: [], current: null, finished: false };

  // A research that defines groups needs every participant in one before the protocol starts (the
  // group is locked once it has, so an unassigned participant must not slip through). Only checked
  // for the very first step: a participant already in progress is never blocked retroactively.
  if (ctx.progress.size === 0 && ctx.participant.GroupId == null) {
    const g = await sql`SELECT 1 FROM "ResearchGroup" WHERE "ResearchId" = ${ctx.research.Id} LIMIT 1`;
    if (g.length) return { ok: false, reason: 'GROUP_REQUIRED', sent: [], current: null, finished: false };
  }
  // The same for the study task (A / B): when the research has two or more, everybody needs one before the start.
  if (ctx.progress.size === 0 && ctx.participant.ResearchTaskId == null) {
    const t = await sql`SELECT COUNT(*)::int AS n FROM "ResearchTask" WHERE "ResearchId" = ${ctx.research.Id}`;
    if (t[0].n >= 2) return { ok: false, reason: 'TASK_REQUIRED', sent: [], current: null, finished: false };
  }

  // A participant's language is locked the first time it is known; default it from the research so
  // every app they are sent to (which read Participant.Language) speaks the right language.
  if (!ctx.participant.Language) {
    const lang = resolveLang(ctx.participant, ctx.research);
    await sql`UPDATE "Participant" SET "Language" = COALESCE("Language", ${lang}) WHERE "Guid" = ${participantGuid}`;
  }

  const sent = [];
  let reason;
  for (let guard = 0; guard <= ctx.steps.length + 2; guard++) {
    ctx = await loadContext(sql, participantGuid);

    // Reconcile: a step that was sent and whose result now exists is complete.
    for (const step of ctx.steps) {
      const row = ctx.progress.get(step.Id);
      if (row && (row.Status === 'SENT' || row.Status === 'SCHEDULED') && await isDone(sql, step, ctx.participant)) {
        await setStatus(sql, participantGuid, step.Id, 'COMPLETED', { completedBy: 'AUTO' });
        ctx.progress.set(step.Id, { ...row, Status: 'COMPLETED', CompletedAt: new Date() });
      }
    }

    const idx = ctx.steps.findIndex((s) => !isFinishedStatus(ctx.progress.get(s.Id)?.Status));
    if (idx === -1) return { ok: true, sent, current: null, finished: true };
    const step = ctx.steps[idx];
    const row = ctx.progress.get(step.Id);
    const force = forceStepId === step.Id;
    const now = new Date();

    if (row?.Status === 'SENT') return { ok: true, sent, current: step.Id, finished: false, reason };

    if (row?.Status === 'SCHEDULED' && !force) {
      if (new Date(row.ScheduledFor) > now) return { ok: true, sent, current: step.Id, finished: false, reason };
    } else if (!force && step.StepType !== 'MANUAL') {
      // No row yet (or PENDING): apply the step's delivery setting.
      if (step.Delivery === 'MANUAL') {
        if (!row) await setStatus(sql, participantGuid, step.Id, 'PENDING');
        return { ok: true, sent, current: step.Id, finished: false, reason: 'WAITING_FOR_RESEARCHER' };
      }
      if (step.Delivery === 'AFTER_DELAY') {
        const prev = idx > 0 ? ctx.progress.get(ctx.steps[idx - 1].Id) : null;
        // The delay counts from the previous step's completion; after a skipped previous step, or for
        // the first step, from the moment it is evaluated (the researcher starting / skipping).
        const base = prev?.CompletedAt ? new Date(prev.CompletedAt) : now;
        const due = new Date(base.getTime() + (step.DelayDays ?? 0) * DAY_MS);
        if (due > now) {
          await setStatus(sql, participantGuid, step.Id, 'SCHEDULED', { scheduledFor: due });
          return { ok: true, sent, current: step.Id, finished: false, reason: 'SCHEDULED' };
        }
      }
    }

    // Nothing to do for a step that is already satisfied (e.g. consent given earlier).
    if (step.StepType !== 'MANUAL' && step.StepType !== 'MESSAGE' && await isDone(sql, step, ctx.participant)) {
      await setStatus(sql, participantGuid, step.Id, 'COMPLETED', { completedBy: 'AUTO' });
      continue;
    }

    const result = await sendStep(sql, ctx, step);
    if (!result.ok) return { ok: false, reason: result.reason, sent, current: step.Id, finished: false };
    if (result.sent) sent.push(step.Id);
    reason = undefined;
    // A completed message step lets the loop move on to the next step; anything else waits for the participant.
    if (step.StepType !== 'MESSAGE') return { ok: true, sent, current: step.Id, finished: false };
  }
  return { ok: true, sent, current: null, finished: false };
}

/** Researcher action: re-send the link of the step that is currently waiting for the participant. */
export async function resendStep(sql, participantGuid, stepId) {
  const ctx = await loadContext(sql, participantGuid);
  if (!ctx) return { ok: false, reason: 'NOT_PROTOCOL' };
  const step = ctx.steps.find((s) => s.Id === stepId);
  const row = ctx.progress.get(stepId);
  if (!step || !row || row.Status !== 'SENT' || step.StepType === 'MANUAL' || step.StepType === 'MESSAGE') {
    return { ok: false, reason: 'NOT_RESENDABLE' };
  }
  return sendStep(sql, ctx, step);
}

/** Researcher action: mark a step done by hand (e.g. the in-person step) or skip it, then advance. */
export async function markStep(sql, participantGuid, stepId, status, researcherId) {
  const ctx = await loadContext(sql, participantGuid);
  if (!ctx) return { ok: false, reason: 'NOT_PROTOCOL' };
  if (!ctx.steps.some((s) => s.Id === stepId)) return { ok: false, reason: 'UNKNOWN_STEP' };
  if (status !== 'COMPLETED' && status !== 'SKIPPED') return { ok: false, reason: 'INVALID_STATUS' };
  await setStatus(sql, participantGuid, stepId, status, { completedBy: status === 'COMPLETED' ? String(researcherId) : null });
  // A participant who has just had a step marked is by definition started.
  return advanceParticipant(sql, participantGuid, { start: true });
}

/** Cron / sweep: advance everyone with something in flight (due scheduled steps, sent steps to reconcile). */
export async function advanceAllDue(sql, limit = 500) {
  const rows = await sql`
    SELECT DISTINCT pp."ParticipantGuid"
    FROM "ParticipantProtocolStep" pp
    JOIN "Participant" p ON p."Guid" = pp."ParticipantGuid"
    JOIN "Research" r ON r."Id" = p."ResearchId"
    WHERE r."FlowMode" = 'PROTOCOL' AND pp."Status" IN ('PENDING','SCHEDULED','SENT')
    LIMIT ${limit}
  `;
  let advanced = 0;
  for (const r of rows) {
    try {
      await advanceParticipant(sql, r.ParticipantGuid);
      advanced++;
    } catch (err) {
      console.error('[protocol-engine] advance failed for', r.ParticipantGuid, err?.message ?? err);
    }
  }
  return { checked: rows.length, advanced };
}
