import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { toCsv } from '../results/csv.mjs';

// Standardized export — Phase 5 of the modular-platform plan (2026-09-04). One common
// GET /:researchId/:instrumentCode/export shape across instruments, per the plan. Mounted at its
// own base path (/api/admin/results-export), deliberately separate from results/routes.mjs's
// existing query-param-scoped /tlx/export, /rei40/export, /bigfive/export routes rather than
// added into that same router — this project has hit the "route registered after a
// path-segment-colliding parameterized route silently steals its matches" bug class twice before
// (experimental-sessions/routes.mjs, task-config/routes.mjs's ordering comments); a fully
// separate router sidesteps that risk entirely rather than relying on getting registration order
// right. The existing bespoke routes are left completely untouched — zero regression risk to
// currently-relied-upon export links — this is purely additive.
//
// NASA_TLX/REI40/BIGFIVE deliberately duplicate (not share a function with) results/routes.mjs's
// row-fetching queries, rather than refactoring both to call one shared helper — a shared helper
// would mean any future edit to this new endpoint could silently change the old routes' behavior
// too, which is exactly the risk this phase is meant to avoid. Byte-identical output is verified
// directly (both routes' outputs diffed) rather than guaranteed by shared code.
const router = Router();
router.use(requireAuth);

const INSTRUMENT_CODES = ['NASA_TLX', 'REI40', 'BIGFIVE', 'R_ANALYSIS'];

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

router.get('/:researchId/:instrumentCode/export', async (req, res) => {
  const researchIdParam = Number(req.params.researchId);
  if (!Number.isInteger(researchIdParam) || researchIdParam <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  const instrumentCode = req.params.instrumentCode;
  if (!INSTRUMENT_CODES.includes(instrumentCode)) {
    res.status(400).json({ error: `instrumentCode must be one of: ${INSTRUMENT_CODES.join(', ')}` });
    return;
  }

  if (!scopeGuard(req, res, researchIdParam)) return;
  const researchId = researchIdParam;

  const participantId =
    typeof req.query.participantId === 'string' && req.query.participantId.trim()
      ? req.query.participantId.trim()
      : null;

  try {
    const sql = getDb();

    if (instrumentCode === 'NASA_TLX') {
      const rows = await sql`
        SELECT t.* FROM "TlxResult" t
        JOIN "Participant" p ON p."Guid" = t."ParticipantGuid"
        WHERE p."ResearchId" = ${researchId}
          AND (${participantId}::text IS NULL OR t."ParticipantId" = ${participantId})
        ORDER BY t."CompletedAt" DESC
      `;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="tlx-results.csv"');
      res.send(toCsv(rows));
      return;
    }

    if (instrumentCode === 'REI40') {
      const rows = await sql`
        SELECT r."ParticipantId", r."Language", r."RationalAbility", r."RationalEngagement",
               r."ExperientialAbility", r."ExperientialEngagement", r."Rationality", r."Experientiality",
               r."Variant", r."CompletedAt"
        FROM "Rei40Result" r
        JOIN "Participant" p ON p."Guid" = r."ParticipantGuid"
        WHERE p."ResearchId" = ${researchId}
          AND (${participantId}::text IS NULL OR r."ParticipantId" = ${participantId})
        ORDER BY r."CompletedAt" DESC
      `;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="rei40-results.csv"');
      res.send(toCsv(rows));
      return;
    }

    if (instrumentCode === 'BIGFIVE') {
      const rows = await sql`
        SELECT b."ParticipantId", b."Language", b."Openness", b."Conscientiousness",
               b."Extraversion", b."Agreeableness", b."Neuroticism", b."CompletedAt"
        FROM "BigFiveResult" b
        JOIN "Participant" p ON p."Guid" = b."ParticipantGuid"
        WHERE p."ResearchId" = ${researchId}
          AND (${participantId}::text IS NULL OR b."ParticipantId" = ${participantId})
        ORDER BY b."CompletedAt" DESC
      `;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bigfive-results.csv"');
      res.send(toCsv(rows));
      return;
    }

    // R_ANALYSIS has no per-participant tabular rows — its one meaningful "export" is the most
    // recent successful run's interpreted text output (same content the R Analysis page's own
    // download-as-.txt button already offers), not a CSV. A real, honest shape difference rather
    // than a forced fake uniformity — still one endpoint, one auth/scope pattern, per-instrument
    // content-type.
    const rows = await sql`
      SELECT "ResultsText", "FinishedAt" FROM "AnalysisRun"
      WHERE "ResearchId" = ${researchId} AND "Status" = 'SUCCESS'
      ORDER BY "FinishedAt" DESC LIMIT 1
    `;
    if (!rows.length || rows[0].ResultsText == null) {
      res.status(404).json({ error: 'NO_SUCCESSFUL_RUN' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="r-analysis-results.txt"');
    res.send(rows[0].ResultsText);
  } catch (err) {
    console.error('[results-export] error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
