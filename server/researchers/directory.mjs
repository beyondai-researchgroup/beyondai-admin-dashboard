import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';

// Part B of the platform re-architecture (2026-09-07): a non-superadmin researcher who owns a
// research can add any EXISTING researcher to it (see researches/routes.mjs's team endpoints) —
// they need a way to pick from the full researcher list first. Deliberately NOT superadmin-gated
// (any authenticated researcher may read this), but deliberately narrow: only the fields needed
// for a picker, nothing sensitive (no email... actually email IS included, since it's how a
// researcher recognizes a colleague in the picker — but nothing else: no password state, no
// research assignments, no academic/personal fields). Full profile management stays exclusively
// on the superadmin-gated server/researchers/routes.mjs.
const router = Router();
router.use(requireAuth);

router.get('/directory', async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "Id", "FirstName", "LastName", "Email" FROM "Researcher" ORDER BY "FirstName", "LastName"
    `;
    res.json(rows.map((r) => ({ id: r.Id, firstName: r.FirstName, lastName: r.LastName, email: r.Email })));
  } catch (err) {
    console.error('[researchers/directory] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
