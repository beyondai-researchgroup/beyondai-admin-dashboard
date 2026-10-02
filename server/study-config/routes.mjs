// Per-research instrument configuration — consolidates what used to be scattered (EEG toggle
// on the Researches page, NASA-TLX's own manual /login checkboxes) into one place. Reads/
// writes columns added to "Research" in migration 007 (TlxCalculateScores/
// TlxIncludeWeightings/Rei40Variant), the pre-existing UsesEeg/EegDeviceType, and migration 018
// (UsesPsychTests/StudyDisplayName, Phase D of platform-ification), plus EmailSenderName and
// UsesConsentForm (platform-improvements/re-architecture rounds). This is a separate, narrower
// PUT than researches/routes.mjs's own — it never touches Name/Description/etc., so the
// Researches page and this page can't clobber each other's edits.
import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';

const router = Router();
router.use(requireAuth);

const MAX_EEG_DEVICE_LENGTH = 200;
const MAX_STUDY_DISPLAY_NAME_LENGTH = 200;
const MAX_EMAIL_SENDER_NAME_LENGTH = 150;
// Per-app participant timer (2026-09-11) — sane bounds, not enforced by any deeper reasoning
// than "a 3-hour countdown is clearly a config mistake, not a real study design."
const MIN_TIMER_MINUTES = 1;
const MAX_TIMER_MINUTES = 180;
const TIMER_APPS = ['CodeReview', 'Rei40', 'BigFive', 'NasaTlx'];
// 'v1' = full REI-40 (40 items, 4 facets). 'short' = a 10-item subset of the same REI-40 item pool
// (rei40-andrejkatin's data/rei40-short-items.ts) — not the official unpublished Norris/Pacini/
// Epstein REI-10, whose remaining 8/10 items were never publicly released. Adding a further
// variant means adding its own item-set/scoring file in the REI-40 app and appending its id here —
// the dropdown and validation both grow from this one list.
const REI40_VARIANTS = ['v1', 'short'];

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

