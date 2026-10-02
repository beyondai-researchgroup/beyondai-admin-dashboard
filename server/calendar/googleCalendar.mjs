// Google Calendar sync for scheduled participant-sessions — each researcher connects their OWN
// Google account (see server/calendar/routes.mjs + googleOAuth.mjs), so every function here takes
// an explicit, already-decrypted `refreshToken` for whichever researcher owns the event, rather
// than reading one global client. Building a fresh OAuth2Client per call (not cached) is fine at
// this app's volume.
//
// Every exported function is best-effort: it catches its own errors, logs them, and returns
// null/false rather than throwing — a Calendar API hiccup (rate limit, revoked token, network)
// must never block the DB write that already succeeded in the calling route. The DB is always
// the source of truth; the Calendar event is a best-effort projection of it.
import { google } from 'googleapis';

const TIMEZONE = 'Europe/Belgrade';

function clientFor(refreshToken) {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

function toDateTime(date, time) {
  // date: 'YYYY-MM-DD', time: 'HH:MM' — combined with an explicit timeZone below rather than a
  // 'Z' suffix, so the Calendar API interprets it as local Europe/Belgrade time regardless of
  // where this server process itself runs.
  return `${date}T${time}:00`;
}

function addMinutes(date, time, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm + minutes);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}

/**
 * Creates an event on the researcher's own primary calendar (they're the organizer automatically
 * — no need to add themselves as an explicit attendee) and returns its id + the real Google
 * Calendar "open this event" URL (`htmlLink`, previously discarded — the caller only ever stored
 * `data.id`), or `{ id: null, htmlLink: null }` on any failure. `attendeeEmails` is filtered for
 * null/undefined, so a participant with no Email on file simply gets a researcher-only event
 * rather than an error.
 */
export async function createEvent({ refreshToken, summary, description, date, time, durationMinutes = 45, attendeeEmails }) {
  try {
    const calendar = clientFor(refreshToken);
    const end = addMinutes(date, time, durationMinutes);
    const attendees = (attendeeEmails ?? []).filter(Boolean).map((email) => ({ email }));

    const { data } = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody: {
        summary,
        description,
        start: { dateTime: toDateTime(date, time), timeZone: TIMEZONE },
        end: { dateTime: toDateTime(end.date, end.time), timeZone: TIMEZONE },
        attendees,
      },
    });
    return { id: data.id ?? null, htmlLink: data.htmlLink ?? null };
  } catch (err) {
    console.error('[google-calendar] createEvent failed:', err?.message ?? err);
    return { id: null, htmlLink: null };
  }
}

/** Patches an existing event's start/end. Returns true on success, false on any failure. */
export async function updateEvent({ refreshToken, eventId, date, time, durationMinutes = 45 }) {
  if (!eventId) return false;
  try {
    const calendar = clientFor(refreshToken);
    const end = addMinutes(date, time, durationMinutes);

    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
      requestBody: {
        start: { dateTime: toDateTime(date, time), timeZone: TIMEZONE },
        end: { dateTime: toDateTime(end.date, end.time), timeZone: TIMEZONE },
      },
    });
    return true;
  } catch (err) {
    console.error('[google-calendar] updateEvent failed:', err?.message ?? err);
    return false;
  }
}

/**
 * Deletes an event. A 404/410 (already gone — e.g. a guest deleted it manually) counts as
 * success, not a failure, since the desired end state (no event) is already true.
 */
export async function deleteEvent({ refreshToken, eventId }) {
  if (!eventId) return true;
  try {
    const calendar = clientFor(refreshToken);
    await calendar.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' });
    return true;
  } catch (err) {
    const status = err?.code ?? err?.response?.status;
    if (status === 404 || status === 410) return true;
    console.error('[google-calendar] deleteEvent failed:', err?.message ?? err);
    return false;
  }
}
