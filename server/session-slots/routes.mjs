// Session slots ("termini") inside an experimental session, PROTOCOL researches only.
//
// An experimental session is a day; a slot is one concrete appointment on that day: one start time,
// a type (ONLINE with an optional meeting link, IN_PERSON with a location), and an audience that is
// one or more chosen participants, a whole group, or every participant of the research. The audience
// is resolved when the slot is created and stored as attendee rows (a participant who joins the group
// later is added with "syncGroup", existing slots are never silently changed). One Google Calendar
// event per slot, with every attendee that has an e-mail as a guest.
//
// Own router and base path (the older experimental-sessions router keeps the classic per-participant
// flow for CLASSIC researches and is not touched by this one). Attendees are keyed by Participant.Guid,
// never by the bare ParticipantId string (ids are only unique inside a research).
import { Router } from 'express';
import { runInBackground } from '../background.mjs';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { hasMinRole } from '../roles.mjs';
import { dateOnly } from '../date-only.mjs';
import { createEvent, updateEvent, deleteEvent } from '../calendar/googleCalendar.mjs';
import { decrypt } from '../calendar/tokenCrypto.mjs';
import { isValidTags } from '../experimental-sessions/routes.mjs';
import { buildSlotEvent } from './slot-calendar.mjs';

const router = Router();
router.use(requireAuth);

const WRITE_ROLES = ['OWNER', 'COLLABORATOR'];
const MAX_URL = 500;
const MAX_LOCATION = 300;
const MAX_NOTES = 4000;
const MAX_ATTENDEES = 500;
const KINDS = ['ONLINE', 'IN_PERSON'];
const AUDIENCES = ['PARTICIPANT', 'GROUP', 'ALL'];

function scopeGuard(req, res, researchId) {
  try {
    resolveResearchScope(req.researcher, researchId);
    return true;
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

function writeGuard(req, res, researchId) {
  if (hasMinRole(req.researcher, researchId, WRITE_ROLES)) return true;
  res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
  return false;
}

const isValidTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isId = (v) => Number.isInteger(v) && v > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(v, max) {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > max) return { ok: false };
  const t = v.trim();
  return { ok: true, value: t || null };
}

function cleanUrl(v) {
  const t = cleanText(v, MAX_URL);
  if (!t.ok) return t;
  if (t.value === null) return t;
  try {
    const u = new URL(t.value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false };
  } catch {
    return { ok: false };
  }
  return t;
}

/** Validates the fields shared by create and update. Returns { error } or { value }. */
function parseSlotFields(body) {
  const { startTime, kind } = body ?? {};
  const durationMinutes = body?.durationMinutes === undefined ? 45 : body.durationMinutes;
  if (!isValidTime(startTime)) return { error: 'INVALID_TIME' };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) return { error: 'INVALID_DURATION' };
  if (!KINDS.includes(kind)) return { error: 'INVALID_KIND' };
  const notes = cleanText(body?.notes, MAX_NOTES);
  if (!notes.ok) return { error: 'INVALID_NOTES' };
  let meetingUrl = null;
  let location = null;
  if (kind === 'ONLINE') {
    const u = cleanUrl(body?.meetingUrl);
    if (!u.ok) return { error: 'INVALID_URL' };
    meetingUrl = u.value;
  } else {
    const l = cleanText(body?.location, MAX_LOCATION);
    if (!l.ok || !l.value) return { error: 'LOCATION_REQUIRED' };
    location = l.value;
  }
  return { value: { startTime, durationMinutes, kind, meetingUrl, location, notes: notes.value } };
}

async function getResearcherRefreshToken(sql, researcherId) {
  if (!researcherId) return null;
  try {
    const rows = await sql`SELECT "GoogleCalendarRefreshTokenEnc" FROM "Researcher" WHERE "Id" = ${researcherId} LIMIT 1`;
    const enc = rows[0]?.GoogleCalendarRefreshTokenEnc;
    return enc ? decrypt(enc) : null;
  } catch (err) {
    console.error('[session-slots] failed to resolve researcher calendar token:', err);
    return null;
  }
}

