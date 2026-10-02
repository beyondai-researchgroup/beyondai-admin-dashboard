import { Router } from 'express';
import { ZipArchive } from 'archiver';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import * as r2 from '../storage/r2.mjs';

// Task-app submission results (2026-09-14) — download-only, no interpretation: the researcher
// gets exactly the files the participant uploaded, per participant or as one .zip for everyone.
// Own router, mounted at its own base path — same discipline this repo has documented in
// task-config/experimental-sessions: a route registered after a path-segment-colliding
// parameterized route can silently steal its matches, so this stays fully separate from
// generic-tasks/routes.mjs rather than being folded into it.
const router = Router();
router.use(requireAuth);

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

// Sanitizes a participant id / filename into something safe to use as a zip-entry path segment —
// defense against a crafted ParticipantId or an uploaded OriginalFilename containing path
// separators or traversal sequences (same defensive-allowlist reasoning as the R-analysis
// runner's temp-file naming).
function safeSegment(name) {
  return String(name).replace(/[^A-Za-z0-9._\- ]/g, '_').slice(0, 150) || 'file';
}

router.get('/:researchId/submissions', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const subs = await sql`
      SELECT s."Id", p."ParticipantId", t."Title" AS "TaskTitle", s."IsTimedOut", s."SubmittedAt"
      FROM "GenericTaskSubmission" s
      JOIN "Participant" p ON p."Guid" = s."ParticipantGuid"
      JOIN "GenericTask" t ON t."Id" = s."GenericTaskId"
      WHERE p."ResearchId" = ${id}
      ORDER BY s."SubmittedAt" DESC
    `;
    if (!subs.length) {
      res.json([]);
      return;
    }
    const subIds = subs.map((s) => s.Id);
    const files = await sql`
      SELECT "Id", "SubmissionId", "OriginalFilename", "FileSizeBytes", "UploadedAt"
      FROM "GenericTaskSubmissionFile" WHERE "SubmissionId" = ANY(${subIds})
      ORDER BY "UploadedAt"
    `;
    const filesBySubmission = new Map();
    for (const f of files) {
      const list = filesBySubmission.get(f.SubmissionId) ?? [];
      list.push({ id: f.Id, filename: f.OriginalFilename, sizeBytes: f.FileSizeBytes, uploadedAt: f.UploadedAt });
      filesBySubmission.set(f.SubmissionId, list);
    }
    res.json(
      subs.map((s) => ({
        submissionId: s.Id,
        participantId: s.ParticipantId,
        taskTitle: s.TaskTitle,
        isTimedOut: s.IsTimedOut,
        submittedAt: s.SubmittedAt,
        files: filesBySubmission.get(s.Id) ?? [],
      }))
    );
  } catch (err) {
    console.error('[generic-task-results] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/submissions/:submissionId/files/:fileId/download', async (req, res) => {
  const id = Number(req.params.researchId);
  const submissionId = Number(req.params.submissionId);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(submissionId) || !Number.isInteger(fileId)) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT f."OriginalFilename", f."ContentType", f."FileContent", f."StorageKey"
      FROM "GenericTaskSubmissionFile" f
      JOIN "GenericTaskSubmission" s ON s."Id" = f."SubmissionId"
      JOIN "Participant" p ON p."Guid" = s."ParticipantGuid"
      WHERE f."Id" = ${fileId} AND f."SubmissionId" = ${submissionId} AND p."ResearchId" = ${id}
      LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const r = rows[0];
    const bytes = r.StorageKey ? await r2.getObject(r.StorageKey) : Buffer.from(r.FileContent);
    res.setHeader('Content-Type', r.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${r.OriginalFilename}"`);
    res.send(bytes);
  } catch (err) {
    console.error('[generic-task-results] download error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Streams every participant's submitted files as one .zip, one folder per ParticipantId. Reads
// every file's bytes into memory up front (same as every other BYTEA download in this app — no
// streaming-from-Postgres precedent exists here) then pipes them into the archive as it's built.
router.get('/:researchId/submissions/export-zip', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT p."ParticipantId", f."OriginalFilename", f."FileContent", f."StorageKey"
      FROM "GenericTaskSubmissionFile" f
      JOIN "GenericTaskSubmission" s ON s."Id" = f."SubmissionId"
      JOIN "Participant" p ON p."Guid" = s."ParticipantGuid"
      WHERE p."ResearchId" = ${id}
      ORDER BY p."ParticipantId", f."UploadedAt"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'NO_SUBMISSIONS' });
      return;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="zadaci-ispitanika.zip"');

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[generic-task-results] zip stream error:', err);
      res.destroy(err);
    });
    archive.pipe(res);

    // Disambiguate same-name files from the same participant (e.g. two "resenje.zip" uploads)
    // with a numeric suffix instead of silently overwriting one inside the archive.
    const usedNames = new Map();
    for (const r of rows) {
      const folder = safeSegment(r.ParticipantId);
      const base = safeSegment(r.OriginalFilename);
      const key = `${folder}/${base}`;
      const n = (usedNames.get(key) ?? 0) + 1;
      usedNames.set(key, n);
      const entryName = n === 1 ? `${folder}/${base}` : `${folder}/${n}-${base}`;
      const bytes = r.StorageKey ? await r2.getObject(r.StorageKey) : Buffer.from(r.FileContent);
      archive.append(bytes, { name: entryName });
    }

    await archive.finalize();
  } catch (err) {
    console.error('[generic-task-results] zip export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Database error' });
  }
});

export default router;
