import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { toAggregateResponse } from './aggregate.mjs';
import { toCsv } from './csv.mjs';

const router = Router();
router.use(requireAuth);

const TLX_DIMENSIONS = [
  'MentalDemand', 'PhysicalDemand', 'TemporalDemand', 'Performance', 'Effort', 'Frustration',
  'RawTLX', 'WeightedTLX',
];
const REI40_DIMENSIONS = [
  'RationalAbility', 'RationalEngagement', 'ExperientialAbility', 'ExperientialEngagement',
  'Rationality', 'Experientiality',
];
const BIGFIVE_DIMENSIONS = ['Openness', 'Conscientiousness', 'Extraversion', 'Agreeableness', 'Neuroticism'];

/**
 * Reads and validates the scope (researchId, enforced via scope.mjs — never trusted raw)
 * and the optional participantId filter shared by every results route. Returns null (having
 * already written the 403 response) if the requested scope is forbidden.
 */
function readScopeAndFilters(req, res) {
  let researchId;
  try {
    researchId = resolveResearchScope(req.researcher, req.query.researchId);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return null;
    }
    throw err;
  }
  const participantId =
    typeof req.query.participantId === 'string' && req.query.participantId.trim()
      ? req.query.participantId.trim()
      : null;
  return { researchId, participantId };
}

// ── NASA-TLX ────────────────────────────────────────────────────────────

