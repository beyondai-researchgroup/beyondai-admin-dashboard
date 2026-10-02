// Consent Form delivery — mailing-list mode (Part C3 of the 2026-09-08 follow-up round). A
// researcher uploads a small CSV of recipients; each row gets (or reuses) a minimal Participant
// row and a real per-recipient magic link — same SurveyAccessToken/`/link/:token` mechanism this
// codebase already uses for REI-40/Big Five/NASA-TLX (`SurveyType='CONSENT_ENTRY'`), just
// resolving into consent-andrejkatin's own new /link/:token route instead of a survey app's.
//
// CSV columns: `ParticipantId` (optional — auto-generated as `mail-<n>` when omitted),
// `Email` (required), `Language` (optional, must be one of the research's Part-C1-offered
// languages; defaults to whichever is offered, preferring sr).
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { sendMail } from '../email/mailer.mjs';
import { buildConsentLinkEmail } from '../email/consentLinkEmail.mjs';
import { isValidSlug } from '../researches/slug.mjs';

const router = Router();
router.use(requireAuth);

const CONSENT_APP_URL = process.env.CONSENT_APP_URL || 'http://localhost:4303';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (2026-10-02 follow-up, was 24h)
const MAX_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// The plain, non-personalized entry point — Mode 1 ("link ka aplikaciji"). 2026-09-08 follow-up:
// now research-specific (`${CONSENT_APP_URL}/r/${slug}`, resolved by consent-andrejkatin's own
// GET /api/research/:slug + the LoginComponent's /r/:slug route) instead of the bare app URL
// every research used to share — see slug.mjs's header comment for why. Falls back to the bare
// URL only for the never-actually-expected case of a row with no Slug (e.g. some future direct
// SQL insert bypassing POST /api/admin/researches).
//
// 2026-09-09 fix: this used to build `${CONSENT_APP_URL}/${slug}` — missing the `/r/` prefix
// consent-andrejkatin's router actually requires (`path: 'r/:slug'`), so every link ever shown
// here 404'd through to the app's `**` wildcard and silently landed on the generic, unscoped
// /login instead of the intended research. Found and fixed alongside the new activate/deactivate
// toggle below, which is what first got this endpoint clicked through end to end.
router.get('/:researchId/portal-link', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;
  try {
    const sql = getDb();
    const rows = await sql`SELECT "Slug", "ConsentPortalActive" FROM "Research" WHERE "Id" = ${id} LIMIT 1`;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const slug = rows[0].Slug;
    res.json({
      url: slug ? `${CONSENT_APP_URL}/r/${slug}` : CONSENT_APP_URL,
      slug: slug ?? null,
      active: rows[0].ConsentPortalActive === true,
    });
  } catch (err) {
    console.error('[consent-form/mailing-list] portal-link error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Activate/deactivate the slug-scoped portal link (2026-09-09) — a fresh link starts inactive
// (ConsentPortalActive DEFAULT FALSE); a researcher must explicitly flip it on before
// consent-andrejkatin's GET /api/research/:slug (and the scoped participant/consent endpoints
// downstream of it) will let a participant through. Same permission model as the slug PUT right
// above — any research member, not superadmin-gated — this is an ordinary config toggle, not a
// destructive action.
router.put('/:researchId/portal-active', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { active } = req.body ?? {};
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'INVALID_ACTIVE' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      UPDATE "Research" SET "ConsentPortalActive" = ${active} WHERE "Id" = ${id} RETURNING "ConsentPortalActive"
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true, active: rows[0].ConsentPortalActive });
  } catch (err) {
    console.error('[consent-form/mailing-list] portal-active update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Lets any member of the research (not just a superadmin — matches this whole page's permission
// model, unlike researches/routes.mjs's own superadmin-gated PUT /:id) fix up their research's
// link path. Deliberately never auto-regenerated elsewhere (e.g. on a Name edit) — a link already
// shared/emailed must stay stable; this is the one explicit, intentional way to change it.
router.put('/:researchId/slug', async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;

  const { slug } = req.body ?? {};
  if (!isValidSlug(slug)) {
    res.status(400).json({ error: 'INVALID_SLUG' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`UPDATE "Research" SET "Slug" = ${slug} WHERE "Id" = ${id} RETURNING "Slug"`;
    if (!rows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    res.json({ ok: true, slug: rows[0].Slug });
  } catch (err) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'SLUG_TAKEN' });
      return;
    }
    console.error('[consent-form/mailing-list] slug update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:researchId/mailing-list', upload.single('file'), async (req, res) => {
  const id = Number(req.params.researchId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid research id' });
    return;
  }
  if (!scopeGuard(req, res, id)) return;
  if (!req.file) {
    res.status(400).json({ error: 'A CSV file is required (field name "file")' });
    return;
  }

  try {
    const sql = getDb();
    const researchRows = await sql`
      SELECT "Name", "StudyDisplayName", "EmailSenderName", "ConsentLanguageSr", "ConsentLanguageEn", "ConsentPortalActive"
      FROM "Research" WHERE "Id" = ${id} LIMIT 1
    `;
    if (!researchRows.length) {
      res.status(404).json({ error: 'Research not found' });
      return;
    }
    const research = researchRows[0];
    // 2026-09-09 — the master pause switch (same ConsentPortalActive column the slug link's
    // Activate/Deactivate toggle already writes) now also gates Mode 2: no point minting tokens
    // and sending real emails whose links would immediately 403 on arrival.
    if (!research.ConsentPortalActive) {
      res.status(400).json({ error: 'PORTAL_INACTIVE' });
      return;
    }
    const allowedLangs = [research.ConsentLanguageSr && 'sr', research.ConsentLanguageEn && 'en'].filter(Boolean);
    const defaultLang = research.ConsentLanguageSr ? 'sr' : 'en';
    const senderName = research.EmailSenderName || research.StudyDisplayName || research.Name || undefined;

    let rows;
    try {
      rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      res.status(400).json({ error: 'CSV_PARSE_ERROR' });
      return;
    }
    if (!rows.length) {
      res.status(400).json({ error: 'EMPTY_CSV' });
      return;
    }
    if (rows.length > MAX_ROWS) {
      res.status(400).json({ error: `Too many rows (max ${MAX_ROWS})` });
      return;
    }

    // Auto-generated ids start after however many "mail-N" rows already exist for this research
    // — a low-concurrency admin action (one researcher, one upload at a time in practice), so a
    // single count-then-increment up front is fine; no attempt at cross-request atomicity.
    const existingAuto = await sql`
      SELECT "ParticipantId" FROM "Participant" WHERE "ResearchId" = ${id} AND "ParticipantId" LIKE 'mail-%'
    `;
    let autoCounter = existingAuto.reduce((max, r) => {
      const n = Number(r.ParticipantId.slice(5));
      return Number.isInteger(n) && n > max ? n : max;
    }, 0);

    let sent = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const email = (row.Email ?? '').trim();
      if (!email || !EMAIL_RE.test(email)) {
        errors.push({ row: i + 1, reasonCode: 'INVALID_EMAIL' });
        continue;
      }
      let language = (row.Language ?? '').trim().toLowerCase();
      if (language && !allowedLangs.includes(language)) {
        errors.push({ row: i + 1, reasonCode: 'INVALID_LANGUAGE' });
        continue;
      }
      if (!language) language = defaultLang;

      let participantId = (row.ParticipantId ?? '').trim();
      if (!participantId) {
        autoCounter += 1;
        participantId = `mail-${autoCounter}`;
      }

      try {
        // COALESCE-on-conflict: fills in Email/Language only when NULL, never overwrites a value
        // already on file for a pre-existing participant — same "don't clobber" discipline the
        // Excel participant importer already follows, expressed as one statement instead of a
        // separate existence check.
        const upserted = await sql`
          INSERT INTO "Participant" ("ParticipantId", "ResearchId", "Email", "Language")
          VALUES (${participantId}, ${id}, ${email}, ${language})
          ON CONFLICT ("ResearchId", "ParticipantId") DO UPDATE SET
            "Email" = COALESCE("Participant"."Email", EXCLUDED."Email"),
            "Language" = COALESCE("Participant"."Language", EXCLUDED."Language")
          RETURNING "Email", "Language"
        `;
        const resolvedEmail = upserted[0].Email;
        const resolvedLang = upserted[0].Language;

        const token = generateToken();
        const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
        await sql`
          INSERT INTO "SurveyAccessToken" ("ParticipantId", "SurveyType", "Token", "ExpiresAt")
          VALUES (${participantId}, 'CONSENT_ENTRY', ${token}, ${expiresAt})
          ON CONFLICT ("ParticipantGuid", "SurveyType") DO UPDATE SET
            "Token" = EXCLUDED."Token", "ExpiresAt" = EXCLUDED."ExpiresAt", "CreatedAt" = NOW()
        `;

        const { subject, html } = buildConsentLinkEmail(resolvedLang === 'en' ? 'en' : 'sr', {
          url: `${CONSENT_APP_URL}/link/${token}`,
          senderName,
        });
        await sendMail({ to: resolvedEmail, subject, html, fromName: senderName });
        sent++;
      } catch (err) {
        console.error('[consent-form/mailing-list] row error:', err?.message ?? err);
        errors.push({ row: i + 1, reasonCode: 'SEND_FAILED' });
      }
    }

    res.json({ sent, errors });
  } catch (err) {
    console.error('[consent-form/mailing-list] error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
