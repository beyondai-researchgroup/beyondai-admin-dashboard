// Shared helper for serializing a Postgres DATE column back to a plain 'YYYY-MM-DD' string.
// Extracted 2026-08-20 from experimental-sessions/routes.mjs's own dateOnly() (same bug, same
// fix, now needed a second time for Researcher.DateOfBirth) — the neon serverless driver parses
// a DATE column using a local-timezone Date constructor (a stored '2026-08-18' round-trips as a
// JS Date whose *local* getters give 2026-08-18 but whose UTC getters/toISOString() show the
// previous day), so reading it back with local getters (never getUTC*/toISOString) is what
// actually recovers the original calendar date. Emitting a plain 'YYYY-MM-DD' string (instead of
// a full ISO timestamp) is also what native `<input type="date">` elements require to populate
// correctly — a bare ISO-with-time string silently fails to load into an edit form.
export function dateOnly(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
