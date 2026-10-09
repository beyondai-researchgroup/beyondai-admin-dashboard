// Experimental Sessions: a physical day/timeslot within a Research where one or more
// participants are run through one or more of their Intro/AI/Report sessions. General notes/
// metadata live on the ExperimentalSession row itself; per-participant-per-session notes live on
// the ParticipantSession row it's assigned to (ExperimentalSessionId FK, nullable — unassigned
// by default, forward-looking only, see Sql/009_experimental_sessions.sql).
import { Router } from 'express';
import { runInBackground } from '../background.mjs';
import { getDb } from '../db.mjs';
import { requireAuth } from '../auth/middleware.mjs';
import { resolveResearchScope, ScopeForbiddenError } from '../scope.mjs';
import { createEvent, updateEvent, deleteEvent } from '../calendar/googleCalendar.mjs';
import { decrypt } from '../calendar/tokenCrypto.mjs';
import { notifyResearchMembers } from '../notifications/create.mjs';
import { hasMinRole } from '../roles.mjs';

const router = Router();
router.use(requireAuth);

const CALENDAR_EVENT_DURATION_MINUTES = 45;

const MAX_LABEL_LENGTH = 150;
const MAX_NOTES_LENGTH = 4000;
// One tag per participant-session — mirrors src/app/experimental-sessions/session-tags.ts's
// MAX_TAGS (keep both in sync); more than one made the table row's tag cell wrap/grow
// unpredictably, and a single flag is enough to mark "what happened" at a glance.
const MAX_TAGS = 1;
const MAX_CUSTOM_TAG_LENGTH = 30;

// Predefined tag vocabulary a researcher can attach to any individual participant-session, shown
// next to its Notes (see PREDEFINED_TAGS in the frontend's session-tags.ts, which must be kept in
// sync — this list is what the server actually validates against). A tag outside this list is
// only accepted as a "custom" tag (checked separately below).
const PREDEFINED_TAGS = ['SUCCESS', 'CORRUPTED', 'INTERRUPTED', 'TECHNICAL_ISSUE', 'REPEAT_NEEDED', 'NOTEWORTHY'];
const CUSTOM_TAG_PATTERN = /^[\p{L}\p{N} _-]+$/u;

function isValidTags(v) {
  if (!Array.isArray(v) || v.length > MAX_TAGS) return false;
  return v.every(
    (t) =>
      typeof t === 'string' &&
      (PREDEFINED_TAGS.includes(t) || (t.length > 0 && t.length <= MAX_CUSTOM_TAG_LENGTH && CUSTOM_TAG_PATTERN.test(t)))
  );
}

function scopeGuard(req, res, researchId) {
  try {
    return resolveResearchScope(req.researcher, researchId);
  } catch (err) {
    if (err instanceof ScopeForbiddenError) {
      res.status(403).json({ error: err.message });
      return undefined;
    }
    throw err;
  }
}

function isValidDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