/** The experimental session row of a PROTOCOL research, scope-checked; answers and returns null otherwise. */
async function loadSession(req, res, sql, id) {
  if (!isId(id)) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  const rows = await sql`
    SELECT es."Id", es."ResearchId", es."SessionDate", es."Label", r."FlowMode"
    FROM "ExperimentalSession" es JOIN "Research" r ON r."Id" = es."ResearchId" WHERE es."Id" = ${id} LIMIT 1
  `;
  if (!rows[0]) {
    res.status(404).json({ error: 'Experimental session not found' });
    return null;
  }
  if (!scopeGuard(req, res, rows[0].ResearchId)) return null;
  if (rows[0].FlowMode !== 'PROTOCOL') {
    res.status(400).json({ error: 'NOT_PROTOCOL' });
    return null;
  }
  return rows[0];
}

async function loadSlotRow(req, res, sql, slotId) {
  if (!isId(slotId)) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  const rows = await sql`
    SELECT s.*, es."SessionDate", es."Label" AS "SessionLabel", r."FlowMode",
           TO_CHAR(s."StartTime", 'HH24:MI') AS "StartHm", st."TitleSr" AS "StepTitle"
    FROM "SessionSlot" s
    JOIN "ExperimentalSession" es ON es."Id" = s."ExperimentalSessionId"
    JOIN "Research" r ON r."Id" = s."ResearchId"
    LEFT JOIN "ResearchProtocolStep" st ON st."Id" = s."ProtocolStepId"
    WHERE s."Id" = ${slotId} LIMIT 1
  `;
  if (!rows[0]) {
    res.status(404).json({ error: 'Slot not found' });
    return null;
  }
  if (!scopeGuard(req, res, rows[0].ResearchId)) return null;
  if (rows[0].FlowMode !== 'PROTOCOL') {
    res.status(400).json({ error: 'NOT_PROTOCOL' });
    return null;
  }
  return rows[0];
}

/** Participants of the audience: [{ guid, participantId, email }]. null when a given id is not in the research. */
async function resolveAudience(sql, researchId, { audienceType, groupId, participantIds }) {
  if (audienceType === 'ALL') {
    return sql`SELECT "Guid" AS guid, "ParticipantId" AS "participantId", "Email" AS email FROM "Participant" WHERE "ResearchId" = ${researchId} ORDER BY "ParticipantId"`;
  }
  if (audienceType === 'GROUP') {
    return sql`
      SELECT "Guid" AS guid, "ParticipantId" AS "participantId", "Email" AS email FROM "Participant"
      WHERE "ResearchId" = ${researchId} AND "GroupId" = ${groupId} ORDER BY "ParticipantId"`;
  }
  const rows = await sql`
    SELECT "Guid" AS guid, "ParticipantId" AS "participantId", "Email" AS email FROM "Participant"
    WHERE "ResearchId" = ${researchId} AND "ParticipantId" = ANY(${participantIds}) ORDER BY "ParticipantId"`;
  return rows.length === participantIds.length ? rows : null;
}

/** Attendees that already have a slot for the same protocol step (the one being edited is ignored). */
async function findConflicts(sql, stepId, guids, exceptSlotId = 0) {
  if (!stepId || !guids.length) return [];
  return sql`
    SELECT DISTINCT p."ParticipantId" AS "participantId", a."ParticipantGuid" AS guid
    FROM "SessionSlotAttendee" a
    JOIN "SessionSlot" s ON s."Id" = a."SlotId"
    JOIN "Participant" p ON p."Guid" = a."ParticipantGuid"
    WHERE s."ProtocolStepId" = ${stepId} AND s."Id" <> ${exceptSlotId} AND a."ParticipantGuid" = ANY(${guids})
    ORDER BY p."ParticipantId"`;
}

