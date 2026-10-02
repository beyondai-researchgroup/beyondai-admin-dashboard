import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db.mjs';
import * as r2 from '../storage/r2.mjs';

// Task Configuration Phase 3 — spawns the sandboxed R execution container for one AnalysisRun.
// No new npm dependency: shells out to the `docker` CLI directly via child_process.execFile,
// exactly like every other "run an external program" need in this codebase would (there's no
// dockerode/similar wrapper anywhere). See docker/r-runner/ for the image itself and
// docs/task-r-analysis-setup.md for the full setup walkthrough.

export const R_RUNNER_IMAGE = 'task-r-runner';
const TIMEOUT_MS = 120_000; // 120s wall-clock — descriptive-stats scripts on survey-sized data
// should never need this long; a script that does is either stuck or doing something this
// sandbox isn't meant for.
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024; // 10MB combined stdout/stderr ceiling.

// One run at a time per research — a second POST /runs while one is already RUNNING for that
// research gets a 409 (see routes.mjs). Simple in-memory lock; fine for a single-process local
// dev server (this app has never run as more than one process — see CLAUDE.md's deployment
// notes, admin-dashboard-andrejkatin is local-only).
const runningResearches = new Set();

export function isResearchRunning(researchId) {
  return runningResearches.has(researchId);
}

/** Strips any directory components from a user-supplied filename so it can never escape the
 *  intended data directory via `../` or an absolute path — same defensive intent as any
 *  upload-then-write-to-disk feature, just more important here since the written files are
 *  about to be handed to a script execution, not just stored. */
function safeFilename(name) {
  const base = path.basename(name).replace(/[^\w.\-]/g, '_');
  return base || 'file';
}

async function readOutputDir(outputDir) {
  let entries;
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    return { plots: [], resultsText: null };
  }

  const plots = [];
  for (const name of entries.sort()) {
    if (name.toLowerCase().endsWith('.png')) {
      const data = await fs.readFile(path.join(outputDir, name));
      plots.push({ filename: name, data });
    }
  }

  let resultsText = null;
  const resultsPath = entries.find((n) => n.toLowerCase() === 'results.txt');
  if (resultsPath) {
    resultsText = await fs.readFile(path.join(outputDir, resultsPath), 'utf8');
  }

  return { plots, resultsText };
}

/** Fire-and-forget from routes.mjs — the HTTP response already went out with the run's id
 *  before this resolves. All state changes happen via DB writes the frontend picks up by
 *  polling GET /runs/:runId. */
export async function executeRun(researchId, runId) {
  runningResearches.add(researchId);
  const sql = getDb();
  let tmpDir = null;

  try {
    await sql`UPDATE "AnalysisRun" SET "Status" = 'RUNNING', "StartedAt" = NOW() WHERE "Id" = ${runId}`;

    const runRows = await sql`SELECT "ScriptId" FROM "AnalysisRun" WHERE "Id" = ${runId} LIMIT 1`;
    const scriptRows = await sql`
      SELECT "ScriptContent" FROM "AnalysisScript" WHERE "Id" = ${runRows[0].ScriptId} LIMIT 1
    `;
    const dataFiles = await sql`
      SELECT "OriginalFilename", "FileContent", "StorageKey" FROM "TaskFile" WHERE "ResearchId" = ${researchId}
    `;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-r-run-'));
    const dataDir = path.join(tmpDir, 'data');
    const outputDir = path.join(tmpDir, 'output');
    const scriptPath = path.join(tmpDir, 'script.R');

    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(scriptPath, scriptRows[0].ScriptContent, 'utf8');
    for (const f of dataFiles) {
      // Same R2-or-DB-column read as task-files/routes.mjs's readTaskFileBytes() — a file
      // uploaded while R2 was configured has no bytes in "FileContent" at all.
      const bytes = f.StorageKey ? await r2.getObject(f.StorageKey) : Buffer.from(f.FileContent);
      await fs.writeFile(path.join(dataDir, safeFilename(f.OriginalFilename)), bytes);
    }

    const dockerArgs = [
      'run', '--rm',
      '--network', 'none',
      '--memory', '512m',
      '--cpus', '1',
      '--read-only',
      '--tmpfs', '/tmp',
      '--user', '1000:1000',
      '-v', `${dataDir}:/data:ro`,
      '-v', `${outputDir}:/output`,
      '-v', `${scriptPath}:/script.R:ro`,
      R_RUNNER_IMAGE, 'Rscript', '/script.R',
    ];

    const { status, stdout, stderr } = await new Promise((resolve) => {
      execFile('docker', dockerArgs, { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BUFFER }, (err, so, se) => {
        if (err?.killed && err.signal === 'SIGTERM') {
          resolve({ status: 'TIMEOUT', stdout: so, stderr: se });
        } else if (err) {
          resolve({ status: 'FAILED', stdout: so, stderr: se || err.message });
        } else {
          resolve({ status: 'SUCCESS', stdout: so, stderr: se });
        }
      });
    });

    const { plots, resultsText } = await readOutputDir(outputDir);

    await sql`
      UPDATE "AnalysisRun"
      SET "Status" = ${status}, "FinishedAt" = NOW(), "StdOut" = ${stdout || null},
          "StdErr" = ${stderr || null}, "ResultsText" = ${resultsText}
      WHERE "Id" = ${runId}
    `;
    for (let i = 0; i < plots.length; i++) {
      // Same R2-or-DB split as every other upload type — PNG bytes go to R2 when configured,
      // "ImageData" is left NULL for that row.
      let storageKey = null;
      let dbImageData = plots[i].data;
      if (r2.isConfigured()) {
        storageKey = await r2.putObject(r2.buildKey('analysis-plots', researchId, plots[i].filename), plots[i].data, 'image/png');
        dbImageData = null;
      }
      await sql`
        INSERT INTO "AnalysisRunPlot" ("RunId", "Filename", "ImageData", "SortOrder", "StorageKey")
        VALUES (${runId}, ${plots[i].filename}, ${dbImageData}, ${i}, ${storageKey})
      `;
    }
  } catch (err) {
    console.error('[analysis] runner error:', err);
    try {
      await sql`
        UPDATE "AnalysisRun" SET "Status" = 'FAILED', "FinishedAt" = NOW(), "StdErr" = ${String(err?.message ?? err)}
        WHERE "Id" = ${runId}
      `;
    } catch (updateErr) {
      console.error('[analysis] failed to record runner error on the run row:', updateErr);
    }
  } finally {
    runningResearches.delete(researchId);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((rmErr) => {
        console.error('[analysis] temp dir cleanup failed:', tmpDir, rmErr);
      });
    }
  }
}
