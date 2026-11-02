// Google Calendar projection of a session slot (termin). One event per slot, with every attendee
// that has an e-mail address as a guest. Kept free of any I/O so it can be unit tested.
// The guests are participants: the event carries only what they may see (the session label, the place
// or link), never the researcher's notes, the protocol step names or the group.

/** Strips line breaks from a one-line field. */
const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * @param slot      { kind, meetingUrl, location, durationMinutes }
 * @param session   { label }   (the experimental session the slot belongs to)
 * @param attendees [{ email }]
 * @returns the fields createEvent/updateEvent take (summary, description, location, attendeeEmails, durationMinutes)
 */
export function buildSlotEvent(slot, session, attendees) {
  const title = oneLine(session?.label) || 'Eksperimentalna sesija';
  const lines = [];
  if (slot.kind === 'ONLINE') {
    lines.push(slot.meetingUrl ? `Online sastanak: ${oneLine(slot.meetingUrl)}` : 'Online sastanak');
  } else {
    lines.push(`Uživo: ${oneLine(slot.location)}`);
  }
  const emails = [...new Set((attendees ?? []).map((a) => String(a.email ?? '').trim().toLowerCase()).filter(Boolean))];
  return {
    summary: title,
    description: lines.join('\n'),
    location: slot.kind === 'IN_PERSON' ? oneLine(slot.location) : (slot.meetingUrl ? oneLine(slot.meetingUrl) : ''),
    attendeeEmails: emails,
    durationMinutes: slot.durationMinutes ?? 45,
  };
}