// Once any participant in a research has actually submitted a REI result, that research's
// Rei40Variant can no longer be changed through this page — switching item-sets mid-research
// would mix incompatible answer sets under one variant label. Derived on every read/write rather
// than stored as its own column, so it can never drift out of sync with reality.
async function isRei40VariantLocked(sql, researchId) {
  const rows = await sql`
    SELECT 1 FROM "Rei40Result" r
    JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
    WHERE p."ResearchId" = ${researchId}
    LIMIT 1
  `;
  return rows.length > 0;
}

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "UsesEeg", "EegDeviceType", "TlxCalculateScores", "TlxIncludeWeightings", "Rei40Variant",
             "UsesPsychTests", "StudyDisplayName", "Name", "UsesTlx", "EmailSenderName", "UsesConsentForm",
             "UsesDemographics", "TracksParticipants", "ConsentLanguageSr", "ConsentLanguageEn",
             "TimerCodeReviewEnabled", "TimerCodeReviewMinutes", "TimerRei40Enabled", "TimerRei40Minutes",
             "TimerBigFiveEnabled", "TimerBigFiveMinutes", "TimerNasaTlxEnabled", "TimerNasaTlxMinutes"
      FROM "Research" WHERE "Id" = ${id} LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({
      usesEeg: r.UsesEeg,
      eegDeviceType: r.EegDeviceType,
      usesTlx: r.UsesTlx,
      tlxCalculateScores: r.TlxCalculateScores,
      tlxIncludeWeightings: r.TlxIncludeWeightings,
      rei40Variant: r.Rei40Variant,
      rei40Variants: REI40_VARIANTS,
      rei40VariantLocked: await isRei40VariantLocked(sql, id),
      usesPsychTests: r.UsesPsychTests,
      // Falls back to the research's own Name so the field is never blank in the UI/thank-you
      // email just because nobody has explicitly set a friendlier display name yet.
      studyDisplayName: r.StudyDisplayName ?? r.Name,
      // Optional override for the display-name portion of every participant-facing email this
      // research sends (consent, regenerate-links, thank-you) — null means "use the fallback
      // chain" (studyDisplayName, then Name, then the app-wide hardcoded default), resolved at
      // send time by each email builder, not here.
      emailSenderName: r.EmailSenderName,
      // Part C of the platform re-architecture (2026-09-07) — when off, the participant-facing
      // Consent app skips straight to a shared, non-per-participant "your links" screen instead
      // of the consent text/checkbox (see consent-andrejkatin's server.mjs), and this admin
      // dashboard's own Consent Form nav entry hides itself (nothing to configure).
      usesConsentForm: r.UsesConsentForm,
      // Demographic Questionnaire (2026-10-01) — gates both whether a DEMOGRAPHIC link/email is
      // ever issued (consent-andrejkatin/admin-dashboard's regenerate-links) and whether the
      // "Demografski upitnik"/"Demographic questions" nav entry + Results-menu item appear.
      usesDemographics: r.UsesDemographics,
      // 2026-09-08 follow-up — whether this research's Participants/Import/Experimental-Sessions
      // surface is even shown at all (forced true and un-editable for TaskType='PR_REVIEW', which
      // structurally requires participants; see task-config's own taskType for that check).
      tracksParticipants: r.TracksParticipants,
      // Which language(s) a participant is even offered at their very first Consent-app login —
      // at least one is always true (DB CHECK constraint). Both true = today's exact SR/EN picker
      // behavior; exactly one true = the picker is skipped and that language auto-locked.
      consentLanguageSr: r.ConsentLanguageSr,
      consentLanguageEn: r.ConsentLanguageEn,
      // Per-app participant timer (2026-09-11) — only offered in the UI for an app this research
      // actually uses (taskType==='PR_REVIEW' for Code Review; usesPsychTests for REI-40/Big
      // Five; usesTlx for NASA-TLX), but always returned here regardless — the frontend does the
      // gating, this endpoint stays a plain mirror of the columns like every other field here.
      timerCodeReviewEnabled: r.TimerCodeReviewEnabled,
      timerCodeReviewMinutes: r.TimerCodeReviewMinutes,
      timerRei40Enabled: r.TimerRei40Enabled,
      timerRei40Minutes: r.TimerRei40Minutes,
      timerBigFiveEnabled: r.TimerBigFiveEnabled,
      timerBigFiveMinutes: r.TimerBigFiveMinutes,
      timerNasaTlxEnabled: r.TimerNasaTlxEnabled,
      timerNasaTlxMinutes: r.TimerNasaTlxMinutes,
    });
  } catch (err) {
    console.error('[study-config] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const {
    usesEeg, eegDeviceType, usesTlx, tlxCalculateScores, tlxIncludeWeightings, rei40Variant,
    usesPsychTests, studyDisplayName, emailSenderName, usesConsentForm, usesDemographics,
    tracksParticipants, consentLanguageSr, consentLanguageEn,
    timerCodeReviewEnabled, timerCodeReviewMinutes, timerRei40Enabled, timerRei40Minutes,
    timerBigFiveEnabled, timerBigFiveMinutes, timerNasaTlxEnabled, timerNasaTlxMinutes,
  } = req.body ?? {};
  const timerValues = {
    CodeReview: [timerCodeReviewEnabled, timerCodeReviewMinutes],
    Rei40: [timerRei40Enabled, timerRei40Minutes],
    BigFive: [timerBigFiveEnabled, timerBigFiveMinutes],
    NasaTlx: [timerNasaTlxEnabled, timerNasaTlxMinutes],
  };
  if (typeof usesEeg !== 'boolean') {
    res.status(400).json({ error: 'usesEeg must be a boolean' });
    return;
  }
  if (typeof usesTlx !== 'boolean') {
    res.status(400).json({ error: 'usesTlx must be a boolean' });
    return;
  }
  if (eegDeviceType !== null && eegDeviceType !== undefined && (typeof eegDeviceType !== 'string' || eegDeviceType.length > MAX_EEG_DEVICE_LENGTH)) {
    res.status(400).json({ error: `eegDeviceType must be a string up to ${MAX_EEG_DEVICE_LENGTH} characters, or null` });
    return;
  }
  if (typeof tlxCalculateScores !== 'boolean' || typeof tlxIncludeWeightings !== 'boolean') {
    res.status(400).json({ error: 'tlxCalculateScores and tlxIncludeWeightings must be booleans' });
    return;
  }
  if (typeof rei40Variant !== 'string' || !REI40_VARIANTS.includes(rei40Variant)) {
    res.status(400).json({ error: `rei40Variant must be one of: ${REI40_VARIANTS.join(', ')}` });
    return;
  }
  if (typeof usesPsychTests !== 'boolean') {
    res.status(400).json({ error: 'usesPsychTests must be a boolean' });
    return;
  }
  if (typeof studyDisplayName !== 'string' || !studyDisplayName.trim() || studyDisplayName.length > MAX_STUDY_DISPLAY_NAME_LENGTH) {
    res.status(400).json({ error: `studyDisplayName is required (up to ${MAX_STUDY_DISPLAY_NAME_LENGTH} characters)` });
    return;
  }
  if (
    emailSenderName !== null &&
    emailSenderName !== undefined &&
    (typeof emailSenderName !== 'string' || emailSenderName.length > MAX_EMAIL_SENDER_NAME_LENGTH)
  ) {
    res.status(400).json({ error: `emailSenderName must be a string up to ${MAX_EMAIL_SENDER_NAME_LENGTH} characters, or null` });
    return;
  }
  if (typeof usesConsentForm !== 'boolean') {
    res.status(400).json({ error: 'usesConsentForm must be a boolean' });
    return;
  }
  if (typeof usesDemographics !== 'boolean') {
    res.status(400).json({ error: 'usesDemographics must be a boolean' });
    return;
  }
  if (typeof tracksParticipants !== 'boolean') {
    res.status(400).json({ error: 'tracksParticipants must be a boolean' });
    return;
  }
  if (typeof consentLanguageSr !== 'boolean' || typeof consentLanguageEn !== 'boolean') {
    res.status(400).json({ error: 'consentLanguageSr and consentLanguageEn must be booleans' });
    return;
  }
  if (!consentLanguageSr && !consentLanguageEn) {
    res.status(400).json({ error: 'At least one of consentLanguageSr/consentLanguageEn must be true' });
    return;
  }
  for (const app of TIMER_APPS) {
    const [enabled, minutes] = timerValues[app];
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: `timer${app}Enabled must be a boolean` });
      return;
    }
    if (enabled && (!Number.isInteger(minutes) || minutes < MIN_TIMER_MINUTES || minutes > MAX_TIMER_MINUTES)) {
      res.status(400).json({
        error: `timer${app}Minutes must be an integer between ${MIN_TIMER_MINUTES} and ${MAX_TIMER_MINUTES} when timer${app}Enabled is true`,
      });
      return;
    }
  }

  try {
    const sql = getDb();

    // A same-value resubmit is always fine even when locked (the form re-posts the whole
    // object on every save); only a genuine change to a different variant is rejected. Also
    // reads TaskType here (2026-09-08 follow-up) to enforce tracksParticipants server-side for a
    // PR-review research — that flow structurally requires participants, so this can never
    // actually be turned off regardless of what a client sends, mirroring the UI never even
    // offering the control there.
    const current = await sql`SELECT "Rei40Variant", "TaskType" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!current.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    if (current[0].Rei40Variant !== rei40Variant && (await isRei40VariantLocked(sql, id))) {
      res.status(409).json({ error: 'REI40_VARIANT_LOCKED' });
      return;
    }
    const effectiveTracksParticipants = current[0].TaskType === 'PR_REVIEW' ? true : tracksParticipants;

    const rows = await sql`
      UPDATE "Research"
      SET "UsesEeg" = ${usesEeg}, "EegDeviceType" = ${usesEeg ? (eegDeviceType ?? null) : null},
          "UsesTlx" = ${usesTlx},
          "TlxCalculateScores" = ${tlxCalculateScores}, "TlxIncludeWeightings" = ${tlxIncludeWeightings},
          "Rei40Variant" = ${rei40Variant}, "UsesPsychTests" = ${usesPsychTests},
          "StudyDisplayName" = ${studyDisplayName.trim()},
          "EmailSenderName" = ${emailSenderName?.trim() || null},
          "UsesConsentForm" = ${usesConsentForm},
          "UsesDemographics" = ${usesDemographics},
          "TracksParticipants" = ${effectiveTracksParticipants},
          "ConsentLanguageSr" = ${consentLanguageSr}, "ConsentLanguageEn" = ${consentLanguageEn},
          "TimerCodeReviewEnabled" = ${timerCodeReviewEnabled}, "TimerCodeReviewMinutes" = ${timerCodeReviewEnabled ? timerCodeReviewMinutes : null},
          "TimerRei40Enabled" = ${timerRei40Enabled}, "TimerRei40Minutes" = ${timerRei40Enabled ? timerRei40Minutes : null},
          "TimerBigFiveEnabled" = ${timerBigFiveEnabled}, "TimerBigFiveMinutes" = ${timerBigFiveEnabled ? timerBigFiveMinutes : null},
          "TimerNasaTlxEnabled" = ${timerNasaTlxEnabled}, "TimerNasaTlxMinutes" = ${timerNasaTlxEnabled ? timerNasaTlxMinutes : null}
      WHERE "Id" = ${id}
      RETURNING "Id"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[study-config] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
