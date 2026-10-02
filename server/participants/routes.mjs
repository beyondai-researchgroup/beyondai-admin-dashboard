import crypto from 'node:crypto';
import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { sendMail } from '../email/mailer.mjs';
import { buildRegenerateLinksEmail } from '../email/regenerateLinksEmail.mjs';
import { buildConsentLinkEmail } from '../email/consentLinkEmail.mjs';
import { notifyResearchMembers } from '../notifications/create.mjs';
import { resolveParticipantByBareId, AMBIGUOUS_PARTICIPANT } from './resolve.mjs';
import { dateOnly } from '../date-only.mjs';

const router = Router();
router.use(requireAuth);

const MAX_IMPORT_BATCH = 500;
const MAX_ID_LENGTH = 50;
const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 255;

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (2026-10-02 follow-up, was 24h) — same default as the Consent app's initial issue
const REI40_APP_URL = process.env.REI40_APP_URL || 'http://localhost:4300';
const BIGFIVE_APP_URL = process.env.BIGFIVE_APP_URL || 'http://localhost:4301';
const NASA_TLX_APP_URL = process.env.NASA_TLX_APP_URL || 'http://localhost:4201';
const TASK_APP_URL = process.env.TASK_APP_URL || 'http://localhost:4304';

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// NASA-TLX for a PR_REVIEW research is delivered exclusively via the Code Review AI app's own
// decision -> NASA-TLX handoff (AppComponent.onDecisionSubmitted) — never through a standalone
// magic-link/email. The standalone NASA-TLX module (Part D of the platform re-architecture,
// 2026-09-07) only applies to a research with no code-review-ai flow at all. Mirrors
// consent-andrejkatin/server.mjs's own includesStandaloneTlxLink (duplicated per this project's
// established cross-repo convention — the two apps share no package).
function includesStandaloneTlxLink(usesTlx, taskType) {
  return !!usesTlx && taskType !== 'PR_REVIEW';
}

/**
 * Re-issues both REI-40/Big Five access tokens for a participant and emails the new links —
 * for when the original 24h-expiring links (sent by the Consent app right after consent) lapsed
 * before the participant used them. Overwrites the existing SurveyAccessToken rows in place
 * (same ON CONFLICT upsert as the Consent app's own submit handler), so the old links stop
 * resolving the moment this runs. Requires the participant to have already consented (that's
 * what originally creates their Email/Language on file) — this endpoint never sends anyone their
 * very first links, only replacements.
 */