async function loadSlotsDetail(sql, slots) {
  if (!slots.length) return [];
  const ids = slots.map((s) => s.Id);
  const attendees = await sql`
    SELECT a."SlotId", p."Guid", p."ParticipantId", p."Email", p."GroupId", g."Name" AS "GroupName"
    FROM "SessionSlotAttendee" a JOIN "Participant" p ON p."Guid" = a."ParticipantGuid"
    LEFT JOIN "ResearchGroup" g ON g."Id" = p."GroupId"
    WHERE a."SlotId" = ANY(${ids}) ORDER BY p."ParticipantId"`;
  const bySlot = new Map();
  for (const a of attendees) {
    const list = bySlot.get(a.SlotId) ?? [];
    list.push({ guid: a.Guid, participantId: a.ParticipantId, hasEmail: !!a.Email, groupId: a.GroupId ?? null, groupName: a.GroupName ?? null });
    bySlot.set(a.SlotId, list);
  }
  return slots.map((s) => ({
    id: s.Id,
    experimentalSessionId: s.ExperimentalSessionId,
    startTime: s.StartHm,
    durationMinutes: s.DurationMinutes,
    kind: s.Kind,
    meetingUrl: s.MeetingUrl,
    location: s.Location,
    audienceType: s.AudienceType,
    groupId: s.GroupId ?? null,
    groupName: s.GroupName ?? null,
    protocolStepId: s.ProtocolStepId ?? null,
    stepTitleSr: s.StepTitleSr ?? null,
    stepTitleEn: s.StepTitleEn ?? null,
    notes: s.Notes,
    tags: s.Tags ?? [],
    googleCalendarEventId: s.GoogleCalendarEventId ?? null,
    googleCalendarEventUrl: s.GoogleCalendarEventUrl ?? null,
    attendees: bySlot.get(s.Id) ?? [],
  }));
}

async function attendeeEmails(sql, slotId) {
  return sql`
    SELECT p."Email" AS email FROM "SessionSlotAttendee" a JOIN "Participant" p ON p."Guid" = a."ParticipantGuid"
    WHERE a."SlotId" = ${slotId}`;
}

/** Re-projects an existing slot onto its Google event (time, place, guests). Best-effort. */
function syncEvent(sql, slotId) {
  runInBackground(async () => {
    const rows = await sql`
      SELECT s.*, es."SessionDate", es."Label" AS "SessionLabel", TO_CHAR(s."StartTime", 'HH24:MI') AS "StartHm"
      FROM "SessionSlot" s JOIN "ExperimentalSession" es ON es."Id" = s."ExperimentalSessionId"
      WHERE s."Id" = ${slotId} LIMIT 1`;
    const s = rows[0];
    if (!s?.GoogleCalendarEventId) return;
    const refreshToken = await getResearcherRefreshToken(sql, s.GoogleCalendarResearcherId);
    if (!refreshToken) return;
    const ev = buildSlotEvent(
      { kind: s.Kind, meetingUrl: s.MeetingUrl, location: s.Location, durationMinutes: s.DurationMinutes },
      { label: s.SessionLabel }, await attendeeEmails(sql, slotId),
    );
    await updateEvent({
      refreshToken, eventId: s.GoogleCalendarEventId, date: dateOnly(s.SessionDate), time: s.StartHm,
      durationMinutes: ev.durationMinutes, summary: ev.summary, description: ev.description, location: ev.location, attendeeEmails: ev.attendeeEmails,
    });
  }, 'session-slots calendar sync (update)');
}

