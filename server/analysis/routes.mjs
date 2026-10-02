import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import * as r2 from '../storage/r2.mjs';
import { executeRun, isResearchRunning } from './runner.mjs';

// Task Configuration Phase 3 (2026-08-19) — the Google Forms task type's opt-in "R analysis"
// step: upload one .R script per research (most-recent-wins, like EegRecording's overwrite
// pattern — enforced by AnalysisScript's UNIQUE(ResearchId)), trigger sandboxed Docker runs
// against the research's uploaded TaskFile data, poll for status, view/download results. Same
// requireAuth-only, scope-guarded pattern as the rest of Task Configuration's routes.
const router = Router();
router.use(requireAuth);

const MAX_SCRIPT_BYTES = 1024 * 1024; // 1MB — an R script is plain text, this is generous.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SCRIPT_BYTES } });

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

function uploadScriptFile(req, res, next) {
  upload.single('script')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `Script too large (max ${MAX_SCRIPT_BYTES / 1024}KB)` });
        return;
      }
      console.error('[analysis] upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

router.get('/:researchId/script', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "OriginalFilename", "UploadedAt" FROM "AnalysisScript" WHERE "ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.json({ exists: false });
      return;
    }
    res.json({ exists: true, id: rows[0].Id, originalFilename: rows[0].OriginalFilename, uploadedAt: rows[0].UploadedAt });
  } catch (err) {
    console.error('[analysis] get script error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:researchId/script', uploadScriptFile, async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  if (!req.file) {
    res.status(400).json({ error: 'An .R script file is required (field name "script")' });
    return;
  }
  const scriptContent = req.file.buffer.toString('utf8');
  if (!scriptContent.trim()) {
    res.status(400).json({ error: 'Script file is empty' });
    return;
  }

  try {
    const sql = getDb();
    const research = await sql`SELECT 1 FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }

    const rows = await sql`
      INSERT INTO "AnalysisScript" ("ResearchId", "OriginalFilename", "ScriptContent")
      VALUES (${id}, ${req.file.originalname}, ${scriptContent})
      ON CONFLICT ("ResearchId") DO UPDATE SET
        "OriginalFilename" = EXCLUDED."OriginalFilename",
        "ScriptContent" = EXCLUDED."ScriptContent",
        "UploadedAt" = NOW()
      RETURNING "Id", "OriginalFilename", "UploadedAt"
    `;
    res.status(201).json({ exists: true, id: rows[0].Id, originalFilename: rows[0].OriginalFilename, uploadedAt: rows[0].UploadedAt });
  } catch (err) {
    console.error('[analysis] script upload error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/runs', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Status", "StartedAt", "FinishedAt", "CreatedAt"
      FROM "AnalysisRun" WHERE "ResearchId" = ${id} ORDER BY "CreatedAt" DESC
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id, status: r.Status, startedAt: r.StartedAt, finishedAt: r.FinishedAt, createdAt: r.CreatedAt,
      }))
    );
  } catch (err) {
    console.error('[analysis] list runs error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:researchId/runs', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  if (isResearchRunning(id)) {
    res.status(409).json({ error: 'ALREADY_RUNNING' });
    return;
  }

  try {
    const sql = getDb();
    const scriptRows = await sql`SELECT "Id" FROM "AnalysisScript" WHERE "ResearchId" = ${id} LIMIT 1`;
    if (!scriptRows.length) {
      res.status(400).json({ error: 'NO_SCRIPT' });
      return;
    }

    const runRows = await sql`
      INSERT INTO "AnalysisRun" ("ResearchId", "ScriptId", "Status")
      VALUES (${id}, ${scriptRows[0].Id}, 'PENDING')
      RETURNING "Id"
    `;
    const runId = runRows[0].Id;

    // Fire-and-forget — the run executes asynchronously; the frontend polls GET
    // /runs/:runId for status. Catch here so a runner-internal failure (already handled
    // inside executeRun's own try/catch, this is defense in depth) can't become an
    // unhandled promise rejection that crashes the server.
    executeRun(id, runId).catch((err) => console.error('[analysis] unhandled executeRun rejection:', err));

    res.status(201).json({ id: runId });
  } catch (err) {
    console.error('[analysis] create run error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/runs/:runId', async (req, res) => {
  const id = Number(req.params.researchId);
  const runId = Number(req.params.runId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(runId) || runId <= 0) {
    res.status(400).json({ error: 'Invalid research or run id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Status", "StartedAt", "FinishedAt", "StdOut", "StdErr", "ResultsText", "CreatedAt"
      FROM "AnalysisRun" WHERE "Id" = ${runId} AND "ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const plotRows = await sql`
      SELECT "Id", "Filename" FROM "AnalysisRunPlot" WHERE "RunId" = ${runId} ORDER BY "SortOrder"
    `;
    const r = rows[0];
    res.json({
      id: r.Id, status: r.Status, startedAt: r.StartedAt, finishedAt: r.FinishedAt,
      stdOut: r.StdOut, stdErr: r.StdErr, resultsText: r.ResultsText, createdAt: r.CreatedAt,
      plots: plotRows.map((p) => ({ id: p.Id, filename: p.Filename })),
    });
  } catch (err) {
    console.error('[analysis] get run error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/runs/:runId/plots/:plotId', async (req, res) => {
  const id = Number(req.params.researchId);
  const runId = Number(req.params.runId);
  const plotId = Number(req.params.plotId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(runId) || runId <= 0 || !Number.isInteger(plotId) || plotId <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT p."Filename", p."ImageData", p."StorageKey" FROM "AnalysisRunPlot" p
      JOIN "AnalysisRun" r ON r."Id" = p."RunId"
      WHERE p."Id" = ${plotId} AND p."RunId" = ${runId} AND r."ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Plot not found' });
      return;
    }
    const bytes = rows[0].StorageKey ? await r2.getObject(rows[0].StorageKey) : Buffer.from(rows[0].ImageData);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].Filename}"`);
    res.send(bytes);
  } catch (err) {
    console.error('[analysis] get plot error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