router.post('/:participantId/regenerate-links', async (req, res) => {
  const participantId = req.params.participantId;
  if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > MAX_ID_LENGTH) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }

  try {
    const sql = getDb();
    // Item 1 of the "platform improvements round 2" plan — this route only takes a bare
    // ParticipantId path param with no researchId, so a genuine cross-research collision can't be
    // disambiguated here; fail loud instead of silently picking one (see resolveParticipantByBareId).
    const participant = await resolveParticipantByBareId(sql, participantId);
    if (participant === AMBIGUOUS_PARTICIPANT) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!participant) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const researchRows = await sql`
      SELECT "EmailSenderName", "StudyDisplayName", "Name" AS "ResearchName", "UsesPsychTests", "UsesTlx", "TaskType", "UsesDemographics"
      FROM "Research" WHERE "Id" = ${participant.ResearchId} LIMIT 1
    `;
    // Task-app link (2026-09-14) — gated on the participant's own GenericTaskId assignment, not a
    // research toggle (see issueSurveyLinks.mjs's own comment on this in consent-andrejkatin).
    const genericTaskId = participant.GenericTaskId ?? null;
    const p = { ...participant, ...(researchRows[0] ?? {}) };
    const includeTlxLink = includesStandaloneTlxLink(p.UsesTlx, p.TaskType);

    try {
      resolveResearchScope(req.researcher, p.ResearchId);
    } catch (err) {
      if (err instanceof ScopeForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }

    if (!p.ConsentGivenAt) {
      res.status(400).json({ error: 'NOT_CONSENTED' });
      return;
    }
    if (!p.Email) {
      res.status(400).json({ error: 'NO_EMAIL' });
      return;
    }
    if (!(p.UsesPsychTests ?? true) && !includeTlxLink && genericTaskId == null && !(p.UsesDemographics ?? false)) {
      // Nothing this research issues a link for — there's no "replacement" to send.
      res.status(400).json({ error: 'NO_LINKS_TO_ISSUE' });
      return;
    }

    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    // Only reissue whichever modules this research actually uses (Part D of the platform
    // re-architecture, 2026-09-07 — previously minted REI40/BIGFIVE unconditionally regardless of
    // UsesPsychTests, a latent gap fixed here alongside adding NASA_TLX). ParticipantGuid is
    // supplied explicitly (already resolved above via resolveParticipantByBareId, which already
    // ruled out ambiguity) rather than left for the set_participant_guid trigger to re-resolve
    // from the bare ParticipantId — the trigger would otherwise correctly refuse to guess for any
    // OTHER identically-named participant that might exist in a different research.
    const urls = [];
    if (p.UsesPsychTests ?? true) {
      const rei40Token = generateToken();
      const bigfiveToken = generateToken();
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${p.Guid}, 'REI40', ${rei40Token}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${p.Guid}, 'BIGFIVE', ${bigfiveToken}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
      urls.push(`${REI40_APP_URL}/link/${rei40Token}`, `${BIGFIVE_APP_URL}/link/${bigfiveToken}`);
    }
    if (includeTlxLink) {
      const tlxToken = generateToken();
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${p.Guid}, 'NASA_TLX', ${tlxToken}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
      urls.push(`${NASA_TLX_APP_URL}/link/${tlxToken}`);
    }
    let taskUrl;
    if (genericTaskId != null) {
      const taskToken = generateToken();
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${p.Guid}, 'GENERIC_TASK', ${taskToken}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
      taskUrl = `${TASK_APP_URL}/link/${taskToken}`;
    }
    // Demographic Questionnaire (2026-10-01) — research-level toggle, same shape as
    // UsesPsychTests/includeTlxLink, not a per-participant signal like genericTaskId.
    let demographicUrl;
    if (p.UsesDemographics ?? false) {
      const demoToken = generateToken();
      await sql`
        INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
        VALUES (${participantId}, ${p.Guid}, 'DEMOGRAPHIC', ${demoToken}, ${expiresAt})
        ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
          "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
      `;
      demographicUrl = `${DEMOGRAPHIC_APP_URL}/link/${demoToken}`;
    }

    // Fallback chain: an explicit per-research sender-name override, else the research's own
    // display name, else its raw Name, else buildRegenerateLinksEmail/sendMail's own hardcoded
    // default — same chain StudyDisplayName itself already uses for the thank-you email.
    const senderName = p.EmailSenderName ?? p.StudyDisplayName ?? p.ResearchName ?? undefined;
    const { subject, html } = buildRegenerateLinksEmail(p.Language ?? 'sr', { urls, taskUrl, demographicUrl, senderName });
    await sendMail({ to: p.Email, subject, html, fromName: senderName });

    res.json({ ok: true });
  } catch (err) {
    console.error('[participants] regenerate-links error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

router.get('/', async (req, res) => {
  let researchId;
  try {
    researchId = resolveResearchScope(req.researcher, req.query.researchId);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    const sql = getDb();
    // Item 1 of the "platform improvements round 2" plan — joining ParticipantSession by the
    // bare ParticipantId string alone (with no ResearchId check on the session side) could, now
    // that two researches can share a ParticipantId, attach a DIFFERENT research's session rows
    // to this research's participant. Joining through ParticipantGuid instead ties each session
    // row to the exact Participant it actually belongs to, collision or not.
    // LEFT JOIN (was an inner JOIN until 2026-09-11) — a GENERIC/GOOGLE_FORMS-type research's
    // imported participants have zero ParticipantSession rows by design (no Tasks sheet for those
    // task types, so participants/routes.mjs's own POST /import never creates any), so an inner
    // JOIN here silently excluded every one of them from this list. Real bug, not a hypothetical:
    // a researcher running a non-PR-review study couldn't see their own imported participants at
    // all. Guarded below (`r.SessionId != null`) so a sessionless participant gets an empty
    // `sessions: []` instead of a phantom row.
    const rows = await sql`
      SELECT p."ParticipantId", p."FirstName", p."LastName", p."ResearchId", p."IsTestParticipant",
             ps."SessionId", s."Name" AS "SessionName", ps."SequenceOrder", ps."IsFinished",
             ps."ExperimentalSessionId",
             prc."GitHubPrNumber" AS "PrNumber"
      FROM "Participant" p
      LEFT JOIN "ParticipantSession" ps ON ps."ParticipantGuid" = p."Guid"
      LEFT JOIN "Sessions" s ON s."Id" = ps."SessionId"
      LEFT JOIN "ResearchPrConfig" prc ON prc."Id" = ps."PrConfigId"
      WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
      ORDER BY p."ParticipantId", ps."SessionId"
    `;

    const byParticipant = new Map();
    for (const r of rows) {
      if (!byParticipant.has(r.ParticipantId)) {
        byParticipant.set(r.ParticipantId, {
          participantId: r.ParticipantId,
          firstName: r.FirstName,
          lastName: r.LastName,
          researchId: r.ResearchId,
          isTestParticipant: r.IsTestParticipant === true,
          sessions: [],
        });
      }
      if (r.SessionId != null) {
        byParticipant.get(r.ParticipantId).sessions.push({
          sessionId: r.SessionId,
          sessionName: r.SessionName,
          sequenceOrder: r.SequenceOrder,
          isFinished: r.IsFinished,
          // Null means this session was never tied to an Experimental Session — expected before
          // it's scheduled, but a warning sign if isFinished is also true (see participants-list's
          // warning marker: a session that was actually conducted without ever being scheduled).
          experimentalSessionId: r.ExperimentalSessionId,
          // Only set when this session has an explicit PR override (see PrAssignments import
          // sheet) — null means it falls back to the research's IsActive config at review time.
          prNumber: r.PrNumber,
        });
      }
    }
    res.json([...byParticipant.values()]);
  } catch (err) {
    console.error('[participants] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

const CODE_REVIEW_APP_URL = process.env.CODE_REVIEW_APP_URL || 'http://localhost:4202';
const CONSENT_APP_URL = process.env.CONSENT_APP_URL || 'http://localhost:4303';
const DEMOGRAPHIC_APP_URL = process.env.DEMOGRAPHIC_APP_URL || 'http://localhost:4305';
// Code Review's personal link is meant to be reused for the participant's whole study run
// (Intro, both experimental sessions, and every NASA-TLX handoff round-trip in between) —
// effectively permanent (2026-10-02 follow-up, was 90 days) so it never expires mid-study; a
// fixed far-future date rather than a nullable ExpiresAt, so every existing expiry check
// (`NOW() < ExpiresAt`) across every app keeps working completely unchanged.
const CODE_REVIEW_TOKEN_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// DEMOGRAPHIC is per-research-universal like REI40/BIGFIVE (the same questionnaire every
// participant in the research gets), so it belongs in this individually-regeneratable/listed set
// — unlike NASA_TLX/GENERIC_TASK, which are per-participant/standalone and deliberately excluded.
const LINK_TYPES = ['CODE_REVIEW', 'CONSENT_ENTRY', 'REI40', 'BIGFIVE', 'DEMOGRAPHIC'];

function linkUrlFor(type, token) {
  switch (type) {
    case 'CODE_REVIEW': return `${CODE_REVIEW_APP_URL}/?link=${token}`;
    case 'CONSENT_ENTRY': return `${CONSENT_APP_URL}/link/${token}`;
    case 'REI40': return `${REI40_APP_URL}/link/${token}`;
    case 'BIGFIVE': return `${BIGFIVE_APP_URL}/link/${token}`;
    case 'DEMOGRAPHIC': return `${DEMOGRAPHIC_APP_URL}/link/${token}`;
    default: return null;
  }
}

/**
 * Mints (or refreshes) a single CONSENT_ENTRY token for one participant and emails it — the
 * one-click researcher action this project previously lacked. Unlike the existing silent
 * "Generate" button next to the CONSENT_ENTRY row in the Links table below (POST
 * /:participantId/links/:type), this one also sends the branded email via the same
 * buildConsentLinkEmail template the bulk mailing-list flow already uses
 * (server/consent-form/mailing-list.mjs), so a researcher no longer has to copy/paste/share the
 * link themselves. Deliberately re-sendable even after consent was already given (e.g. the
 * participant lost the email) — consent-andrejkatin's own GET /api/link/:token already routes an
 * already-consented participant straight to /done, so there's nothing to guard against here.
 */
router.post('/:participantId/send-consent-email', async (req, res) => {
  const participantId = req.params.participantId;
  if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > MAX_ID_LENGTH) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }

  try {
    const sql = getDb();
    const participant = await resolveParticipantByBareId(sql, participantId);
    if (participant === AMBIGUOUS_PARTICIPANT) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!participant) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    const researchRows = await sql`
      SELECT "EmailSenderName", "StudyDisplayName", "Name" AS "ResearchName", "UsesConsentForm"
      FROM "Research" WHERE "Id" = ${participant.ResearchId} LIMIT 1
    `;
    const p = { ...participant, ...(researchRows[0] ?? {}) };

    try {
      resolveResearchScope(req.researcher, p.ResearchId);
    } catch (err) {
      if (err instanceof ScopeForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }

    if (!(p.UsesConsentForm ?? true)) {
      res.status(400).json({ error: 'CONSENT_NOT_USED' });
      return;
    }
    if (!p.Email) {
      res.status(400).json({ error: 'NO_EMAIL' });
      return;
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, ${p.Guid}, 'CONSENT_ENTRY', ${token}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;

    const url = `${CONSENT_APP_URL}/link/${token}`;
    const senderName = p.EmailSenderName ?? p.StudyDisplayName ?? p.ResearchName ?? undefined;
    const { subject, html } = buildConsentLinkEmail(p.Language ?? 'sr', { url, senderName });
    await sendMail({ to: p.Email, subject, html, fromName: senderName });

    res.json({ ok: true });
  } catch (err) {
    console.error('[participants] send-consent-email error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/**
 * Everything the Participant Detail page needs beyond the plain session badges already in
 * GET / — every personal link ever issued to this participant (any type, with its current
 * validity), plus a 6-step timeline computed from real data across every app this platform's
 * participants pass through (Consent, REI-40/Big Five, this participant's own ParticipantSession
 * rows, and the manually-set Baseline flag). A step whose instrument the research doesn't use at
 * all (UsesConsentForm/UsesPsychTests off) is marked 'skipped', not 'pending' — it will never
 * become done and shouldn't look stalled.
 */
router.get('/:participantId/overview', async (req, res) => {
  const participantId = req.params.participantId;
  if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > MAX_ID_LENGTH) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }

  try {
    const sql = getDb();
    const participant = await resolveParticipantByBareId(sql, participantId);
    if (participant === AMBIGUOUS_PARTICIPANT) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!participant) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    try {
      resolveResearchScope(req.researcher, participant.ResearchId);
    } catch (err) {
      if (err instanceof ScopeForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }

    const researchRows = await sql`
      SELECT "UsesConsentForm", "UsesPsychTests" FROM "Research" WHERE "Id" = ${participant.ResearchId} LIMIT 1
    `;
    const usesConsentForm = researchRows[0]?.UsesConsentForm ?? true;
    const usesPsychTests = researchRows[0]?.UsesPsychTests ?? true;

    const tokenRows = await sql`
      SELECT "SurveyType", "Token", "ExpiresAt", "CreatedAt" FROM "SurveyAccessToken"
      WHERE "ParticipantGuid" = ${participant.Guid} AND "SurveyType" = ANY(${LINK_TYPES})
      ORDER BY "CreatedAt" DESC
    `;
    const rei40Rows = await sql`SELECT "CompletedAt" FROM "Rei40Result" WHERE "ParticipantGuid" = ${participant.Guid} LIMIT 1`;
    const bigfiveRows = await sql`SELECT "CompletedAt" FROM "BigFiveResult" WHERE "ParticipantGuid" = ${participant.Guid} LIMIT 1`;
    const sessionRows = await sql`
      SELECT ps."SessionId", ps."SequenceOrder", ps."IsFinished", ps."FinishedAt", ps."ExperimentalSessionId",
             es."SessionDate", es."Label" AS "ExperimentalSessionLabel", ps."ScheduledTime",
             ps."GoogleCalendarEventId", ps."GoogleCalendarEventUrl"
      FROM "ParticipantSession" ps
      LEFT JOIN "ExperimentalSession" es ON es."Id" = ps."ExperimentalSessionId"
      WHERE ps."ParticipantGuid" = ${participant.Guid}
      ORDER BY ps."SequenceOrder" NULLS LAST, ps."SessionId"
    `;

    const now = new Date();
    const links = tokenRows.map((t) => {
      const expired = new Date(t.ExpiresAt) < now;
      return {
        type: t.SurveyType,
        url: linkUrlFor(t.SurveyType, t.Token),
        createdAt: t.CreatedAt,
        expiresAt: t.ExpiresAt,
        status: expired ? 'expired' : 'valid',
      };
    });

    // Fixed-session test participants (IsTestParticipant + TestFixedSessionId set — 001-004 in
    // the seeded Pilot research) only ever have ONE ParticipantSession row, always at
    // SequenceOrder=1 — they never go through Consent/REI-40/Big Five for real, and their single
    // row never matches the SequenceOrder===2/3 lookups a normal participant's rows would. Without
    // this branch, every step before their fixed session falls through to the generic "first
    // not-done step is current" rule and gets stuck there forever (e.g. a test participant fixed
    // on the AI session would show "currently filling in REI-40/Big Five" even while actually
    // running a real AI review) — reported directly by the researcher testing this. A plain
    // participant (005, TestFixedSessionId null) is unaffected and still computed from real data.
    const isFixedTestParticipant = participant.IsTestParticipant === true && participant.TestFixedSessionId != null;
    const testOwnSession = isFixedTestParticipant
      ? sessionRows.find((s) => s.SessionId === participant.TestFixedSessionId) ?? null
      : null;
    // Intro (SessionId=1) stands for the 'intro' step; AI/Report/Hybrid (2/3/4) all stand in for
    // 'experimentalSession1' — there is no second fixed test session, so experimentalSession2
    // naturally stays unreached for every fixed test participant.
    const testTargetStepKey = isFixedTestParticipant
      ? (participant.TestFixedSessionId === 1 ? 'intro' : 'experimentalSession1')
      : null;

    const introSession = isFixedTestParticipant
      ? (participant.TestFixedSessionId === 1 ? testOwnSession : null)
      : sessionRows.find((s) => s.SessionId === 1) ?? null;
    const secondSession = isFixedTestParticipant
      ? (participant.TestFixedSessionId !== 1 ? testOwnSession : null)
      : sessionRows.find((s) => s.SequenceOrder === 2) ?? null;
    const thirdSession = isFixedTestParticipant ? null : sessionRows.find((s) => s.SequenceOrder === 3) ?? null;
    const scheduled = !!(secondSession?.ExperimentalSessionId && thirdSession?.ExperimentalSessionId);

    // done | current | pending | skipped — 'current' is the first non-done, non-skipped step;
    // everything after it is 'pending' regardless of its own data (a later step can't legitimately
    // be done before an earlier one is, in this study design).
    const stepDefs = [
      { key: 'consent', skip: !usesConsentForm, done: !!participant.ConsentGivenAt, at: participant.ConsentGivenAt },
      { key: 'questionnaires', skip: !usesPsychTests, done: !!rei40Rows.length && !!bigfiveRows.length, at: rei40Rows[0]?.CompletedAt && bigfiveRows[0]?.CompletedAt ? [rei40Rows[0].CompletedAt, bigfiveRows[0].CompletedAt].sort().pop() : null },
      { key: 'intro', skip: false, done: !!introSession?.IsFinished, at: introSession?.FinishedAt ?? null },
      {
        key: 'scheduled',
        skip: false,
        done: scheduled,
        // The 'scheduled' step's own 'at' is when the FIRST experimental session is set to
        // happen (not a completion time, but the one piece of scheduling info most worth
        // surfacing right there in the timeline) — combines the date-only column (through the
        // same dateOnly() fix used everywhere else on this column, see its own doc comment) with
        // the plain 'HH:MM:SS' TIME value Postgres already hands back as a string.
        at: scheduled && secondSession?.SessionDate
          ? `${dateOnly(secondSession.SessionDate)}T${secondSession.ScheduledTime ?? '00:00:00'}`
          : null,
      },
      { key: 'experimentalSession1', skip: !secondSession, done: !!secondSession?.IsFinished, at: secondSession?.FinishedAt ?? null },
      { key: 'experimentalSession2', skip: !thirdSession, done: !!thirdSession?.IsFinished, at: thirdSession?.FinishedAt ?? null },
    ];
    const testTargetIndex = isFixedTestParticipant ? stepDefs.findIndex((s) => s.key === testTargetStepKey) : -1;
    let currentAssigned = false;
    const timeline = stepDefs.map((s, i) => {
      if (s.skip) return { step: s.key, status: 'skipped', at: null };
      if (s.done) return { step: s.key, status: 'done', at: s.at };
      if (isFixedTestParticipant) {
        // Everything before the fixed session's own step was never really entered by this test
        // participant — show it as bypassed, not as a stalled "current"/"pending" step.
        if (i < testTargetIndex) return { step: s.key, status: 'skipped', at: null };
        if (i === testTargetIndex) {
          currentAssigned = true;
          return { step: s.key, status: 'current', at: null };
        }
        return { step: s.key, status: 'pending', at: null };
      }
      if (!currentAssigned) {
        currentAssigned = true;
        return { step: s.key, status: 'current', at: null };
      }
      return { step: s.key, status: 'pending', at: null };
    });

    res.json({
      participantId: participant.ParticipantId,
      isTestParticipant: participant.IsTestParticipant === true,
      baselineDoneAt: participant.BaselineDoneAt ?? null,
      hasEmail: !!participant.Email,
      links,
      timeline,
      scheduling: {
        // dateOnly() avoids the documented local-timezone DATE round-trip shift (see that
        // helper's own comment) — this block previously serialized the raw Date object, which
        // JSON.stringify would have silently shown as the wrong calendar day.
        // id/label let the Participant Detail page link straight to this Experimental Session's
        // own detail page; googleCalendarEventId/Url mirror what that detail page already shows
        // per row, so the same sync status is visible from both sides (2026-10-01 follow-up).
        experimentalSession1: secondSession ? {
          date: dateOnly(secondSession.SessionDate), time: secondSession.ScheduledTime,
          id: secondSession.ExperimentalSessionId, label: secondSession.ExperimentalSessionLabel ?? null,
          googleCalendarEventId: secondSession.GoogleCalendarEventId ?? null,
          googleCalendarEventUrl: secondSession.GoogleCalendarEventUrl ?? null,
        } : null,
        experimentalSession2: thirdSession ? {
          date: dateOnly(thirdSession.SessionDate), time: thirdSession.ScheduledTime,
          id: thirdSession.ExperimentalSessionId, label: thirdSession.ExperimentalSessionLabel ?? null,
          googleCalendarEventId: thirdSession.GoogleCalendarEventId ?? null,
          googleCalendarEventUrl: thirdSession.GoogleCalendarEventUrl ?? null,
        } : null,
      },
    });
  } catch (err) {
    console.error('[participants] overview error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * Generates (or regenerates) one specific personal link, without sending an email — the
 * researcher copies/shares it themselves from the Participant Detail page. Unlike
 * /regenerate-links (which reissues everything a participant's research uses, by email), this
 * targets exactly one link type at a time.
 */
router.post('/:participantId/links/:type', async (req, res) => {
  const participantId = req.params.participantId;
  const type = req.params.type;
  if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > MAX_ID_LENGTH) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }
  if (!LINK_TYPES.includes(type)) {
    res.status(400).json({ error: 'Invalid link type' });
    return;
  }

  try {
    const sql = getDb();
    const participant = await resolveParticipantByBareId(sql, participantId);
    if (participant === AMBIGUOUS_PARTICIPANT) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!participant) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    try {
      resolveResearchScope(req.researcher, participant.ResearchId);
    } catch (err) {
      if (err instanceof ScopeForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }

    // Bug fix (2026-10-02): this generic per-type "Generate" button minted a token for ANY type
    // in LINK_TYPES with no check against the research's own toggles — a researcher could
    // generate a DEMOGRAPHIC (or REI40/BIGFIVE) link for a research that doesn't use that
    // instrument at all, producing a real link into a questionnaire with zero configured
    // questions (confirmed live: exactly this happened for a participant on a
    // UsesDemographics=false research). regenerate-links already gated these correctly; this
    // route needed the same check.
    if (type === 'REI40' || type === 'BIGFIVE' || type === 'DEMOGRAPHIC') {
      const researchRows = await sql`
        SELECT "UsesPsychTests", "UsesDemographics" FROM "Research" WHERE "Id" = ${participant.ResearchId} LIMIT 1
      `;
      const r = researchRows[0] ?? {};
      const applicable =
        type === 'DEMOGRAPHIC' ? (r.UsesDemographics ?? false) : (r.UsesPsychTests ?? true);
      if (!applicable) {
        res.status(400).json({ error: 'NOT_APPLICABLE' });
        return;
      }
    }

    const token = generateToken();
    const ttlMs = type === 'CODE_REVIEW' ? CODE_REVIEW_TOKEN_TTL_MS : TOKEN_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await sql`
      INSERT INTO "SurveyAccessToken" ("ParticipantId", "ParticipantGuid", "SurveyType", "Token", "ExpiresAt")
      VALUES (${participantId}, ${participant.Guid}, ${type}, ${token}, ${expiresAt})
      ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
        "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
    `;
    res.json({ type, url: linkUrlFor(type, token), createdAt: new Date().toISOString(), expiresAt, status: 'valid' });
  } catch (err) {
    console.error('[participants] link generate error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/** Marks (or clears) the Baseline EEG step for Experimental Session 1 — recorded manually by the
 *  researcher (done in the lab, not through any app), so there's nothing automatic to detect it. */
router.post('/:participantId/baseline', async (req, res) => {
  await setBaseline(req, res, true);
});
router.delete('/:participantId/baseline', async (req, res) => {
  await setBaseline(req, res, false);
});

async function setBaseline(req, res, done) {
  const participantId = req.params.participantId;
  if (typeof participantId !== 'string' || !participantId.trim() || participantId.length > MAX_ID_LENGTH) {
    res.status(400).json({ error: 'Invalid participant id' });
    return;
  }
  try {
    const sql = getDb();
    const participant = await resolveParticipantByBareId(sql, participantId);
    if (participant === AMBIGUOUS_PARTICIPANT) {
      res.status(409).json({ error: 'AMBIGUOUS_PARTICIPANT_ID' });
      return;
    }
    if (!participant) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    try {
      resolveResearchScope(req.researcher, participant.ResearchId);
    } catch (err) {
      if (err instanceof ScopeForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      throw err;
    }
    const rows = await sql`
      UPDATE "Participant" SET "BaselineDoneAt" = ${done ? new Date().toISOString() : null}
      WHERE "Guid" = ${participant.Guid}
      RETURNING "BaselineDoneAt"
    `;
    res.json({ baselineDoneAt: rows[0]?.BaselineDoneAt ?? null });
  } catch (err) {
    console.error('[participants] baseline error:', err);
    res.status(500).json({ error: 'Database error' });
  }
}

function isValidName(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= MAX_NAME_LENGTH);
}

function isValidEmail(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= MAX_EMAIL_LENGTH);
}

function isValidLanguage(v) {
  return v === null || v === undefined || v === 'sr' || v === 'en';
}

const SESSION_ID_BY_NAME = { AI: 2, REPORT: 3 };

/**
 * Imports from an Excel workbook parsed client-side (see ExcelImportService): a "Participants"
 * sheet (new participants — ParticipantId/FirstName/LastName/Email/Language; existing ones are
 * skipped untouched) and a "Tasks" sheet (one row per participant+AI-or-Report session, each with
 * the PR to review). Any list may be empty; at least one must be non-empty. Everything here is
 * idempotent, so re-uploading the same file is always safe.
 *
 * The Intro session is never listed in the Tasks sheet — it's inserted automatically as
 * SequenceOrder 1 the first time a participant gets any session at all. AI/Report's relative
 * order (SequenceOrder 2 vs 3) is NOT a column — it's derived from which of the two appears
 * FIRST for that participant in the sheet's row order, letting a researcher pick per-participant
 * counterbalancing just by how they order the rows, rather than an explicit enum column.
 */
router.post('/import', async (req, res) => {
  const { researchId, participants, tasks } = req.body ?? {};

  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'researchId must be a positive integer' });
    return;
  }

  const participantsIn = Array.isArray(participants) ? participants : [];
  const tasksIn = Array.isArray(tasks) ? tasks : [];

  if (participantsIn.length === 0 && tasksIn.length === 0) {
    res.status(400).json({ error: 'At least one of participants or tasks must be provided' });
    return;
  }
  if (participantsIn.length > MAX_IMPORT_BATCH || tasksIn.length > MAX_IMPORT_BATCH) {
    res.status(400).json({ error: `Each list must have at most ${MAX_IMPORT_BATCH} rows` });
    return;
  }
  for (const p of participantsIn) {
    if (typeof p?.participantId !== 'string' || !p.participantId.trim() || p.participantId.length > MAX_ID_LENGTH) {
      res.status(400).json({ error: 'Each participants[] entry needs a valid participantId' });
      return;
    }
    if (!isValidName(p.firstName) || !isValidName(p.lastName)) {
      res.status(400).json({ error: 'participants[].firstName/lastName must be strings up to 100 chars, or null' });
      return;
    }
    if (!isValidEmail(p.email)) {
      res.status(400).json({ error: `participants[].email must be a string up to ${MAX_EMAIL_LENGTH} chars, or null` });
      return;
    }
    if (!isValidLanguage(p.language)) {
      res.status(400).json({ error: 'participants[].language must be "sr", "en", or null' });
      return;
    }
    if (!isValidName(p.genericTask)) {
      res.status(400).json({ error: 'participants[].genericTask must be a string up to 100 chars, or null' });
      return;
    }
  }
  for (const t of tasksIn) {
    if (typeof t?.participantId !== 'string' || !t.participantId.trim() || t.participantId.length > MAX_ID_LENGTH) {
      res.status(400).json({ error: 'Each tasks[] entry needs a valid participantId' });
      return;
    }
    if (!(t.session in SESSION_ID_BY_NAME)) {
      res.status(400).json({ error: 'tasks[].session must be AI or REPORT' });
      return;
    }
    if (typeof t.taskLabel !== 'string' || !t.taskLabel.trim()) {
      res.status(400).json({ error: 'tasks[].taskLabel must be a non-empty string' });
      return;
    }
  }

  try {
    resolveResearchScope(req.researcher, researchId);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const imported = [];
  const skippedExisting = [];
  const introAdded = [];
  const assigned = [];
  const errors = [];
  // Tracks each participant's *actual* ResearchId (existing or just-set) so the Tasks sheet
  // can never silently attach a session row to a participant from a different research.
  const participantResearchId = new Map();
  // Item 1 of the "platform improvements round 2" plan — also tracks each participant's Guid, so
  // the ParticipantSession inserts below can pass it explicitly instead of relying on the
  // set_participant_guid trigger's own bare-ParticipantId resolution, which would (correctly)
  // refuse to guess once this id is ambiguous across researches — even though THIS import already
  // knows exactly which research's participant it means.
  const participantGuid = new Map();

  try {
    const sql = getDb();

    // Generic Task assignment (2026-09-11) — resolved once up front by title, same "only applied
    // on INSERT for a brand-new participant" rule as Email/Language below. A title that doesn't
    // match any of this research's tasks is silently ignored (not assigned) rather than failing
    // the whole import — the Excel template's own dropdown + parseFile's client-side cross-check
    // already catch a typo'd title before it gets this far in the normal flow.
    const genericTaskRows = await sql`SELECT "Id", "Title" FROM "GenericTask" WHERE "ResearchId" = ${researchId}`;
    const genericTaskIdByTitle = new Map(genericTaskRows.map((r) => [r.Title, r.Id]));

    const seenParticipantIds = new Set();
    for (const p of participantsIn) {
      const id = p.participantId.trim();
      if (seenParticipantIds.has(id)) continue;
      seenParticipantIds.add(id);

      // Item 1 of the "platform improvements round 2" plan — ParticipantId is scoped per research
      // now (UNIQUE("ResearchId","ParticipantId"), not globally), so "does this participant
      // already exist" must be scoped to THIS import's researchId too. A researcher importing
      // "001" into research B when "001" already exists under research A now correctly inserts a
      // brand-new, distinct participant for B instead of being silently treated as already
      // existing (and attached to A) the way a global lookup would have.
      const existingRows = await sql`
        SELECT "ResearchId", "Guid" FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantId" = ${id} LIMIT 1
      `;
      if (existingRows.length > 0) {
        skippedExisting.push(id);
        participantResearchId.set(id, existingRows[0].ResearchId);
        participantGuid.set(id, existingRows[0].Guid);
      } else {
        const genericTaskId = p.genericTask ? (genericTaskIdByTitle.get(p.genericTask) ?? null) : null;
        const inserted = await sql`
          INSERT INTO "Participant" ("ParticipantId", "ResearchId", "FirstName", "LastName", "Email", "Language", "GenericTaskId")
          VALUES (${id}, ${researchId}, ${p.firstName ?? null}, ${p.lastName ?? null}, ${p.email ?? null}, ${p.language ?? null}, ${genericTaskId})
          ON CONFLICT ("ResearchId", "ParticipantId") DO NOTHING
          RETURNING "Guid"
        `;
        imported.push(id);
        participantResearchId.set(id, researchId);
        if (inserted.length) participantGuid.set(id, inserted[0].Guid);
      }
    }

    // Group Tasks rows by participant, preserving their original sheet order — that order is
    // what decides AI-vs-Report SequenceOrder for each participant (see doc comment above).
    const seenTaskKeys = new Set();
    const tasksByParticipant = new Map();
    for (const t of tasksIn) {
      const id = t.participantId.trim();
      const key = `${id}:${t.session}`;
      if (seenTaskKeys.has(key)) continue;
      seenTaskKeys.add(key);
      if (!tasksByParticipant.has(id)) tasksByParticipant.set(id, []);
      tasksByParticipant.get(id).push(t);
    }

    for (const [id, participantTasks] of tasksByParticipant) {
      if (!participantResearchId.has(id)) {
        // Scoped to this import's researchId (see the same note on the Participants-sheet loop
        // above) — a Tasks row is only ever meaningful against the participant belonging to THIS
        // research, never a same-id participant that happens to exist under a different one.
        const rows = await sql`
          SELECT "ResearchId", "Guid" FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantId" = ${id} LIMIT 1
        `;
        if (rows.length > 0) {
          participantResearchId.set(id, rows[0].ResearchId);
          participantGuid.set(id, rows[0].Guid);
        }
      }

      const actualResearchId = participantResearchId.get(id);
      if (actualResearchId === undefined) {
        // Stable reason codes (not free text) so the frontend can render a translated message.
        for (const t of participantTasks) errors.push({ participantId: id, reasonCode: 'NOT_FOUND' });
        continue;
      }
      if (actualResearchId !== researchId) {
        for (const t of participantTasks) errors.push({ participantId: id, reasonCode: 'WRONG_RESEARCH' });
        continue;
      }

      // Scoped to this import's researchId — ParticipantSession denormalizes ResearchId
      // specifically so reads like this stay correct now that a same-ParticipantId row could
      // exist under a different research too (item 1 of the "platform improvements round 2" plan).
      const existing = await sql`
        SELECT "SessionId", "SequenceOrder" FROM "ParticipantSession"
        WHERE "ParticipantId" = ${id} AND "ResearchId" = ${researchId}
      `;
      const usedSeqs = new Set(existing.map((r) => r.SequenceOrder));
      const existingSessionIds = new Set(existing.map((r) => r.SessionId));

      // Conflict target is (ParticipantGuid, SessionId) — supplied explicitly here (rather than
      // left for the set_participant_guid trigger to resolve from the bare ParticipantId) since
      // this import already knows exactly which research's participant it means, and the trigger
      // would otherwise correctly refuse to guess once this id is ambiguous across researches.
      const guid = participantGuid.get(id);
      if (usedSeqs.size === 0) {
        await sql`
          INSERT INTO "ParticipantSession" ("ParticipantId", "ParticipantGuid", "SessionId", "ResearchId", "SequenceOrder")
          VALUES (${id}, ${guid}, 1, ${researchId}, 1)
          ON CONFLICT ("ParticipantGuid", "SessionId") DO NOTHING
        `;
        usedSeqs.add(1);
        introAdded.push(id);
      }

      for (const t of participantTasks) {
        const sessionId = SESSION_ID_BY_NAME[t.session];

        if (!existingSessionIds.has(sessionId)) {
          const nextSeq = usedSeqs.has(2) ? 3 : 2;
          await sql`
            INSERT INTO "ParticipantSession" ("ParticipantId", "ParticipantGuid", "SessionId", "ResearchId", "SequenceOrder")
            VALUES (${id}, ${guid}, ${sessionId}, ${researchId}, ${nextSeq})
            ON CONFLICT ("ParticipantGuid", "SessionId") DO NOTHING
          `;
          usedSeqs.add(nextSeq);
          existingSessionIds.add(sessionId);
        }

        // Labels are unique per research (UX_ResearchPrConfig_LabelPerResearch) — a straight
        // lookup, no tie-break needed. The Intro task's own label deliberately never matches here
        // either (it's excluded from the Excel dropdown, but a hand-typed value is still just a
        // normal lookup — if it happens to equal the Intro label, it resolves to that same config
        // row, which is harmless since GetPrConfigForParticipantAsync already treats an explicit
        // PrConfigId as the correct override regardless of IsIntro).
        const configRows = await sql`
          SELECT "Id" FROM "ResearchPrConfig"
          WHERE "ResearchId" = ${researchId} AND "Label" = ${t.taskLabel.trim()}
          LIMIT 1
        `;
        if (configRows.length === 0) {
          errors.push({ participantId: id, reasonCode: 'TASK_NOT_FOUND' });
          continue;
        }

        const updated = await sql`
          UPDATE "ParticipantSession" SET "PrConfigId" = ${configRows[0].Id}
          WHERE "ParticipantId" = ${id} AND "SessionId" = ${sessionId} AND "ResearchId" = ${researchId}
          RETURNING "ParticipantId"
        `;
        if (updated.length === 0) {
          errors.push({ participantId: id, reasonCode: 'SESSION_NOT_FOUND' });
          continue;
        }
        assigned.push(id);
      }
    }

    res.json({
      participants: { imported, skippedExisting },
      tasks: { introAdded, assigned, errors },
    });

    // Fire-and-forget notification fan-out — must never surface to the importing researcher as
    // a failed import (exact same post-response, own-try/catch pattern as Google Calendar sync
    // in experimental-sessions/routes.mjs). Only notify if this import actually added something.
    if (imported.length > 0 || introAdded.length > 0 || assigned.length > 0) {
      (async () => {
        try {
          const researchRows = await sql`SELECT "Name" FROM "Research" WHERE "Id" = ${researchId} LIMIT 1`;
          const researchName = researchRows[0]?.Name ?? '';
          const actorName = `${req.researcher.firstName ?? ''} ${req.researcher.lastName ?? ''}`.trim();
          await notifyResearchMembers(sql, {
            researchId,
            type: 'PARTICIPANT_IMPORT',
            actorResearcherId: req.researcher.id,
            buildMessage: (lang) =>
              lang === 'en'
                ? `${actorName} imported a participant list into "${researchName}" (${imported.length} new participant(s)).`
                : `${actorName} je uvezao/la listu učesnika u istraživanje „${researchName}" (${imported.length} novih učesnika).`,
          });
        } catch (notifyErr) {
          console.error('[participants] notification fan-out failed:', notifyErr);
        }
      })();
    }
  } catch (err) {
    console.error('[participants] import error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
