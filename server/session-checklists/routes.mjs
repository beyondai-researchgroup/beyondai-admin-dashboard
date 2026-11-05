import { Router } from 'express';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';

// Checklist of an experimental session: a template (the items every termin of the session starts with) and, for each termin
// (an "individual session": one time slot for a participant, a group or everyone), its own copy the researcher can change and
// tick off. Template edits spread to the copies: an added item is appended to every copy, a removed one is taken off the copies
// where it is not ticked yet (a ticked one stays as history), a renamed one is renamed everywhere.
const router = Router();
router.use(requireAuth);

const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];
const MAX_TEXT = 300;
const MAX_ITEMS = 40;

const cleanText = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const validText = (t) => t.length > 0 && t.length <= MAX_TEXT;

function scopeGuard(req, res, researchId) {
  try {
    resolveResearchScope(req.researcher, researchId);
    return true;
  } catch (err) {
    if (err instanceof ScopeForbiddenError) { res.status(403).json({ error: err.message }); return false; }
    throw err;
  }
}

async function loadSession(req, res, sql, id, write) {
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return null; }
  const rows = await sql`SELECT * FROM "ExperimentalSession" WHERE "Id" = ${id} LIMIT 1`;
  if (!rows.length) { res.status(404).json({ error: 'Experimental session not found' }); return null; }
  if (!scopeGuard(req, res, rows[0].ResearchId)) return null;
  if (write && !hasMinRole(req.researcher, rows[0].ResearchId, WRITE_ROLES)) { res.status(403).json({ error: 'INSUFFICIENT_ROLE' }); return null; }
  return rows[0];
}

async function loadTemplate(sql, sessionId) {
  return sql`SELECT "Id","Text","SortOrder" FROM "ExperimentalSessionChecklistItem" WHERE "ExperimentalSessionId" = ${sessionId} ORDER BY "SortOrder","Id"`;
}

/** Gives every termin of the session a checklist (a copy of the template) if it has none yet. */
async function materialize(sql, session, template) {
  const slots = await sql`
    SELECT s."Id" FROM "SessionSlot" s
    WHERE s."ExperimentalSessionId" = ${session.Id}
      AND NOT EXISTS (SELECT 1 FROM "SessionSlotChecklist" c WHERE c."SlotId" = s."Id")
  `;
  for (const slot of slots) {
    const created = await sql`
      INSERT INTO "SessionSlotChecklist" ("SlotId") VALUES (${slot.Id}) ON CONFLICT ("SlotId") DO NOTHING RETURNING "Id"
    `;
    if (!created.length) continue; // created by a parallel request
    for (let i = 0; i < template.length; i++) {
      await sql`INSERT INTO "SessionSlotChecklistItem" ("ChecklistId","TemplateItemId","SortOrder","Text") VALUES (${created[0].Id}, ${template[i].Id}, ${i}, ${template[i].Text})`;
    }
  }
}