// ── list the slots of an experimental session ────────────────────────────────────────────────────
router.get('/:experimentalSessionId', async (req, res) => {
  try {
    const sql = getDb();
    const session = await loadSession(req, res, sql, Number(req.params.experimentalSessionId));
    if (!session) return;
    const rows = await sql`
      SELECT s.*, TO_CHAR(s."StartTime", 'HH24:MI') AS "StartHm", g."Name" AS "GroupName",
             st."TitleSr" AS "StepTitleSr", st."TitleEn" AS "StepTitleEn"
      FROM "SessionSlot" s LEFT JOIN "ResearchGroup" g ON g."Id" = s."GroupId"
      LEFT JOIN "ResearchProtocolStep" st ON st."Id" = s."ProtocolStepId"
      WHERE s."ExperimentalSessionId" = ${session.Id}
      ORDER BY s."StartTime", s."Id"`;
    const slots = await loadSlotsDetail(sql, rows);
    res.json({ slots, calendarConnected: !!(await getResearcherRefreshToken(sql, req.researcher.id)) });
  } catch (err) {
    console.error('[session-slots] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── create a slot ────────────────────────────────────────────────────────────────────────────────
router.post('/:experimentalSessionId', async (req, res) => {
  try {
    const sql = getDb();
    const session = await loadSession(req, res, sql, Number(req.params.experimentalSessionId));
    if (!session) return;
    if (!writeGuard(req, res, session.ResearchId)) return;
    const researchId = session.ResearchId;

    const parsed = parseSlotFields(req.body);
    if (parsed.error) return void res.status(400).json({ error: parsed.error });
    const f = parsed.value;

    const { audienceType } = req.body ?? {};
    if (!AUDIENCES.includes(audienceType)) return void res.status(400).json({ error: 'INVALID_AUDIENCE' });
    let groupId = null;
    let participantIds = [];
    if (audienceType === 'GROUP') {
      groupId = req.body.groupId;
      if (!isId(groupId)) return void res.status(400).json({ error: 'GROUP_REQUIRED' });
      const g = await sql`SELECT 1 FROM "ResearchGroup" WHERE "Id" = ${groupId} AND "ResearchId" = ${researchId}`;
      if (!g[0]) return void res.status(400).json({ error: 'UNKNOWN_GROUP' });
    } else if (audienceType === 'PARTICIPANT') {
      participantIds = req.body.participantIds;
      if (!Array.isArray(participantIds) || !participantIds.length || participantIds.some((p) => typeof p !== 'string' || !p)) {
        return void res.status(400).json({ error: 'PARTICIPANTS_REQUIRED' });
      }
      participantIds = [...new Set(participantIds)];
    }

    let protocolStepId = null;
    if (req.body.protocolStepId !== undefined && req.body.protocolStepId !== null) {
      protocolStepId = req.body.protocolStepId;
      if (!isId(protocolStepId)) return void res.status(400).json({ error: 'UNKNOWN_STEP' });
      const st = await sql`SELECT 1 FROM "ResearchProtocolStep" WHERE "Id" = ${protocolStepId} AND "ResearchId" = ${researchId}`;
      if (!st[0]) return void res.status(400).json({ error: 'UNKNOWN_STEP' });
    }

    let attendees = await resolveAudience(sql, researchId, { audienceType, groupId, participantIds });
    if (attendees === null) return void res.status(400).json({ error: 'UNKNOWN_PARTICIPANT' });
    // A group / everyone slot may start with nobody in it yet (participants are imported later and added with "syncGroup").
    if (!attendees.length && audienceType === 'PARTICIPANT') return void res.status(400).json({ error: 'NO_ATTENDEES' });
    if (attendees.length > MAX_ATTENDEES) return void res.status(400).json({ error: 'TOO_MANY_ATTENDEES' });

    const conflicts = await findConflicts(sql, protocolStepId, attendees.map((a) => a.guid));
    if (conflicts.length) {
      if (req.body.skipConflicts !== true) {
        return void res.status(409).json({ error: 'ALREADY_SCHEDULED', conflicts: conflicts.map((c) => c.participantId) });
      }
      const skip = new Set(conflicts.map((c) => c.guid));
      attendees = attendees.filter((a) => !skip.has(a.guid));
      if (!attendees.length && audienceType === 'PARTICIPANT') return void res.status(400).json({ error: 'NO_ATTENDEES' });
    }

    const inserted = await sql`
      INSERT INTO "SessionSlot" ("ExperimentalSessionId","ResearchId","StartTime","DurationMinutes","Kind","MeetingUrl","Location",
                                 "AudienceType","GroupId","ProtocolStepId","Notes","CreatedByResearcherId")
      VALUES (${session.Id}, ${researchId}, ${f.startTime}, ${f.durationMinutes}, ${f.kind}, ${f.meetingUrl}, ${f.location},
              ${audienceType}, ${groupId}, ${protocolStepId}, ${f.notes}, ${req.researcher.id})
      RETURNING "Id"`;
    const slotId = inserted[0].Id;
    if (attendees.length) {
      await sql`
        INSERT INTO "SessionSlotAttendee" ("SlotId","ParticipantGuid")
        SELECT ${slotId}, UNNEST(${attendees.map((a) => a.guid)}::uuid[])`;
    }

    const refreshToken = await getResearcherRefreshToken(sql, req.researcher.id);
    res.status(201).json({
      id: slotId,
      attendeeCount: attendees.length,
      withoutEmail: attendees.filter((a) => !a.email).length,
      skipped: conflicts.length,
      calendarConnected: !!refreshToken,
    });

    if (refreshToken) {
      runInBackground(async () => {
        const ev = buildSlotEvent(f, { label: session.Label }, attendees);
        const created = await createEvent({
          refreshToken, summary: ev.summary, description: ev.description, location: ev.location,
          date: dateOnly(session.SessionDate), time: f.startTime, durationMinutes: ev.durationMinutes, attendeeEmails: ev.attendeeEmails,
        });
        if (created.id) {
          await sql`
            UPDATE "SessionSlot" SET "GoogleCalendarEventId" = ${created.id}, "GoogleCalendarEventUrl" = ${created.htmlLink},
                                     "GoogleCalendarResearcherId" = ${req.researcher.id} WHERE "Id" = ${slotId}`;
        }
      }, 'session-slots calendar sync (create)');
    }
  } catch (err) {
    console.error('[session-slots] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── edit a slot (time, type, place, note) ───────────────────────────────────────────────────────
router.put('/slot/:slotId', async (req, res) => {
  try {
    const sql = getDb();
    const slot = await loadSlotRow(req, res, sql, Number(req.params.slotId));
    if (!slot) return;
    if (!writeGuard(req, res, slot.ResearchId)) return;
    const parsed = parseSlotFields(req.body);
    if (parsed.error) return void res.status(400).json({ error: parsed.error });
    const f = parsed.value;
    await sql`
      UPDATE "SessionSlot" SET "StartTime" = ${f.startTime}, "DurationMinutes" = ${f.durationMinutes}, "Kind" = ${f.kind},
             "MeetingUrl" = ${f.meetingUrl}, "Location" = ${f.location}, "Notes" = ${f.notes}
      WHERE "Id" = ${slot.Id}`;
    res.json({ ok: true });
    syncEvent(sql, slot.Id);
  } catch (err) {
    console.error('[session-slots] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── add attendees (chosen ones, or the members that joined the group / the research later) ──────
router.post('/slot/:slotId/attendees', async (req, res) => {
  try {
    const sql = getDb();
    const slot = await loadSlotRow(req, res, sql, Number(req.params.slotId));
    if (!slot) return;
    if (!writeGuard(req, res, slot.ResearchId)) return;

    let candidates;
    if (req.body?.syncGroup === true) {
      if (slot.AudienceType === 'PARTICIPANT') return void res.status(400).json({ error: 'NOTHING_TO_SYNC' });
      candidates = await resolveAudience(sql, slot.ResearchId, { audienceType: slot.AudienceType, groupId: slot.GroupId, participantIds: [] });
    } else {
      const ids = req.body?.participantIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((p) => typeof p !== 'string' || !p)) {
        return void res.status(400).json({ error: 'PARTICIPANTS_REQUIRED' });
      }
      candidates = await resolveAudience(sql, slot.ResearchId, { audienceType: 'PARTICIPANT', groupId: null, participantIds: [...new Set(ids)] });
      if (candidates === null) return void res.status(400).json({ error: 'UNKNOWN_PARTICIPANT' });
    }
    const existing = new Set((await sql`SELECT "ParticipantGuid" FROM "SessionSlotAttendee" WHERE "SlotId" = ${slot.Id}`).map((r) => r.ParticipantGuid));
    let fresh = candidates.filter((c) => !existing.has(c.guid));
    const conflicts = await findConflicts(sql, slot.ProtocolStepId, fresh.map((c) => c.guid), slot.Id);
    if (conflicts.length) {
      if (req.body?.skipConflicts !== true) {
        return void res.status(409).json({ error: 'ALREADY_SCHEDULED', conflicts: conflicts.map((c) => c.participantId) });
      }
      const skip = new Set(conflicts.map((c) => c.guid));
      fresh = fresh.filter((c) => !skip.has(c.guid));
    }
    if (existing.size + fresh.length > MAX_ATTENDEES) return void res.status(400).json({ error: 'TOO_MANY_ATTENDEES' });
    if (fresh.length) {
      await sql`INSERT INTO "SessionSlotAttendee" ("SlotId","ParticipantGuid") SELECT ${slot.Id}, UNNEST(${fresh.map((c) => c.guid)}::uuid[])`;
    }
    res.json({ added: fresh.length, withoutEmail: fresh.filter((c) => !c.email).length, skipped: conflicts.length });
    if (fresh.length) syncEvent(sql, slot.Id);
  } catch (err) {
    console.error('[session-slots] add attendees error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/slot/:slotId/attendees/:guid', async (req, res) => {
  try {
    const sql = getDb();
    const slot = await loadSlotRow(req, res, sql, Number(req.params.slotId));
    if (!slot) return;
    if (!writeGuard(req, res, slot.ResearchId)) return;
    const guid = String(req.params.guid);
    if (!UUID.test(guid)) return void res.status(400).json({ error: 'Invalid participant' });
    const gone = await sql`DELETE FROM "SessionSlotAttendee" WHERE "SlotId" = ${slot.Id} AND "ParticipantGuid" = ${guid}::uuid RETURNING 1 AS x`;
    if (!gone.length) return void res.status(404).json({ error: 'Attendee not found' });
    res.json({ ok: true });
    syncEvent(sql, slot.Id);
  } catch (err) {
    console.error('[session-slots] remove attendee error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/slot/:slotId/notes-tags', async (req, res) => {
  try {
    const sql = getDb();
    const slot = await loadSlotRow(req, res, sql, Number(req.params.slotId));
    if (!slot) return;
    if (!writeGuard(req, res, slot.ResearchId)) return;
    const notes = cleanText(req.body?.notes, MAX_NOTES);
    if (!notes.ok) return void res.status(400).json({ error: 'INVALID_NOTES' });
    const tags = req.body?.tags ?? [];
    if (!isValidTags(tags)) return void res.status(400).json({ error: 'INVALID_TAGS' });
    await sql`UPDATE "SessionSlot" SET "Notes" = ${notes.value}, "Tags" = ${JSON.stringify(tags)}::jsonb WHERE "Id" = ${slot.Id}`;
    res.json({ ok: true });
  } catch (err) {
    console.error('[session-slots] notes/tags error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.delete('/slot/:slotId', async (req, res) => {
  try {
    const sql = getDb();
    const slot = await loadSlotRow(req, res, sql, Number(req.params.slotId));
    if (!slot) return;
    if (!writeGuard(req, res, slot.ResearchId)) return;
    await sql`DELETE FROM "SessionSlot" WHERE "Id" = ${slot.Id}`;
    res.json({ ok: true });
    if (slot.GoogleCalendarEventId) {
      runInBackground(async () => {
        const refreshToken = await getResearcherRefreshToken(sql, slot.GoogleCalendarResearcherId);
        if (refreshToken) await deleteEvent({ refreshToken, eventId: slot.GoogleCalendarEventId });
      }, 'session-slots calendar sync (delete)');
    }
  } catch (err) {
    console.error('[session-slots] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
