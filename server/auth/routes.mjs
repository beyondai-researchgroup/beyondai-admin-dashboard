import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db.mjs';
import { signToken } from './jwt.mjs';

const router = Router();

// Public — no requireAuth. Login switched from Username to Email (2026-08-20, researcher profile
// system) — there is still no self-registration; accounts are created by a superadmin via
// server/researcher-invite/routes.mjs, which emails a magic-link invite instead of a password.
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT r."Id", r."Email", r."FirstName", r."LastName", r."PasswordHash", r."IsSuperAdmin", r."MustChangePassword"
      FROM "Researcher" r
      WHERE LOWER(r."Email") = LOWER(${email.trim()})
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || !bcrypt.compareSync(password, row.PasswordHash)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    if (row.MustChangePassword) {
      // Shouldn't normally be reachable — an invited account's temp password is random and
      // never surfaced to anyone, so nobody should be able to type it in here. Still guard
      // against it explicitly (a superadmin resetting a password some other way, etc.) rather
      // than silently letting a "must change password" account log in as if nothing were
      // pending.
      res.status(403).json({ error: 'MUST_CHANGE_PASSWORD' });
      return;
    }

    // Every research this researcher is assigned to (empty for a superadmin — they see
    // everything regardless of join rows, per scope.mjs).
    const assigned = await sql`
      SELECT rr."ResearchId", rr."Role", res."Name" AS "ResearchName"
      FROM "ResearcherResearch" rr
      JOIN "Research" res ON res."Id" = rr."ResearchId"
      WHERE rr."ResearcherId" = ${row.Id}
      ORDER BY res."Name"
    `;

    const researcher = {
      id: row.Id,
      email: row.Email,
      firstName: row.FirstName,
      lastName: row.LastName,
      isSuperAdmin: row.IsSuperAdmin,
      researchIds: assigned.map((a) => a.ResearchId),
      // Role granularity (Phase 6) — resolved once at login, same staleness trade-off
      // researchIds/isSuperAdmin already accept (see scope.mjs's doc comment).
      researchRoles: Object.fromEntries(assigned.map((a) => [a.ResearchId, a.Role])),
    };
    const token = signToken(researcher);

    res.json({
      token,
      researcher: {
        ...researcher,
        researches: assigned.map((a) => ({ id: a.ResearchId, name: a.ResearchName, role: a.Role })),
      },
    });
  } catch (err) {
    console.error('[auth] login error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
