// Shared helper — item 1 of the "platform improvements round 2" plan. ParticipantId is scoped
// per research now (UNIQUE("ResearchId","ParticipantId")), not globally unique, so any lookup
// that resolves "the" Participant from a bare id with no researchId to disambiguate with can now
// genuinely match more than one row. Returns the row, null (not found), or the AMBIGUOUS symbol —
// callers must check for AMBIGUOUS explicitly and fail loud (409) rather than silently picking one.
export const AMBIGUOUS_PARTICIPANT = Symbol('AMBIGUOUS_PARTICIPANT_ID');

/** Resolves a Participant by bare ParticipantId with no research context. */
export async function resolveParticipantByBareId(sql, participantId) {
  const rows = await sql`SELECT * FROM "Participant" WHERE "ParticipantId" = ${participantId}`;
  if (rows.length > 1) return AMBIGUOUS_PARTICIPANT;
  return rows[0] ?? null;
}
