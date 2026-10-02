import { Router } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { dateOnly } from '../date-only.mjs';
import * as r2 from '../storage/r2.mjs';

// Self-service "my profile" routes (researcher profile system, 2026-08-20) — always operate on
// req.researcher.id from the JWT, never a path param, so a researcher can only ever touch their
// own row. No scope-guard needed: there's no cross-researcher access surface here at all.
const router = Router();
router.use(requireAuth);

const MAX_NAME_LENGTH = 100;
const MAX_COUNTRY_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3MB — a profile photo, not a document.
const ACADEMIC_STATUSES = ['PHD_STUDENT', 'MASTER', 'DOCTOR'];
const ALLOWED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES } });

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}
function isOptionalString(v, max) {
  return v === undefined || v === null || v === '' || (typeof v === 'string' && v.length <= max);
}

router.get('/me', async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "Email", "FirstName", "LastName", "DateOfBirth", "AcademicStatus", "Country",
             "IsSuperAdmin", "Language", (("AvatarImage" IS NOT NULL) OR ("AvatarStorageKey" IS NOT NULL)) AS "HasAvatar"
      FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const researches = await sql`
      SELECT rr."ResearchId" AS "Id", res."Name"
      FROM "ResearcherResearch" rr
      JOIN "Research" res ON res."Id" = rr."ResearchId"
      WHERE rr."ResearcherId" = ${req.researcher.id}
      ORDER BY res."Name"
    `;
    res.json({
      id: r.Id, email: r.Email, firstName: r.FirstName, lastName: r.LastName,
      dateOfBirth: dateOnly(r.DateOfBirth), academicStatus: r.AcademicStatus, country: r.Country,
      isSuperAdmin: r.IsSuperAdmin, language: r.Language, hasAvatar: r.HasAvatar,
      researches: researches.map((x) => ({ id: x.Id, name: x.Name })),
    });
  } catch (err) {
    console.error('[researcher-profile] get me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Deliberately narrow — never isSuperAdmin/researchIds/Email, those stay admin-only ("ne i da
// ima mogućnost da slobodno pristupa projektima" — a researcher can edit their own info but not
// grant themselves project access).
router.put('/me', async (req, res) => {
  const { firstName, lastName, dateOfBirth, academicStatus, country, language } = req.body ?? {};

  if (!isNonEmptyString(firstName, MAX_NAME_LENGTH) || !isNonEmptyString(lastName, MAX_NAME_LENGTH)) {
    res.status(400).json({ error: `firstName and lastName are required (up to ${MAX_NAME_LENGTH} characters)` });
    return;
  }
  if (dateOfBirth !== undefined && dateOfBirth !== null && dateOfBirth !== '' && isNaN(Date.parse(dateOfBirth))) {
    res.status(400).json({ error: 'dateOfBirth must be a valid date, or omitted' });
    return;
  }
  if (academicStatus !== undefined && academicStatus !== null && academicStatus !== '' && !ACADEMIC_STATUSES.includes(academicStatus)) {
    res.status(400).json({ error: `academicStatus must be one of: ${ACADEMIC_STATUSES.join(', ')}, or omitted` });
    return;
  }
  if (!isOptionalString(country, MAX_COUNTRY_LENGTH)) {
    res.status(400).json({ error: `country must be a string up to ${MAX_COUNTRY_LENGTH} characters, or omitted` });
    return;
  }
  if (language !== undefined && language !== null && language !== '' && !['sr', 'en'].includes(language)) {
    res.status(400).json({ error: "language must be 'sr' or 'en', or omitted" });
    return;
  }

  try {
    const sql = getDb();
    // COALESCE keeps the existing Language when the request omits it (the request body may come
    // from a caller that doesn't send it) rather than silently resetting it to a default.
    await sql`
      UPDATE "Researcher" SET
        "FirstName" = ${firstName.trim()}, "LastName" = ${lastName.trim()},
        "DateOfBirth" = ${dateOfBirth || null}, "AcademicStatus" = ${academicStatus || null},
        "Country" = ${country?.trim() || null},
        "Language" = COALESCE(${language || null}, "Language")
      WHERE "Id" = ${req.researcher.id}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researcher-profile] update me error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || !currentPassword) {
    res.status(400).json({ error: 'currentPassword is required' });
    return;
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT "PasswordHash" FROM "Researcher" WHERE "Id" = ${req.researcher.id} LIMIT 1`;
    if (!rows.length || !bcrypt.compareSync(currentPassword, rows[0].PasswordHash)) {
      res.status(400).json({ error: 'CURRENT_PASSWORD_INCORRECT' });
      return;
    }
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await sql`UPDATE "Researcher" SET "PasswordHash" = ${passwordHash} WHERE "Id" = ${req.researcher.id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researcher-profile] change password error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

function uploadAvatarFile(req, res, next) {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_AVATAR_BYTES / (1024 * 1024)}MB)` });
        return;
      }
      console.error('[researcher-profile] avatar upload middleware error:', err);
      res.status(400).json({ error: 'Invalid upload' });
      return;
    }
    next();
  });
}