// The neon serverless driver parses a Postgres DATE column using a local-timezone Date
// constructor (confirmed: a stored '2026-08-18' round-trips as a JS Date whose LOCAL getters
// give 2026-08-18, even though its UTC getters/toISOString show the previous day) — so reading
// it back with local getters (never getUTC*/toISOString) is what actually recovers the original
// calendar date. Emitting a plain 'YYYY-MM-DD' string (instead of a full ISO timestamp) is also
// what native `<input type="date">` elements require to populate correctly — a bare ISO-with-time
// string silently fails to load into the edit form.
function dateOnly(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isValidTime(v) {
  if (typeof v !== 'string') return false;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return false;
  const [, hh, mm] = m;
  return Number(hh) <= 23 && Number(mm) <= 59;
}

function isOptionalString(v, max) {
  return v === null || v === undefined || (typeof v === 'string' && v.length <= max);
}

// Looks up a researcher's own decrypted Calendar refresh token, or null if they haven't
// connected one (or CALENDAR_TOKEN_ENCRYPTION_KEY/decryption fails for any reason) — every
// calendar sync call site treats null as "skip sync, not an error".
async function getResearcherRefreshToken(sql, researcherId) {
  if (!researcherId) return null;
  try {
    const rows = await sql`
      SELECT "GoogleCalendarRefreshTokenEnc" FROM "Researcher" WHERE "Id" = ${researcherId} LIMIT 1
    `;
    const enc = rows[0]?.GoogleCalendarRefreshTokenEnc;
    return enc ? decrypt(enc) : null;
  } catch (err) {
    console.error('[experimental-sessions] failed to resolve researcher calendar token:', err);
    return null;
  }
}

// Resolves which research a specific ExperimentalSession row belongs to, then re-runs the
// scope check against that — so a scoped researcher can never touch another site's session by
// guessing/incrementing an id, even though :id itself carries no research info in the URL.
async function loadOwnedSession(req, res, sql, id) {
  const rows = await sql`SELECT * FROM "ExperimentalSession" WHERE "Id" = ${id} LIMIT 1`;
  if (!rows.length) {
    res.status(404).json({ error: 'Experimental session not found' });
    return undefined;
  }
  if (scopeGuard(req, res, rows[0].ResearchId) === undefined) return undefined;
  return rows[0];
}

router.get('/', async (req, res) => {
  const researchId = scopeGuard(req, res, req.query.researchId);
  if (researchId === undefined) return;

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT es."Id", es."ResearchId", es."SessionDate", es."Label", es."Notes", es."CreatedAt",
             (SELECT COUNT(*)::int FROM "ParticipantSession" ps WHERE ps."ExperimentalSessionId" = es."Id") AS "ParticipantSessionCount"
      FROM "ExperimentalSession" es
      WHERE (${researchId}::int IS NULL OR es."ResearchId" = ${researchId})
      ORDER BY es."SessionDate" DESC, es."Id" DESC
    `;
    res.json(
      rows.map((r) => ({
        id: r.Id,
        researchId: r.ResearchId,
        sessionDate: dateOnly(r.SessionDate),
        label: r.Label,
        notes: r.Notes,
        createdAt: r.CreatedAt,
        participantSessionCount: r.ParticipantSessionCount,
      }))
    );
  } catch (err) {
    console.error('[experimental-sessions] list error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/', async (req, res) => {
  const { researchId, sessionDate, label, notes } = req.body ?? {};
  const resolvedResearchId = scopeGuard(req, res, researchId);
  if (resolvedResearchId === undefined) return;
  if (resolvedResearchId === null) {
    // A superadmin with no research selected has nothing to attach the new session to.
    res.status(400).json({ error: 'researchId is required' });
    return;
  }
  if (!isValidDate(sessionDate)) {
    res.status(400).json({ error: 'sessionDate must be a YYYY-MM-DD date' });
    return;
  }
  if (!isOptionalString(label, MAX_LABEL_LENGTH) || !isOptionalString(notes, MAX_NOTES_LENGTH)) {
    res.status(400).json({ error: 'label/notes exceed the allowed length' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      INSERT INTO "ExperimentalSession" ("ResearchId", "SessionDate", "Label", "Notes", "CreatedByResearcherId")
      VALUES (${resolvedResearchId}, ${sessionDate}, ${label ?? null}, ${notes ?? null}, ${req.researcher.id})
      RETURNING "Id"
    `;
    res.status(201).json({ id: rows[0].Id });

    // Fire-and-forget — same post-response, own-try/catch pattern as the Calendar sync calls
    // elsewhere in this file.
    runInBackground(async () => {
      try {
        const researchRows = await sql`SELECT "Name" FROM "Research" WHERE "Id" = ${resolvedResearchId} LIMIT 1`;
        const researchName = researchRows[0]?.Name ?? '';
        const actorName = `${req.researcher.firstName ?? ''} ${req.researcher.lastName ?? ''}`.trim();
        await notifyResearchMembers(sql, {
          researchId: resolvedResearchId,
          type: 'EXPERIMENTAL_SESSION_CREATED',
          actorResearcherId: req.researcher.id,
          buildMessage: (lang) =>
            lang === 'en'
              ? `${actorName} created an experimental session for ${sessionDate} in "${researchName}".`
              : `${actorName} je kreirao/la eksperimentalnu sesiju za ${sessionDate} u istraživanju „${researchName}".`,
        });
      } catch (notifyErr) {
        console.error('[experimental-sessions] notification fan-out failed:', notifyErr);
      }
    });
  } catch (err) {
    console.error('[experimental-sessions] create error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  try {
    const sql = getDb();
    const session = await loadOwnedSession(req, res, sql, id);
    if (!session) return;

    const participantSessions = await sql`
      SELECT ps."ParticipantId", ps."SessionId", s."Name" AS "SessionName", ps."IsFinished", ps."Notes",
             TO_CHAR(ps."ScheduledTime", 'HH24:MI') AS "ScheduledTime", ps."Tags",
             ps."GoogleCalendarEventId", ps."GoogleCalendarEventUrl"
      FROM "ParticipantSession" ps
      JOIN "Sessions" s ON s."Id" = ps."SessionId"
      WHERE ps."ExperimentalSessionId" = ${id}
      ORDER BY ps."ScheduledTime" NULLS LAST, ps."ParticipantId", ps."SessionId"
    `;

    res.json({
      id: session.Id,
      researchId: session.ResearchId,
      sessionDate: dateOnly(session.SessionDate),
      label: session.Label,
      notes: session.Notes,
      createdAt: session.CreatedAt,
      participantSessions: participantSessions.map((r) => ({
        participantId: r.ParticipantId,
        sessionId: r.SessionId,
        sessionName: r.SessionName,
        isFinished: r.IsFinished,
        notes: r.Notes,
        scheduledTime: r.ScheduledTime,
        tags: r.Tags ?? [],
        googleCalendarEventId: r.GoogleCalendarEventId,
        // Real "open this event" link (Google's own htmlLink) — null for an event created before
        // this field existed (old row still has an EventId, just no stored URL yet) until it's
        // reassigned/rescheduled; the frontend falls back to the plain 📅 badge in that case.
        googleCalendarEventUrl: r.GoogleCalendarEventUrl,
      })),
    });
  } catch (err) {
    console.error('[experimental-sessions] get error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Registered BEFORE the generic PUT /:id below — Express matches PUT routes in registration
// order, and "participant-session-notes" would otherwise be captured as :id (failing the
// Number.isInteger check) if the generic route came first.
// Updates a ParticipantSession's own note — independent of assignment state (a note can exist
// even before the row is formally assigned to any experimental session). Scoped via the
// participant's own ResearchId rather than requiring an ExperimentalSession id in the URL.
router.put('/participant-session-notes', async (req, res) => {
  const { participantId, sessionId, notes } = req.body ?? {};
  if (typeof participantId !== 'string' || !participantId.trim() || !Number.isInteger(sessionId)) {
    res.status(400).json({ error: 'participantId and sessionId are required' });
    return;
  }
  if (!isOptionalString(notes, MAX_NOTES_LENGTH)) {
    res.status(400).json({ error: 'notes exceed the allowed length' });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "ResearchId" FROM "ParticipantSession"
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
      LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Participant session not found' });
      return;
    }
    if (scopeGuard(req, res, rows[0].ResearchId) === undefined) return;

    await sql`
      UPDATE "ParticipantSession"
      SET "Notes" = ${notes ?? null}
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[experimental-sessions] notes update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Registered BEFORE the generic PUT /:id below, same reason as participant-session-notes above.
// Replaces a ParticipantSession's full tag list atomically (simplest — the frontend always sends
// the complete resulting array on every add/remove).
router.put('/participant-session-tags', async (req, res) => {
  const { participantId, sessionId, tags } = req.body ?? {};
  if (typeof participantId !== 'string' || !participantId.trim() || !Number.isInteger(sessionId)) {
    res.status(400).json({ error: 'participantId and sessionId are required' });
    return;
  }
  if (!isValidTags(tags)) {
    res.status(400).json({ error: `tags must be an array of up to ${MAX_TAGS} valid tags` });
    return;
  }

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT "ResearchId" FROM "ParticipantSession"
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
      LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'Participant session not found' });
      return;
    }
    if (scopeGuard(req, res, rows[0].ResearchId) === undefined) return;

    await sql`
      UPDATE "ParticipantSession"
      SET "Tags" = ${JSON.stringify(tags)}
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('[experimental-sessions] tags update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const { sessionDate, label, notes } = req.body ?? {};
  if (!isValidDate(sessionDate)) {
    res.status(400).json({ error: 'sessionDate must be a YYYY-MM-DD date' });
    return;
  }
  if (!isOptionalString(label, MAX_LABEL_LENGTH) || !isOptionalString(notes, MAX_NOTES_LENGTH)) {
    res.status(400).json({ error: 'label/notes exceed the allowed length' });
    return;
  }

  try {
    const sql = getDb();
    const session = await loadOwnedSession(req, res, sql, id);
    if (!session) return;

    const dateChanged = dateOnly(session.SessionDate) !== sessionDate;

    await sql`
      UPDATE "ExperimentalSession"
      SET "SessionDate" = ${sessionDate}, "Label" = ${label ?? null}, "Notes" = ${notes ?? null}
      WHERE "Id" = ${id}
    `;
    res.json({ ok: true });

    // Moving the whole experimental session's date must move every child's Calendar event too,
    // keeping each participant's own time-of-day — best-effort per row, one failure doesn't stop
    // the rest (googleCalendar.mjs's updateEvent already swallows its own errors).
    if (dateChanged) runInBackground(async () => {
      try {
        const children = await sql`
          SELECT "GoogleCalendarEventId", "GoogleCalendarResearcherId",
                 TO_CHAR("ScheduledTime", 'HH24:MI') AS "ScheduledTime"
          FROM "ParticipantSession"
          WHERE "ExperimentalSessionId" = ${id} AND "GoogleCalendarEventId" IS NOT NULL
        `;
        // Each child event lives on whichever researcher assigned it — resolve and pass along
        // its own owner's token (never the current PUT caller's), since only the owner's OAuth
        // grant can patch an event on their own calendar. A row whose owning researcher has since
        // disconnected (null token) is simply skipped, not treated as a failure blocking others.
        await Promise.all(
          children.map(async (row) => {
            const refreshToken = await getResearcherRefreshToken(sql, row.GoogleCalendarResearcherId);
            if (!refreshToken) return;
            await updateEvent({
              refreshToken,
              eventId: row.GoogleCalendarEventId,
              date: sessionDate,
              time: row.ScheduledTime,
              durationMinutes: CALENDAR_EVENT_DURATION_MINUTES,
            });
          })
        );
      } catch (calendarErr) {
        console.error('[experimental-sessions] calendar sync (reschedule) failed:', calendarErr);
      }
    });
  } catch (err) {
    console.error('[experimental-sessions] update error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:id/assign', async (req, res) => {
  const id = Number(req.params.id);
  const { participantId, sessionId, time } = req.body ?? {};
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (typeof participantId !== 'string' || !participantId.trim() || !Number.isInteger(sessionId)) {
    res.status(400).json({ error: 'participantId and sessionId are required' });
    return;
  }
  if (!isValidTime(time)) {
    res.status(400).json({ error: 'time is required (HH:MM)' });
    return;
  }

  try {
    const sql = getDb();
    const session = await loadOwnedSession(req, res, sql, id);
    if (!session) return;

    // The ParticipantSession row must belong to the same research as the experimental
    // session — otherwise a researcher could reach across researches by guessing ids.
    const current = await sql`
      SELECT "ExperimentalSessionId" FROM "ParticipantSession"
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
        AND "ResearchId" = ${session.ResearchId}
      LIMIT 1
    `;
    if (!current.length) {
      res.status(404).json({ error: 'Participant session not found in this research' });
      return;
    }
    // Already assigned to a DIFFERENT experimental session — refuse and make the researcher
    // unassign it first, rather than silently stealing it from wherever it currently lives.
    // Re-submitting the same experimental session (e.g. just to change the time) is still fine.
    if (current[0].ExperimentalSessionId !== null && current[0].ExperimentalSessionId !== id) {
      res.status(409).json({ error: 'ALREADY_ASSIGNED' });
      return;
    }

    await sql`
      UPDATE "ParticipantSession"
      SET "ExperimentalSessionId" = ${id}, "ScheduledTime" = ${time}
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
        AND "ResearchId" = ${session.ResearchId}
    `;
    res.json({ ok: true });

    // Calendar sync happens after the response is already sent and the DB write (what actually
    // matters) has already succeeded — a Calendar API failure here must never surface to the
    // researcher as a failed assign. The event is created on the ASSIGNING researcher's own
    // Google Calendar (req.researcher.id) — if they haven't connected one (see Settings page),
    // this silently skips, no error. Re-assigning into the same experimental session (e.g. just
    // to change the time) creates a fresh event each time rather than reusing the old one; this
    // is deliberately simple (an occasional stray duplicate on a time-only edit is a minor
    // cosmetic issue) rather than adding another round trip to look up + update an existing id.
    runInBackground(async () => {
    try {
      const refreshToken = await getResearcherRefreshToken(sql, req.researcher.id);
      if (refreshToken) {
        const [participantRow, sessionMetaRow] = await Promise.all([
          sql`SELECT "Email" FROM "Participant" WHERE "ParticipantId" = ${participantId} LIMIT 1`,
          sql`SELECT "Name" FROM "Sessions" WHERE "Id" = ${sessionId} LIMIT 1`,
        ]);
        const participantEmail = participantRow[0]?.Email ?? null;
        const sessionName = sessionMetaRow[0]?.Name ?? 'Sesija';

        const { id: eventId, htmlLink: eventUrl } = await createEvent({
          refreshToken,
          summary: `${sessionName} — ${participantId}`,
          description: session.Label ? `Eksperimentalna sesija: ${session.Label}` : null,
          date: dateOnly(session.SessionDate),
          time,
          durationMinutes: CALENDAR_EVENT_DURATION_MINUTES,
          attendeeEmails: [participantEmail],
        });
        if (eventId) {
          await sql`
            UPDATE "ParticipantSession"
            SET "GoogleCalendarEventId" = ${eventId}, "GoogleCalendarEventUrl" = ${eventUrl}, "GoogleCalendarResearcherId" = ${req.researcher.id}
            WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
              AND "ResearchId" = ${session.ResearchId}
          `;
        }
      }
    } catch (calendarErr) {
      console.error('[experimental-sessions] calendar sync (assign) failed:', calendarErr);
    }
    });
  } catch (err) {
    console.error('[experimental-sessions] assign error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

router.post('/:id/unassign', async (req, res) => {
  const id = Number(req.params.id);
  const { participantId, sessionId } = req.body ?? {};
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  if (typeof participantId !== 'string' || !participantId.trim() || !Number.isInteger(sessionId)) {
    res.status(400).json({ error: 'participantId and sessionId are required' });
    return;
  }

  try {
    const sql = getDb();
    const session = await loadOwnedSession(req, res, sql, id);
    if (!session) return;

    const current = await sql`
      SELECT "GoogleCalendarEventId", "GoogleCalendarResearcherId" FROM "ParticipantSession"
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
        AND "ExperimentalSessionId" = ${id}
      LIMIT 1
    `;

    await sql`
      UPDATE "ParticipantSession"
      SET "ExperimentalSessionId" = NULL, "ScheduledTime" = NULL,
          "GoogleCalendarEventId" = NULL, "GoogleCalendarEventUrl" = NULL, "GoogleCalendarResearcherId" = NULL
      WHERE "ParticipantId" = ${participantId} AND "SessionId" = ${sessionId}
        AND "ExperimentalSessionId" = ${id}
    `;
    res.json({ ok: true });

    const eventId = current[0]?.GoogleCalendarEventId;
    if (eventId) {
      // The event lives on whichever researcher originally assigned it, not necessarily whoever
      // is unassigning it now — only that researcher's own token can delete it from their calendar.
      runInBackground(
        getResearcherRefreshToken(sql, current[0].GoogleCalendarResearcherId)
          .then((refreshToken) => (refreshToken ? deleteEvent({ refreshToken, eventId }) : undefined)),
        'experimental-sessions calendar sync (unassign)'
      );
    }
  } catch (err) {
    console.error('[experimental-sessions] unassign error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Deletes an ExperimentalSession. First detaches (not deletes) every ParticipantSession row
// still assigned to it — same as an explicit unassign for each — since ExperimentalSessionId is
// a foreign key with no ON DELETE clause (a raw DELETE would otherwise fail with a constraint
// violation), and because a participant-session's own Notes/Tags are its own data, worth keeping
// even once the experimental session that scheduled it is gone.
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }

  try {
    const sql = getDb();
    const session = await loadOwnedSession(req, res, sql, id);
    if (!session) return;

    // Role granularity (Phase 6) — reference enforcement: deleting an experimental session is
    // destructive (unassigns every participant-session under it), so a VIEWER-role researcher is
    // blocked here even though they can otherwise read this research's data. OWNER/COLLABORATOR
    // and superadmin are unaffected.
    if (!hasMinRole(req.researcher, session.ResearchId, ['OWNER', 'COLLABORATOR'])) {
      res.status(403).json({ error: 'INSUFFICIENT_ROLE' });
      return;
    }

    const children = await sql`
      SELECT "GoogleCalendarEventId", "GoogleCalendarResearcherId" FROM "ParticipantSession"
      WHERE "ExperimentalSessionId" = ${id} AND "GoogleCalendarEventId" IS NOT NULL
    `;

    await sql`
      UPDATE "ParticipantSession"
      SET "ExperimentalSessionId" = NULL, "ScheduledTime" = NULL,
          "GoogleCalendarEventId" = NULL, "GoogleCalendarEventUrl" = NULL, "GoogleCalendarResearcherId" = NULL
      WHERE "ExperimentalSessionId" = ${id}
    `;
    await sql`DELETE FROM "ExperimentalSession" WHERE "Id" = ${id}`;
    res.json({ ok: true });

    if (children.length) {
      runInBackground(
        Promise.all(
          children.map(async (row) => {
            const refreshToken = await getResearcherRefreshToken(sql, row.GoogleCalendarResearcherId);
            if (refreshToken) await deleteEvent({ refreshToken, eventId: row.GoogleCalendarEventId });
          })
        ),
        'experimental-sessions calendar sync (delete)'
      );
    }
  } catch (err) {
    console.error('[experimental-sessions] delete error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

export default router;
