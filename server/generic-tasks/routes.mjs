import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';

// Generic Task multi-task support (2026-09-11) — a GENERIC-type research can define several
// distinct tasks (each with its own written instructions and/or an uploaded PDF, at least one of
// the two required) and assign exactly one task per participant. Purely administrative per the
// user's explicit scope decision: a participant never sees this through any participant-facing
// app — they receive their assigned task outside the platform (in person / a printed handout /
// separately emailed). Same BYTEA-in-Postgres + multer-memoryStorage pattern as
// server/task-files/routes.mjs, just one PDF per task instead of many files per research, and
// with an actual participant-assignment link (Participant.GenericTaskId) that task-files has no
// equivalent of.
const router = Router();
router.use(requireAuth);

const MAX_PDF_BYTES = 25 * 1024 * 1024; // Same per-file ceiling as task-files/EEG uploads.
const MAX_TITLE_LENGTH = 200;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

// Task-app timer/file-type config (2026-09-14) — added on top of the purely-administrative
// 2026-09-11 Generic Task shape once a real participant-facing "task app" was built for it.
const MIN_TIMER_MINUTES = 1;
const MAX_TIMER_MINUTES = 180;

// Fixed checkbox categories, not free-text extensions (explicit user decision) — each maps to a
// concrete extension list re-used identically by task-app-andrejkatin's own server-side
// re-validation, so the two repos must be kept in sync if this list ever changes.
export const FILE_TYPE_CATEGORIES = ['PDF', 'WORD', 'EXCEL', 'POWERPOINT', 'ZIP', 'IMAGE', 'TEXT'];

function validateAllowedFileTypes(value) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  let arr = value;
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value);
    } catch {
      return { ok: false };
    }
  }
  if (!Array.isArray(arr) || !arr.every((v) => typeof v === 'string' && FILE_TYPE_CATEGORIES.includes(v))) {
    return { ok: false };
  }
  return { ok: true, value: arr };
}

function validateTimerMinutes(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n) || n < MIN_TIMER_MINUTES || n > MAX_TIMER_MINUTES) return null;
  return n;
}

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

