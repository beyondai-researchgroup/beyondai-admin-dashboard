import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { dateOnly } from '../date-only.mjs';
import { advanceParticipant, resendStep, markStep } from '../protocol/engine.mjs';

// Participant progress through a research's protocol (2026-10) — what the researcher sees and does:
// a matrix of every participant x step, one participant's timeline with the live link of the step
// they are on, and the actions: start the protocol, send a step now, resend its link, mark an
// in-person step done, skip a step. The participant never sees any of this.
//
// Own router and base path (route-collision discipline: the participant routes below have a
// different shape from protocol/routes.mjs's `/:researchId`).
const router = Router();
router.use(requireAuth);

const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];
const MAX_START_ALL = 200;
const FORMS_STEP_TYPES = ['QUESTIONNAIRE', 'CONSENT', 'EXTERNAL_LINK'];
const MODULE_TOKEN_TYPES = { REI40: 'REI40', BIGFIVE: 'BIGFIVE', NASA_TLX: 'NASA_TLX', DEMOGRAPHIC: 'DEMOGRAPHIC' };

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

/** Validates the research id, scope and PROTOCOL mode. Returns the research row or null (response sent). */
async function protocolResearch(req, res, write) {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return null;
  }
  if (!scopeGuard(req, res, researchId)) return null;
  if (write && !writeGuard(req, res, researchId)) return null;
  const rows = await getDb()`SELECT "Id","FlowMode" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
  if (!rows.length) {
    res.status(404).json({ error: 'Research not found' });
    return null;
  }
  if (rows[0].FlowMode !== 'PROTOCOL') {
    res.status(400).json({ error: 'NOT_PROTOCOL' });
    return null;
  }
  return rows[0];
}

async function findParticipant(sql, researchId, participantId) {
  const rows = await sql`
    SELECT p."Guid", p."ParticipantId", p."Email", p."Language", p."GroupId", g."Name" AS "GroupName",
           p."ResearchTaskId", t."Name" AS "TaskName",
           p."CodeReviewPrConfigId", pc."Label" AS "PrLabel"
    FROM "Participant" p LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    LEFT JOIN "ResearchTask" t ON t."Id" = p."ResearchTaskId"
    LEFT JOIN "ResearchPrConfig" pc ON pc."Id" = p."CodeReviewPrConfigId"
    WHERE p."ResearchId" = ${researchId} AND p."ParticipantId" = ${participantId} LIMIT 1
  `;
  return rows[0] ?? null;
}

const mapEngine = (r) => ({
  ok: r.ok, reason: r.reason ?? null, sentStepIds: r.sent ?? [], currentStepId: r.current ?? null, finished: !!r.finished,
});

// Matrix: every participant of the research x every step.
router.get('/:researchId/participants', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, false);
    if (!research) return;
    const sql = getDb();
    const steps = await sql`
      SELECT "Id","StepType","TitleSr","TitleEn","Delivery" FROM "ResearchProtocolStep" WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"
    `;
    const participants = await sql`
      SELECT p."Guid", p."ParticipantId", p."Email", p."Language", p."GroupId", g."Name" AS "GroupName",
             p."ResearchTaskId", t."Name" AS "TaskName", p."GroupAssignedBy", p."TaskAssignedBy",
             p."CodeReviewPrConfigId", pc."Label" AS "PrLabel",
             (SELECT COUNT(*)::int FROM "EmailOutbox" o WHERE o."ParticipantGuid" = p."Guid" AND o."Status" IN ('PENDING','SENDING')) AS "MailPending",
             (SELECT COUNT(*)::int FROM "EmailOutbox" o WHERE o."ParticipantGuid" = p."Guid" AND o."Status" = 'FAILED') AS "MailFailed",
             (SELECT TO_CHAR(es."SessionDate", 'YYYY-MM-DD') || ' ' || TO_CHAR(sl."StartTime", 'HH24:MI')
              FROM "SessionSlotAttendee" at JOIN "SessionSlot" sl ON sl."Id" = at."SlotId"
              JOIN "ExperimentalSession" es ON es."Id" = sl."ExperimentalSessionId"
              WHERE at."ParticipantGuid" = p."Guid" AND es."SessionDate" >= CURRENT_DATE
              ORDER BY es."SessionDate", sl."StartTime" LIMIT 1) AS "NextSlot"
      FROM "Participant" p LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
      LEFT JOIN "ResearchTask" t ON t."Id" = p."ResearchTaskId"
      LEFT JOIN "ResearchPrConfig" pc ON pc."Id" = p."CodeReviewPrConfigId"
      WHERE p."ResearchId" = ${research.Id}
      ORDER BY p."ParticipantId" LIMIT 2000
    `;
    const prTasks = await sql`
      SELECT "Id","Label" FROM "ResearchPrConfig" WHERE "ResearchId" = ${research.Id} AND "IsIntro" = FALSE ORDER BY "Label"
    `;
    const groups = await sql`
      SELECT "Id","Name","Weight","IsControl" FROM "ResearchGroup" WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"
    `;
    const tasks = await sql`
      SELECT "Id","Name","Weight" FROM "ResearchTask" WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"
    `;
    const rows = await sql`
      SELECT pp."ParticipantGuid", pp."StepId", pp."Status", pp."ScheduledFor", pp."SentAt", pp."CompletedAt"
      FROM "ParticipantProtocolStep" pp JOIN "Participant" p ON p."Guid" = pp."ParticipantGuid"
      WHERE p."ResearchId" = ${research.Id}
    `;
    const byGuid = new Map();
    for (const r of rows) {
      const m = byGuid.get(r.ParticipantGuid) ?? {};
      m[r.StepId] = { status: r.Status, scheduledFor: r.ScheduledFor, sentAt: r.SentAt, completedAt: r.CompletedAt };
      byGuid.set(r.ParticipantGuid, m);
    }
    res.json({
      groups: groups.map((g) => ({ id: g.Id, name: g.Name, weight: g.Weight, isControl: g.IsControl })),
      tasks: tasks.map((t) => ({ id: t.Id, name: t.Name, weight: t.Weight })),
      prTasks: prTasks.map((t) => ({ id: t.Id, label: t.Label })),
      steps: steps.map((s) => ({ id: s.Id, stepType: s.StepType, titleSr: s.TitleSr, titleEn: s.TitleEn, delivery: s.Delivery })),
      participants: participants.map((p) => {
        const statuses = byGuid.get(p.Guid) ?? {};
        const started = Object.keys(statuses).length > 0;
        const finished = started && steps.length > 0 && steps.every((s) => ['COMPLETED', 'SKIPPED'].includes(statuses[s.Id]?.status));
        return {
          participantId: p.ParticipantId, hasEmail: !!p.Email, language: p.Language, started, finished, statuses,
          groupId: p.GroupId ?? null, groupName: p.GroupName ?? null, groupAssignedBy: p.GroupAssignedBy ?? null,
          taskId: p.ResearchTaskId ?? null, taskName: p.TaskName ?? null, taskAssignedBy: p.TaskAssignedBy ?? null,
          mailPending: p.MailPending, mailFailed: p.MailFailed, nextSlot: p.NextSlot ?? null,
          prConfigId: p.CodeReviewPrConfigId ?? null, prLabel: p.PrLabel ?? null,
        };
      }),
    });
  } catch (err) {
    console.error('[protocol-progress] matrix error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// One participant's timeline, with the live link of the step they are on.
router.get('/:researchId/participants/:participantId', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, false);
    if (!research) return;
    const sql = getDb();
    const p = await findParticipant(sql, research.Id, String(req.params.participantId));
    if (!p) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    const steps = await sql`
      SELECT "Id","StepType","TitleSr","TitleEn","Delivery","DelayDays","Config" FROM "ResearchProtocolStep"
      WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"
    `;
    const rows = await sql`
      SELECT "StepId","Status","ScheduledFor","SentAt","CompletedAt","CompletedBy" FROM "ParticipantProtocolStep" WHERE "ParticipantGuid" = ${p.Guid}
    `;
    const stepLinks = await sql`SELECT "StepId","Token","ExpiresAt" FROM "ProtocolStepLink" WHERE "ParticipantGuid" = ${p.Guid}`;
    const moduleLinks = await sql`
      SELECT "SurveyType","Token","ExpiresAt" FROM "SurveyAccessToken"
      WHERE "ParticipantGuid" = ${p.Guid} AND "SurveyType" IN ('REI40','BIGFIVE','NASA_TLX','DEMOGRAPHIC','GENERIC_TASK','CODE_REVIEW')
    `;
    const sheetLink = (await sql`
      SELECT l."Token", l."ExpiresAt" FROM "SheetAccessLink" l JOIN "SheetWorkbook" w ON w."Id" = l."WorkbookId"
      WHERE l."ParticipantGuid" = ${p.Guid} AND w."ResearchId" = ${research.Id} ORDER BY l."CreatedAt" DESC LIMIT 1
    `)[0] ?? null;
    const progress = new Map(rows.map((r) => [r.StepId, r]));
    const stepLinkById = new Map(stepLinks.map((l) => [l.StepId, l]));
    const moduleLinkByType = new Map(moduleLinks.map((l) => [l.SurveyType, l]));
    const u = urls();
    const linkFor = (s) => {
      let link = null;
      let base = null;
      const kind = s.StepType === 'EXPERIMENT' ? s.Config?.taskKind : null;
      if (FORMS_STEP_TYPES.includes(s.StepType) || kind === 'GOOGLE_FORM') { link = stepLinkById.get(s.Id); base = u.FORMS; }
      else if (kind === 'SHEETS') { link = sheetLink; base = u.SHEETS; }
      else if (kind === 'GENERIC_TASK') { link = moduleLinkByType.get('GENERIC_TASK'); base = u.GENERIC_TASK; }
      else if (kind === 'CODE_REVIEW') {
        const l = moduleLinkByType.get('CODE_REVIEW');
        if (!l) return { linkUrl: null, linkExpired: false };
        return { linkUrl: `${u.CODE_REVIEW.replace(/\/$/, '')}/?link=${l.Token}`, linkExpired: new Date(l.ExpiresAt) < new Date() };
      }
      else if (MODULE_TOKEN_TYPES[s.StepType]) { link = moduleLinkByType.get(MODULE_TOKEN_TYPES[s.StepType]); base = u[MODULE_TOKEN_TYPES[s.StepType]]; }
      if (!link) return { linkUrl: null, linkExpired: false };
      return { linkUrl: `${base}/link/${link.Token}`, linkExpired: new Date(link.ExpiresAt) < new Date() };
    };
    const reviewSessions = await sql`
      SELECT ps."SessionId", s."Name", ps."IsFinished", ps."FinishedAt"
      FROM "ParticipantSession" ps JOIN "Sessions" s ON s."Id" = ps."SessionId"
      WHERE ps."ParticipantGuid" = ${p.Guid} ORDER BY COALESCE(ps."SequenceOrder", ps."SessionId")
    `;
    const slots = await sql`
      SELECT sl."Id", es."SessionDate", TO_CHAR(sl."StartTime", 'HH24:MI') AS "StartHm", sl."DurationMinutes", sl."Kind",
             sl."MeetingUrl", sl."Location", sl."ProtocolStepId", sl."GoogleCalendarEventUrl"
      FROM "SessionSlotAttendee" a JOIN "SessionSlot" sl ON sl."Id" = a."SlotId"
      JOIN "ExperimentalSession" es ON es."Id" = sl."ExperimentalSessionId"
      WHERE a."ParticipantGuid" = ${p.Guid} ORDER BY es."SessionDate", sl."StartTime"
    `;
    res.json({
      slots: slots.map((x) => ({
        id: x.Id, date: dateOnly(x.SessionDate), time: x.StartHm, durationMinutes: x.DurationMinutes, kind: x.Kind,
        meetingUrl: x.MeetingUrl, location: x.Location, stepId: x.ProtocolStepId ?? null, calendarUrl: x.GoogleCalendarEventUrl ?? null,
      })),
      reviewSessions: reviewSessions.map((r) => ({ sessionId: r.SessionId, name: r.Name, finished: r.IsFinished, finishedAt: r.FinishedAt })),
      participantId: p.ParticipantId,
      email: p.Email,
      language: p.Language,
      groupId: p.GroupId ?? null,
      groupName: p.GroupName ?? null,
      prConfigId: p.CodeReviewPrConfigId ?? null,
      prLabel: p.PrLabel ?? null,
      started: progress.size > 0,
      steps: steps.map((s) => {
        const r = progress.get(s.Id);
        const status = r?.Status ?? 'NOT_REACHED';
        return {
          id: s.Id, stepType: s.StepType, titleSr: s.TitleSr, titleEn: s.TitleEn, delivery: s.Delivery, delayDays: s.DelayDays,
          status, scheduledFor: r?.ScheduledFor ?? null, sentAt: r?.SentAt ?? null,
          completedAt: r?.CompletedAt ?? null, completedBy: r?.CompletedBy ?? null,
          // The live link is only useful while the step is waiting for the participant.
          ...(status === 'SENT' || status === 'SCHEDULED' ? linkFor(s) : { linkUrl: null, linkExpired: false }),
        };
      }),
    });
  } catch (err) {
    console.error('[protocol-progress] timeline error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Which pull request a participant reviews in the Code Review step. Locked once that step has been delivered to them.
router.put('/:researchId/participants/:participantId/pr-task', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, true);
    if (!research) return;
    const { prConfigId } = req.body ?? {};
    if (prConfigId != null && !Number.isInteger(Number(prConfigId))) {
      res.status(400).json({ error: 'Invalid prConfigId' });
      return;
    }
    const sql = getDb();
    const p = await findParticipant(sql, research.Id, String(req.params.participantId));
    if (!p) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    const target = prConfigId == null ? null : Number(prConfigId);
    if (target != null) {
      const own = await sql`SELECT 1 FROM "ResearchPrConfig" WHERE "Id" = ${target} AND "ResearchId" = ${research.Id} AND "IsIntro" = FALSE LIMIT 1`;
      if (!own.length) {
        res.status(400).json({ error: 'Unknown PR task for this research' });
        return;
      }
    }
    const delivered = await sql`
      SELECT 1 FROM "ParticipantProtocolStep" pp JOIN "ResearchProtocolStep" s ON s."Id" = pp."StepId"
      WHERE pp."ParticipantGuid" = ${p.Guid} AND s."Config"->>'taskKind' = 'CODE_REVIEW' AND pp."Status" <> 'PENDING' LIMIT 1
    `;
    if (delivered.length && p.CodeReviewPrConfigId !== target) {
      res.status(409).json({ error: 'PR_LOCKED' });
      return;
    }
    await sql`UPDATE "Participant" SET "CodeReviewPrConfigId" = ${target} WHERE "Guid" = ${p.Guid}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[protocol-progress] pr-task error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start the protocol for one participant (sends / schedules the first step).
