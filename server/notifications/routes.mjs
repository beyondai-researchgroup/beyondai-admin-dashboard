import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';

// Notification list/read routes (2026-08-20) — always scoped to req.researcher.id, never a path
// param, same "no cross-researcher access surface" shape as researcher-profile/routes.mjs.
const router = Router();
router.use(requireAuth);

const LIST_LIMIT = 50;

router.get('/', async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT n."Id", n."ResearchId", res."Name" AS "ResearchName", n."Type", n."Message", n."IsRead", n."CreatedAt"
      FROM "Notification" n
      LEFT JOIN "Research" res ON res."Id" = n."ResearchId"
      WHERE n."ResearcherId" = ${req.researcher.id}
      ORDER BY n."CreatedAt" DESC
      LIMIT ${LIST_LIMIT}
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id,
        researchId: r.ResearchId,
        researchName: r.ResearchName,
        type: r.Type,
        message: r.Message,
        isRead: r.IsRead,
        createdAt: r.CreatedAt,
      }))
    );
  } catch (err) {
    console.error('[notifications] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT COUNT(*)::int AS "Count" FROM "Notification" WHERE "ResearcherId" = ${req.researcher.id} AND "IsRead" = FALSE
    `;
    res.json({ count: rows[0].Count });
  } catch (err) {
    console.error('[notifications] unread-count error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid notification id' });
    return;
  }
  try {
    const sql = getDb();
    await sql`
      UPDATE "Notification" SET "IsRead" = TRUE WHERE "Id" = ${id} AND "ResearcherId" = ${req.researcher.id}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] mark read error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/read-all', async (req, res) => {
  try {
    const sql = getDb();
    await sql`
      UPDATE "Notification" SET "IsRead" = TRUE WHERE "ResearcherId" = ${req.researcher.id} AND "IsRead" = FALSE
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] mark all read error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