router.get('/:sessionId', async (req, res) => {
  try {
    const sql = getDb();
    const session = await loadSession(req, res, sql, Number(req.params.sessionId), false);
    if (!session) return;
    const template = await loadTemplate(sql, session.Id);
    await materialize(sql, session, template);

    const slots = await sql`
      SELECT s."Id", TO_CHAR(s."StartTime", 'HH24:MI') AS "StartTime", s."DurationMinutes", s."Kind", s."Location", s."AudienceType", g."Name" AS "GroupName",
             COALESCE((SELECT array_agg(p."ParticipantId" ORDER BY p."ParticipantId") FROM "SessionSlotAttendee" a JOIN "Participant" p ON p."Guid" = a."ParticipantGuid" WHERE a."SlotId" = s."Id"), '{}') AS "Attendees"
      FROM "SessionSlot" s LEFT JOIN "ResearchGroup" g ON g."Id" = s."GroupId"
      WHERE s."ExperimentalSessionId" = ${session.Id} ORDER BY s."StartTime", s."Id"
    `;
    const items = await sql`
      SELECT c."SlotId", i."Id", i."Text", i."IsDone", i."DoneAt", i."TemplateItemId",
             NULLIF(TRIM(COALESCE(r."FirstName",'') || ' ' || COALESCE(r."LastName",'')), '') AS "DoneBy"
      FROM "SessionSlotChecklist" c JOIN "SessionSlotChecklistItem" i ON i."ChecklistId" = c."Id"
      JOIN "SessionSlot" s ON s."Id" = c."SlotId"
      LEFT JOIN "Researcher" r ON r."Id" = i."DoneByResearcherId"
      WHERE s."ExperimentalSessionId" = ${session.Id} ORDER BY i."SortOrder", i."Id"
    `;
    const bySlot = new Map();
    for (const it of items) {
      const list = bySlot.get(it.SlotId) ?? [];
      list.push({ id: it.Id, text: it.Text, done: it.IsDone, doneAt: it.DoneAt, doneBy: it.DoneBy ?? null, fromTemplate: it.TemplateItemId != null });
      bySlot.set(it.SlotId, list);
    }
    res.json({
      canWrite: hasMinRole(req.researcher, session.ResearchId, WRITE_ROLES),
      template: template.map((t) => ({ id: t.Id, text: t.Text })),
      slots: slots.map((s) => {
        const list = bySlot.get(s.Id) ?? [];
        return {
          slotId: s.Id, startTime: s.StartTime, durationMinutes: s.DurationMinutes, kind: s.Kind, location: s.Location,
          audienceType: s.AudienceType, groupName: s.GroupName ?? null, attendees: s.Attendees ?? [],
          items: list, doneCount: list.filter((x) => x.done).length,
        };
      }),
    });
  } catch (err) {
    console.error('[session-checklists] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Replaces the template with the given list (items with an id are kept / renamed, the rest are new, missing ones are removed).
router.put('/:sessionId/template', async (req, res) => {
  try {
    const sql = getDb();
    const session = await loadSession(req, res, sql, Number(req.params.sessionId), true);
    if (!session) return;
    const raw = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!raw || raw.length > MAX_ITEMS) { res.status(400).json({ error: 'INVALID_ITEMS' }); return; }
    const items = [];
    for (const r of raw) {
      const text = cleanText(r?.text);
      if (!validText(text)) { res.status(400).json({ error: 'INVALID_TEXT' }); return; }
      const id = r?.id == null ? null : Number(r.id);
      if (id != null && !Number.isInteger(id)) { res.status(400).json({ error: 'INVALID_ITEMS' }); return; }
      items.push({ id, text });
    }
    const existing = await loadTemplate(sql, session.Id);
    const existingIds = new Set(existing.map((e) => e.Id));
    if (items.some((i) => i.id != null && !existingIds.has(i.id))) { res.status(400).json({ error: 'UNKNOWN_ITEM' }); return; }
    const keep = new Set(items.filter((i) => i.id != null).map((i) => i.id));

    for (const e of existing) {
      if (keep.has(e.Id)) continue;
      // taken off the copies where it is not ticked yet; a ticked one stays (its link to the template is cleared by the FK)
      await sql`DELETE FROM "SessionSlotChecklistItem" WHERE "TemplateItemId" = ${e.Id} AND "IsDone" = FALSE`;
      await sql`DELETE FROM "ExperimentalSessionChecklistItem" WHERE "Id" = ${e.Id}`;
    }
    const lists = await sql`
      SELECT c."Id" FROM "SessionSlotChecklist" c JOIN "SessionSlot" s ON s."Id" = c."SlotId" WHERE s."ExperimentalSessionId" = ${session.Id}
    `;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.id != null) {
        await sql`UPDATE "ExperimentalSessionChecklistItem" SET "Text" = ${it.text}, "SortOrder" = ${i} WHERE "Id" = ${it.id}`;
        await sql`UPDATE "SessionSlotChecklistItem" SET "Text" = ${it.text} WHERE "TemplateItemId" = ${it.id}`;
      } else {
        const added = await sql`INSERT INTO "ExperimentalSessionChecklistItem" ("ExperimentalSessionId","SortOrder","Text") VALUES (${session.Id}, ${i}, ${it.text}) RETURNING "Id"`;
        for (const l of lists) {
          await sql`
            INSERT INTO "SessionSlotChecklistItem" ("ChecklistId","TemplateItemId","SortOrder","Text")
            VALUES (${l.Id}, ${added[0].Id}, COALESCE((SELECT MAX("SortOrder") + 1 FROM "SessionSlotChecklistItem" WHERE "ChecklistId" = ${l.Id}), 0), ${it.text})
          `;
        }
      }
    }
    res.json({ ok: true, template: (await loadTemplate(sql, session.Id)).map((t) => ({ id: t.Id, text: t.Text })) });
  } catch (err) {
    console.error('[session-checklists] template error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// A termin's own list: add an item to it (only that termin, not the template).
router.post('/:sessionId/slots/:slotId/items', async (req, res) => {
  try {
    const sql = getDb();
    const session = await loadSession(req, res, sql, Number(req.params.sessionId), true);
    if (!session) return;
    const slotId = Number(req.params.slotId);
    if (!Number.isInteger(slotId) || slotId <= 0) { res.status(400).json({ error: 'Invalid id' }); return; }
    const text = cleanText(req.body?.text);
    if (!validText(text)) { res.status(400).json({ error: 'INVALID_TEXT' }); return; }
    const lists = await sql`
      SELECT c."Id" FROM "SessionSlotChecklist" c JOIN "SessionSlot" s ON s."Id" = c."SlotId"
      WHERE c."SlotId" = ${slotId} AND s."ExperimentalSessionId" = ${session.Id} LIMIT 1
    `;
    if (!lists.length) { res.status(404).json({ error: 'NO_CHECKLIST' }); return; }
    const count = (await sql`SELECT COUNT(*)::int AS n FROM "SessionSlotChecklistItem" WHERE "ChecklistId" = ${lists[0].Id}`)[0].n;
    if (count >= MAX_ITEMS * 2) { res.status(400).json({ error: 'TOO_MANY_ITEMS' }); return; }
    const added = await sql`
      INSERT INTO "SessionSlotChecklistItem" ("ChecklistId","SortOrder","Text")
      VALUES (${lists[0].Id}, COALESCE((SELECT MAX("SortOrder") + 1 FROM "SessionSlotChecklistItem" WHERE "ChecklistId" = ${lists[0].Id}), 0), ${text}) RETURNING "Id"
    `;
    res.status(201).json({ id: added[0].Id });
  } catch (err) {
    console.error('[session-checklists] add item error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/** Loads one termin-list item with its session, checking scope and the write role. */
async function loadItem(req, res, sql) {
  const id = Number(req.params.itemId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return null; }
  const rows = await sql`
    SELECT i.*, s."ExperimentalSessionId", s."ResearchId"
    FROM "SessionSlotChecklistItem" i JOIN "SessionSlotChecklist" c ON c."Id" = i."ChecklistId" JOIN "SessionSlot" s ON s."Id" = c."SlotId"
    WHERE i."Id" = ${id} LIMIT 1
  `;
  if (!rows.length) { res.status(404).json({ error: 'Item not found' }); return null; }
  if (!scopeGuard(req, res, rows[0].ResearchId)) return null;
  if (!hasMinRole(req.researcher, rows[0].ResearchId, WRITE_ROLES)) { res.status(403).json({ error: 'INSUFFICIENT_ROLE' }); return null; }
  return rows[0];
}

// Tick / untick an item of a termin's list, or rename it.
router.put('/items/:itemId', async (req, res) => {
  try {
    const sql = getDb();
    const item = await loadItem(req, res, sql);
    if (!item) return;
    const { done, text } = req.body ?? {};
    if (done !== undefined && typeof done !== 'boolean') { res.status(400).json({ error: 'INVALID_DONE' }); return; }
    const newText = text === undefined ? null : cleanText(text);
    if (newText !== null && !validText(newText)) { res.status(400).json({ error: 'INVALID_TEXT' }); return; }
    if (done !== undefined) {
      await sql`
        UPDATE "SessionSlotChecklistItem"
        SET "IsDone" = ${done}, "DoneAt" = ${done ? new Date().toISOString() : null}::timestamptz, "DoneByResearcherId" = ${done ? req.researcher.id : null}
        WHERE "Id" = ${item.Id}
      `;
    }
    if (newText !== null) await sql`UPDATE "SessionSlotChecklistItem" SET "Text" = ${newText} WHERE "Id" = ${item.Id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[session-checklists] item update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Removes an item from one termin's list only (the template and the other lists stay).
router.delete('/items/:itemId', async (req, res) => {
  try {
    const sql = getDb();
    const item = await loadItem(req, res, sql);
    if (!item) return;
    await sql`DELETE FROM "SessionSlotChecklistItem" WHERE "Id" = ${item.Id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[session-checklists] item delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