router.post('/:researchId/participants/:participantId/start', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, true);
    if (!research) return;
    const sql = getDb();
    const p = await findParticipant(sql, research.Id, String(req.params.participantId));
    if (!p) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    res.json(mapEngine(await advanceParticipant(sql, p.Guid, { start: true })));
  } catch (err) {
    console.error('[protocol-progress] start error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start the protocol for every participant that has not been started yet (a bounded batch).
router.post('/:researchId/start-all', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, true);
    if (!research) return;
    const sql = getDb();
    const pending = await sql`
      SELECT p."Guid", p."ParticipantId" FROM "Participant" p
      WHERE p."ResearchId" = ${research.Id}
        AND NOT EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid")
      ORDER BY p."ParticipantId" LIMIT ${MAX_START_ALL}
    `;
    const results = [];
    for (const p of pending) {
      const r = await advanceParticipant(sql, p.Guid, { start: true });
      results.push({ participantId: p.ParticipantId, ok: r.ok, reason: r.reason ?? null });
    }
    res.json({
      started: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      limited: pending.length === MAX_START_ALL,
    });
  } catch (err) {
    console.error('[protocol-progress] start-all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a step now (ignoring its delivery setting), or resend the link if it was already sent.
router.post('/:researchId/participants/:participantId/steps/:stepId/send', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, true);
    if (!research) return;
    const stepId = Number(req.params.stepId);
    if (!Number.isInteger(stepId) || stepId <= 0) {
      res.status(400).json({ error: 'Invalid step id' });
      return;
    }
    const sql = getDb();
    const p = await findParticipant(sql, research.Id, String(req.params.participantId));
    if (!p) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    const status = (await sql`SELECT "Status" FROM "ParticipantProtocolStep" WHERE "ParticipantGuid" = ${p.Guid} AND "StepId" = ${stepId} LIMIT 1`)[0]?.Status;
    if (status === 'SENT') {
      const r = await resendStep(sql, p.Guid, stepId);
      res.json({ ok: r.ok, reason: r.reason ?? null, sentStepIds: r.ok ? [stepId] : [], currentStepId: stepId, finished: false });
      return;
    }
    res.json(mapEngine(await advanceParticipant(sql, p.Guid, { start: true, forceStepId: stepId })));
  } catch (err) {
    console.error('[protocol-progress] send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send one step (typically the experimental session with the participant's table) to everybody who is ready for it:
// the participants whose earlier steps are all done (so nobody gets the table before the consent) and who have not
// been sent it yet. body.participantIds narrows it down; body.force also sends to those whose earlier steps are not
// finished. Goes through the same engine call as the single send, so statuses stay correct. A bounded batch.
router.post('/:researchId/steps/:stepId/send-all', async (req, res) => {
  try {
    const research = await protocolResearch(req, res, true);
    if (!research) return;
    const stepId = Number(req.params.stepId);
    if (!Number.isInteger(stepId) || stepId <= 0) {
      res.status(400).json({ error: 'Invalid step id' });
      return;
    }
    const sql = getDb();
    const steps = await sql`SELECT "Id" FROM "ResearchProtocolStep" WHERE "ResearchId" = ${research.Id} ORDER BY "SortOrder","Id"`;
    const at = steps.findIndex((s) => s.Id === stepId);
    if (at < 0) {
      res.status(404).json({ error: 'Step not found' });
      return;
    }
    const earlier = steps.slice(0, at).map((s) => s.Id);
    const ids = Array.isArray(req.body?.participantIds) ? new Set(req.body.participantIds.map(String)) : null;
    const force = req.body?.force === true;
    const people = await sql`
      SELECT p."Guid", p."ParticipantId" FROM "Participant" p
      WHERE p."ResearchId" = ${research.Id}
        AND EXISTS (SELECT 1 FROM "ParticipantProtocolStep" pp WHERE pp."ParticipantGuid" = p."Guid")
      ORDER BY p."ParticipantId"
    `;
    const rows = await sql`
      SELECT pp."ParticipantGuid", pp."StepId", pp."Status" FROM "ParticipantProtocolStep" pp
      JOIN "Participant" p ON p."Guid" = pp."ParticipantGuid" WHERE p."ResearchId" = ${research.Id}
    `;
    const statusBy = new Map(rows.map((r) => [`${r.ParticipantGuid}:${r.StepId}`, r.Status]));
    const result = { sent: 0, failed: [], skippedNotReady: 0, skippedAlready: 0, limited: false };
    let handled = 0;
    for (const p of people) {
      if (ids && !ids.has(p.ParticipantId)) continue;
      const own = statusBy.get(`${p.Guid}:${stepId}`);
      if (own === 'SENT' || own === 'COMPLETED' || own === 'SKIPPED') { result.skippedAlready++; continue; }
      const ready = earlier.every((id) => ['COMPLETED', 'SKIPPED'].includes(statusBy.get(`${p.Guid}:${id}`)));
      if (!ready && !force) { result.skippedNotReady++; continue; }
      if (handled >= MAX_START_ALL) { result.limited = true; break; }
      handled++;
      const r = await advanceParticipant(sql, p.Guid, { start: true, forceStepId: stepId });
      if (r.ok && (r.sent ?? []).includes(stepId)) result.sent++;
      else result.failed.push({ participantId: p.ParticipantId, reason: r.reason ?? 'NOT_SENT' });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[protocol-progress] send-all error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark a step done by hand (e.g. the in-person step) / skip it.
for (const [action, status] of [['complete', 'COMPLETED'], ['skip', 'SKIPPED']]) {
  router.post(`/:researchId/participants/:participantId/steps/:stepId/${action}`, async (req, res) => {
    try {
      const research = await protocolResearch(req, res, true);
      if (!research) return;
      const stepId = Number(req.params.stepId);
      if (!Number.isInteger(stepId) || stepId <= 0) {
        res.status(400).json({ error: 'Invalid step id' });
        return;
      }
      const sql = getDb();
      const p = await findParticipant(sql, research.Id, String(req.params.participantId));
      if (!p) {
        res.status(404).json({ error: 'Participant not found' });
        return;
      }
      // The step must belong to this research.
      const own = await sql`SELECT 1 FROM "ResearchProtocolStep" WHERE "Id" = ${stepId} AND "ResearchId" = ${research.Id} LIMIT 1`;
      if (!own.length) {
        res.status(404).json({ error: 'Step not found' });
        return;
      }
      res.json(mapEngine(await markStep(sql, p.Guid, stepId, status, req.researcher.id)));
    } catch (err) {
      console.error(`[protocol-progress] ${action} error:`, err);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

export default router;