// multer errors fire one middleware step before the async handler runs, same reasoning as
// task-files/eeg's own upload wrappers.
function uploadPdf(req, res, next) {
  upload.single('pdf')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)` });
        return;
      }
      console.error('[generic-tasks] upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

function toListItem(r) {
  return {
    id: r.Id,
    title: r.Title,
    hasText: !!r.InstructionsText,
    hasPdf: !!r.PdfFilename,
    pdfFilename: r.PdfFilename,
    createdAt: r.CreatedAt,
    timerMinutes: r.TimerMinutes,
    allowedFileTypes: r.AllowedFileTypes ?? [],
    allowMultipleFiles: r.AllowMultipleFiles,
  };
}

router.get('/:researchId', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
      FROM "GenericTask" WHERE "ResearchId" = ${id} ORDER BY "CreatedAt" DESC
    `;
    res.json(rows.map(toListItem));
  } catch (err) {
    console.error('[generic-tasks] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Lightweight participant list for the assignment table — queried directly against Participant,
// deliberately NOT joined to ParticipantSession (unlike participants/routes.mjs's own GET / —
// see that file's now-fixed inner-JOIN bug). A GENERIC-type research's participants have zero
// ParticipantSession rows by design, so this endpoint would return nothing for all of them if it
// depended on that join.
//
// Registered here — before GET /:researchId/:taskId — on purpose: this router has already hit
// the exact "a literal-path route registered after a parameterized one gets its path segment
// captured as the param instead" bug class this codebase has hit before (experimental-sessions,
// task-config); GET /:researchId/participants was being swallowed by GET /:researchId/:taskId
// (taskId='participants' → NaN → 400) until this was caught during live verification.
router.get('/:researchId/participants', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "ParticipantId", "FirstName", "LastName", "GenericTaskId"
      FROM "Participant" WHERE "ResearchId" = ${id} ORDER BY "ParticipantId"
    `;
    res.json(
      rows.map((r) => ({
        participantId: r.ParticipantId, firstName: r.FirstName, lastName: r.LastName, genericTaskId: r.GenericTaskId,
      }))
    );
  } catch (err) {
    console.error('[generic-tasks] participants list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:researchId/participants/:participantId/assignment', async (req, res) => {
  const id = Number(req.params.researchId);
  const participantId = req.params.participantId;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { genericTaskId } = req.body ?? {};
  if (genericTaskId !== null && !Number.isInteger(genericTaskId)) {
    res.status(400).json({ error: 'genericTaskId must be an integer or null' });
    return;
  }

  try {
    const sql = getDb();
    if (genericTaskId !== null) {
      const task = await sql`SELECT "Id" FROM "GenericTask" WHERE "Id" = ${genericTaskId} AND "ResearchId" = ${id} LIMIT 1`;
      if (!task.length) {
        res.status(400).json({ error: 'genericTaskId does not belong to this research' });
        return;
      }
    }
    const rows = await sql`
      UPDATE "Participant" SET "GenericTaskId" = ${genericTaskId}
      WHERE "ParticipantId" = ${participantId} AND "ResearchId" = ${id}
      RETURNING "ParticipantId"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[generic-tasks] assignment error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/:taskId', async (req, res) => {
  const id = Number(req.params.researchId);
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: 'Invalid research or task id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
      FROM "GenericTask" WHERE "Id" = ${taskId} AND "ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    const r = rows[0];
    res.json({
      id: r.Id, title: r.Title, instructionsText: r.InstructionsText, hasPdf: !!r.PdfFilename,
      pdfFilename: r.PdfFilename, createdAt: r.CreatedAt, timerMinutes: r.TimerMinutes,
      allowedFileTypes: r.AllowedFileTypes ?? [], allowMultipleFiles: r.AllowMultipleFiles,
    });
  } catch (err) {
    console.error('[generic-tasks] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function validateTaskBody(title, instructionsText, hasPdfFile, keepExistingPdf) {
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE_LENGTH) {
    return `title is required (up to ${MAX_TITLE_LENGTH} characters)`;
  }
  const text = typeof instructionsText === 'string' ? instructionsText.trim() : '';
  if (!text && !hasPdfFile && !keepExistingPdf) {
    return 'At least one of instructionsText or a PDF file is required';
  }
  return null;
}

router.post('/:researchId', uploadPdf, async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { title, instructionsText, timerMinutes, allowedFileTypes, allowMultipleFiles } = req.body ?? {};
  const file = req.file;
  const error = validateTaskBody(title, instructionsText, !!file, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const minutes = validateTimerMinutes(timerMinutes);
  if (minutes === null) {
    res.status(400).json({ error: `timerMinutes is required (${MIN_TIMER_MINUTES}-${MAX_TIMER_MINUTES})` });
    return;
  }
  const fileTypes = validateAllowedFileTypes(allowedFileTypes);
  if (!fileTypes.ok) {
    res.status(400).json({ error: 'allowedFileTypes must be an array of known categories' });
    return;
  }
  const multiFiles = allowMultipleFiles === 'true' || allowMultipleFiles === true;

  try {
    const sql = getDb();
    const research = await sql`SELECT "Id" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!research.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const rows = await sql`
      INSERT INTO "GenericTask" ("ResearchId", "Title", "InstructionsText", "PdfFilename", "PdfContentType", "PdfContent", "PdfSizeBytes", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles")
      VALUES (
        ${id}, ${title.trim()}, ${instructionsText?.trim() || null},
        ${file ? file.originalname : null}, ${file ? file.mimetype || null : null},
        ${file ? file.buffer : null}, ${file ? file.size : null},
        ${minutes}, ${fileTypes.value}, ${multiFiles}
      )
      RETURNING "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
    `;
    res.status(201).json(toListItem(rows[0]));
  } catch (err) {
    console.error('[generic-tasks] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:researchId/:taskId', uploadPdf, async (req, res) => {
  const id = Number(req.params.researchId);
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: 'Invalid research or task id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { title, instructionsText, removePdf, timerMinutes, allowedFileTypes, allowMultipleFiles } = req.body ?? {};
  const file = req.file;
  const removingPdf = removePdf === 'true' || removePdf === true;
  const keepExistingPdf = !file && !removingPdf;
  const error = validateTaskBody(title, instructionsText, !!file, keepExistingPdf);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const minutes = validateTimerMinutes(timerMinutes);
  if (minutes === null) {
    res.status(400).json({ error: `timerMinutes is required (${MIN_TIMER_MINUTES}-${MAX_TIMER_MINUTES})` });
    return;
  }
  const fileTypes = validateAllowedFileTypes(allowedFileTypes);
  if (!fileTypes.ok) {
    res.status(400).json({ error: 'allowedFileTypes must be an array of known categories' });
    return;
  }
  const multiFiles = allowMultipleFiles === 'true' || allowMultipleFiles === true;

  try {
    const sql = getDb();
    const existing = await sql`SELECT "Id" FROM "GenericTask" WHERE "Id" = ${taskId} AND "ResearchId" = ${id} LIMIT 1`;
    if (!existing.length) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    let rows;
    if (file) {
      rows = await sql`
        UPDATE "GenericTask"
        SET "Title" = ${title.trim()}, "InstructionsText" = ${instructionsText?.trim() || null},
            "PdfFilename" = ${file.originalname}, "PdfContentType" = ${file.mimetype || null},
            "PdfContent" = ${file.buffer}, "PdfSizeBytes" = ${file.size},
            "TimerMinutes" = ${minutes}, "AllowedFileTypes" = ${fileTypes.value}, "AllowMultipleFiles" = ${multiFiles}
        WHERE "Id" = ${taskId} RETURNING "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
      `;
    } else if (removingPdf) {
      rows = await sql`
        UPDATE "GenericTask"
        SET "Title" = ${title.trim()}, "InstructionsText" = ${instructionsText?.trim() || null},
            "PdfFilename" = NULL, "PdfContentType" = NULL, "PdfContent" = NULL, "PdfSizeBytes" = NULL,
            "TimerMinutes" = ${minutes}, "AllowedFileTypes" = ${fileTypes.value}, "AllowMultipleFiles" = ${multiFiles}
        WHERE "Id" = ${taskId} RETURNING "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
      `;
    } else {
      rows = await sql`
        UPDATE "GenericTask"
        SET "Title" = ${title.trim()}, "InstructionsText" = ${instructionsText?.trim() || null},
            "TimerMinutes" = ${minutes}, "AllowedFileTypes" = ${fileTypes.value}, "AllowMultipleFiles" = ${multiFiles}
        WHERE "Id" = ${taskId} RETURNING "Id", "Title", "InstructionsText", "PdfFilename", "CreatedAt", "TimerMinutes", "AllowedFileTypes", "AllowMultipleFiles"
      `;
    }
    res.json(toListItem(rows[0]));
  } catch (err) {
    console.error('[generic-tasks] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/:researchId/:taskId', async (req, res) => {
  const id = Number(req.params.researchId);
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: 'Invalid research or task id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    // Participant.GenericTaskId is ON DELETE SET NULL — deleting a task un-assigns any
    // participant who had it, it never blocks or cascades into Participant.
    const rows = await sql`DELETE FROM "GenericTask" WHERE "Id" = ${taskId} AND "ResearchId" = ${id} RETURNING "Id"`;
    if (!rows.length) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[generic-tasks] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:researchId/:taskId/pdf', async (req, res) => {
  const id = Number(req.params.researchId);
  const taskId = Number(req.params.taskId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ error: 'Invalid research or task id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "PdfFilename", "PdfContentType", "PdfContent" FROM "GenericTask"
      WHERE "Id" = ${taskId} AND "ResearchId" = ${id} LIMIT 1
    `;
    if (!rows.length || !rows[0].PdfContent) {
      res.status(404).json({ error: 'PDF not found' });
      return;
    }
    const r = rows[0];
    res.setHeader('Content-Type', r.PdfContentType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${r.PdfFilename}"`);
    res.send(Buffer.from(r.PdfContent));
  } catch (err) {
    console.error('[generic-tasks] pdf download error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