router.get('/tlx', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    if (req.query.mode === 'aggregate') {
      const rows = await sql`
        SELECT COUNT(*)::int AS count,
          AVG(t."MentalDemand") AS "MentalDemand_avg", STDDEV_SAMP(t."MentalDemand") AS "MentalDemand_stddev",
          AVG(t."PhysicalDemand") AS "PhysicalDemand_avg", STDDEV_SAMP(t."PhysicalDemand") AS "PhysicalDemand_stddev",
          AVG(t."TemporalDemand") AS "TemporalDemand_avg", STDDEV_SAMP(t."TemporalDemand") AS "TemporalDemand_stddev",
          AVG(t."Performance") AS "Performance_avg", STDDEV_SAMP(t."Performance") AS "Performance_stddev",
          AVG(t."Effort") AS "Effort_avg", STDDEV_SAMP(t."Effort") AS "Effort_stddev",
          AVG(t."Frustration") AS "Frustration_avg", STDDEV_SAMP(t."Frustration") AS "Frustration_stddev",
          AVG(t."RawTLX") AS "RawTLX_avg", STDDEV_SAMP(t."RawTLX") AS "RawTLX_stddev",
          AVG(t."WeightedTLX") AS "WeightedTLX_avg", STDDEV_SAMP(t."WeightedTLX") AS "WeightedTLX_stddev"
        FROM "TlxResult" t
        JOIN "Participant" p ON p."Guid" = t."ParticipantGuid"
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR t."ParticipantId" = ${participantId})
      `;
      res.json(toAggregateResponse(rows[0], TLX_DIMENSIONS));
    } else {
      // LEFT JOIN PostSessionResponse (2026-10-01) — the post-session questionnaire's answers,
      // one per participant per session, surfaced inline as a "dopunski podaci" (additional
      // data) action on this same row in Participant Detail rather than a separate Results page.
      // null when the participant hasn't reached/submitted it yet.
      //
      // TlxResult."SessionId" is NASA-TLX's own display-name string (e.g. "Uvodna sesija"), NOT
      // the shared "Sessions" table's numeric id that PostSessionResponse.SessionId (and
      // ParticipantSession/HybridSectionEngagement) key on — the CASE below bridges the two,
      // mirroring Nasa-TLX-FullImplementation-AndrejKatin's own DB_SESSION_TO_TLX mapping
      // (utils/study.ts) exactly. "DbSessionId" is also selected so the frontend modal can pick
      // Q4's session-type-specific wording without re-deriving this mapping itself.
      const rows = await sql`
        SELECT t."ParticipantId", t."SessionId", t."Language", t."MentalDemand", t."PhysicalDemand",
               t."TemporalDemand", t."Performance", t."Effort", t."Frustration",
               t."RawTLX", t."WeightedTLX", t."CompletedAt",
               CASE t."SessionId"
                 WHEN 'Uvodna sesija' THEN 1
                 WHEN 'Sesija 1' THEN 2
                 WHEN 'Sesija 2' THEN 3
                 WHEN 'Hibridna sesija' THEN 4
               END AS "DbSessionId",
               psr."Answers" AS "PostSessionAnswers"
        FROM "TlxResult" t
        JOIN "Participant" p ON p."Guid" = t."ParticipantGuid"
        LEFT JOIN "PostSessionResponse" psr
          ON psr."ParticipantGuid" = t."ParticipantGuid"
          AND psr."SessionId" = CASE t."SessionId"
            WHEN 'Uvodna sesija' THEN 1
            WHEN 'Sesija 1' THEN 2
            WHEN 'Sesija 2' THEN 3
            WHEN 'Hibridna sesija' THEN 4
          END
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR t."ParticipantId" = ${participantId})
        ORDER BY t."CompletedAt" DESC
      `;
      res.json(rows);
    }
  } catch (err) {
    console.error('[results] tlx error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/tlx/export', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT t.* FROM "TlxResult" t
      JOIN "Participant" p ON p."Guid" = t."ParticipantGuid"
      WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
        AND (${participantId}::text IS NULL OR t."ParticipantId" = ${participantId})
      ORDER BY t."CompletedAt" DESC
    `;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="tlx-results.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    console.error('[results] tlx export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── REI-40 ──────────────────────────────────────────────────────────────

router.get('/rei40', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    if (req.query.mode === 'aggregate') {
      const rows = await sql`
        SELECT COUNT(*)::int AS count,
          AVG(r."RationalAbility") AS "RationalAbility_avg", STDDEV_SAMP(r."RationalAbility") AS "RationalAbility_stddev",
          AVG(r."RationalEngagement") AS "RationalEngagement_avg", STDDEV_SAMP(r."RationalEngagement") AS "RationalEngagement_stddev",
          AVG(r."ExperientialAbility") AS "ExperientialAbility_avg", STDDEV_SAMP(r."ExperientialAbility") AS "ExperientialAbility_stddev",
          AVG(r."ExperientialEngagement") AS "ExperientialEngagement_avg", STDDEV_SAMP(r."ExperientialEngagement") AS "ExperientialEngagement_stddev",
          AVG(r."Rationality") AS "Rationality_avg", STDDEV_SAMP(r."Rationality") AS "Rationality_stddev",
          AVG(r."Experientiality") AS "Experientiality_avg", STDDEV_SAMP(r."Experientiality") AS "Experientiality_stddev"
        FROM "Rei40Result" r
        JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR r."ParticipantId" = ${participantId})
      `;
      res.json(toAggregateResponse(rows[0], REI40_DIMENSIONS));
    } else {
      const rows = await sql`
        SELECT r."ParticipantId", r."Language", r."RationalAbility", r."RationalEngagement",
               r."ExperientialAbility", r."ExperientialEngagement", r."Rationality", r."Experientiality",
               r."Variant", r."Answers", r."CompletedAt"
        FROM "Rei40Result" r
        JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR r."ParticipantId" = ${participantId})
        ORDER BY r."CompletedAt" DESC
      `;
      res.json(rows);
    }
  } catch (err) {
    console.error('[results] rei40 error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/rei40/export', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT r."ParticipantId", r."Language", r."RationalAbility", r."RationalEngagement",
             r."ExperientialAbility", r."ExperientialEngagement", r."Rationality", r."Experientiality",
             r."Variant", r."CompletedAt"
      FROM "Rei40Result" r
      JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
      WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
        AND (${participantId}::text IS NULL OR r."ParticipantId" = ${participantId})
      ORDER BY r."CompletedAt" DESC
    `;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rei40-results.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    console.error('[results] rei40 export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Big Five ────────────────────────────────────────────────────────────

router.get('/bigfive', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    if (req.query.mode === 'aggregate') {
      const rows = await sql`
        SELECT COUNT(*)::int AS count,
          AVG(b."Openness") AS "Openness_avg", STDDEV_SAMP(b."Openness") AS "Openness_stddev",
          AVG(b."Conscientiousness") AS "Conscientiousness_avg", STDDEV_SAMP(b."Conscientiousness") AS "Conscientiousness_stddev",
          AVG(b."Extraversion") AS "Extraversion_avg", STDDEV_SAMP(b."Extraversion") AS "Extraversion_stddev",
          AVG(b."Agreeableness") AS "Agreeableness_avg", STDDEV_SAMP(b."Agreeableness") AS "Agreeableness_stddev",
          AVG(b."Neuroticism") AS "Neuroticism_avg", STDDEV_SAMP(b."Neuroticism") AS "Neuroticism_stddev"
        FROM "BigFiveResult" b
        JOIN "Participant" p ON p."Guid" = b."ParticipantGuid"
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR b."ParticipantId" = ${participantId})
      `;
      res.json(toAggregateResponse(rows[0], BIGFIVE_DIMENSIONS));
    } else {
      const rows = await sql`
        SELECT b."ParticipantId", b."Language", b."Openness", b."Conscientiousness",
               b."Extraversion", b."Agreeableness", b."Neuroticism", b."Answers", b."CompletedAt"
        FROM "BigFiveResult" b
        JOIN "Participant" p ON p."Guid" = b."ParticipantGuid"
        WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
          AND (${participantId}::text IS NULL OR b."ParticipantId" = ${participantId})
        ORDER BY b."CompletedAt" DESC
      `;
      res.json(rows);
    }
  } catch (err) {
    console.error('[results] bigfive error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/bigfive/export', async (req, res) => {
  const scope = readScopeAndFilters(req, res);
  if (!scope) return;
  const { researchId, participantId } = scope;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT b."ParticipantId", b."Language", b."Openness", b."Conscientiousness",
             b."Extraversion", b."Agreeableness", b."Neuroticism", b."CompletedAt"
      FROM "BigFiveResult" b
      JOIN "Participant" p ON p."Guid" = b."ParticipantGuid"
      WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})
        AND (${participantId}::text IS NULL OR b."ParticipantId" = ${participantId})
      ORDER BY b."CompletedAt" DESC
    `;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bigfive-results.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    console.error('[results] bigfive export error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