router.post('/me/avatar', uploadAvatarFile, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'An image file is required (field name "avatar")' });
    return;
  }
  if (!ALLOWED_AVATAR_TYPES.includes(req.file.mimetype)) {
    res.status(400).json({ error: `Unsupported image type — use one of: ${ALLOWED_AVATAR_TYPES.join(', ')}` });
    return;
  }

  try {
    const sql = getDb();
    // Same R2-or-DB split as every other upload type here — bytes go to R2 when configured,
    // "AvatarImage" is left NULL for that row and "AvatarStorageKey" carries the object key.
    // A previous avatar's R2 object (if any) is intentionally left behind on overwrite —
    // storage-cost leak, not correctness, same tradeoff as every other upload-overwrite here.
    let storageKey = null;
    let dbAvatarImage = req.file.buffer;
    if (r2.isConfigured()) {
      storageKey = await r2.putObject(r2.buildKey('avatars', req.researcher.id, req.file.originalname), req.file.buffer, req.file.mimetype);
      dbAvatarImage = null;
    }
    await sql`
      UPDATE "Researcher"
      SET "AvatarImage" = ${dbAvatarImage}, "AvatarContentType" = ${req.file.mimetype}, "AvatarStorageKey" = ${storageKey}
      WHERE "Id" = ${req.researcher.id}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researcher-profile] avatar upload error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Serves inline (no Content-Disposition: attachment — used as an <img src>), by researcher id so
// any logged-in researcher can render a colleague's avatar (e.g. next to their name elsewhere in
// the app later), not just their own.
router.get('/:id/avatar', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid researcher id' });
    return;
  }
  try {
    const sql = getDb();
    const rows = await sql`SELECT "AvatarImage", "AvatarContentType", "AvatarStorageKey" FROM "Researcher" WHERE "Id" = ${id} LIMIT 1`;
    const r = rows[0];
    if (!r || (!r.AvatarImage && !r.AvatarStorageKey)) {
      res.status(404).json({ error: 'No avatar' });
      return;
    }
    const bytes = r.AvatarStorageKey ? await r2.getObject(r.AvatarStorageKey) : Buffer.from(r.AvatarImage);
    res.setHeader('Content-Type', r.AvatarContentType || 'application/octet-stream');
    res.send(bytes);
  } catch (err) {
    console.error('[researcher-profile] get avatar error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// "Leave this research" self-service. Refuses if this is the researcher's last assignment and
// they're not a superadmin (a non-superadmin account with zero research access is a dead end) —
// mirrors researchers/routes.mjs's "can't delete the last superadmin" guard style.
router.delete('/me/researches/:researchId', async (req, res) => {
  const researchId = Number(req.params.researchId);
  if (!Number.isInteger(researchId) || researchId <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }

  try {
    const sql = getDb();
    if (!req.researcher.isSuperAdmin) {
      const countRows = await sql`
        SELECT COUNT(*)::int AS "Count" FROM "ResearcherResearch" WHERE "ResearcherId" = ${req.researcher.id}
      `;
      if (countRows[0].Count <= 1) {
        res.status(400).json({ error: 'LAST_RESEARCH' });
        return;
      }
    }
    await sql`
      DELETE FROM "ResearcherResearch" WHERE "ResearcherId" = ${req.researcher.id} AND "ResearchId" = ${researchId}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[researcher-profile] leave research error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
