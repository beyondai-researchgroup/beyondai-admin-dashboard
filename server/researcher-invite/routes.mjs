import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.mjs';

// Public — no requireAuth (the researcher isn't logged in yet; the one-time token itself is the
// authentication). Mirrors the REI-40/Big Five magic-link resolution pattern from
// rei40-andrejkatin's server.mjs (GET /api/link/:token): NOT_FOUND -> EXPIRED -> ALREADY_USED,
// same 3-tier error shape. "Already used" is inferred from Researcher.MustChangePassword having
// already flipped to FALSE — no separate "consumed" flag on the token row itself, same
// infer-completion-from-downstream-state pattern SurveyAccessToken established.
const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

async function resolveToken(sql, token) {
  const rows = await sql`
    SELECT t."Id" AS "TokenId", t."ExpiresAt", r."Id" AS "ResearcherId", r."Email", r."FirstName",
           r."LastName", r."MustChangePassword"
    FROM "ResearcherInviteToken" t
    JOIN "Researcher" r ON r."Id" = t."ResearcherId"
    WHERE t."Token" = ${token}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

router.get('/:token', async (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }

  try {
    const sql = getDb();
    const row = await resolveToken(sql, token);
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (!row.MustChangePassword) {
      res.status(409).json({ error: 'ALREADY_USED' });
      return;
    }
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }
    res.json({ email: row.Email, firstName: row.FirstName, lastName: row.LastName });
  } catch (err) {
    console.error('[researcher-invite] resolve error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:token/accept', async (req, res) => {
  const { token } = req.params;
  const { newPassword } = req.body ?? {};
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: 'NOT_FOUND' });
    return;
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  try {
    const sql = getDb();
    const row = await resolveToken(sql, token);
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (!row.MustChangePassword) {
      res.status(409).json({ error: 'ALREADY_USED' });
      return;
    }
    if (new Date(row.ExpiresAt) < new Date()) {
      res.status(410).json({ error: 'EXPIRED' });
      return;
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    await sql`
      UPDATE "Researcher" SET "PasswordHash" = ${passwordHash}, "MustChangePassword" = FALSE
      WHERE "Id" = ${row.ResearcherId}
    `;
    // Token row itself is left in place (harmless — resolution now 409s ALREADY_USED via the
    // MustChangePassword check above) rather than deleted, consistent with SurveyAccessToken's
    // own no-delete-on-completion precedent.
    res.json({ ok: true });
  } catch (err) {
    console.error('[researcher-invite] accept error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
