// Participant codes (2026-11): a random four-digit number per participant, unique inside a research, meant to replace the real
// ParticipantId in analysis and in papers (the real id stays in the database; the "key" file maps one to the other).
// Assigned automatically to the people an import creates; participants that existed before (or whose code is missing) get one
// from the "assign codes" action. A participant that already has a code never gets a new one.

import crypto from 'node:crypto';

export const CODE_MIN = 1000;
export const CODE_MAX = 9999;

/**
 * Gives each participant in `guids` (default: every participant of the research without a code) a random unused code.
 * @returns {Promise<{ ok: true, assigned: number } | { ok: false, error: 'CODES_EXHAUSTED', free: number }>}
 */
export async function assignParticipantCodes(sql, researchId, guids = null) {
  const usedRows = await sql`SELECT "ParticipantCode" FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantCode" IS NOT NULL`;
  const used = new Set(usedRows.map((r) => r.ParticipantCode));
  const targets = guids ?? (await sql`SELECT "Guid" FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantCode" IS NULL ORDER BY "ParticipantId"`).map((r) => r.Guid);
  const free = [];
  for (let n = CODE_MIN; n <= CODE_MAX; n++) if (!used.has(String(n))) free.push(String(n));
  if (targets.length > free.length) return { ok: false, error: 'CODES_EXHAUSTED', free: free.length };
  let assigned = 0;
  for (const guid of targets) {
    // Picked from what is still free, so the draw never loops however full the range is.
    for (let attempt = 0; attempt < 5 && free.length; attempt++) {
      const code = free.splice(crypto.randomInt(free.length), 1)[0];
      try {
        const r = await sql`UPDATE "Participant" SET "ParticipantCode" = ${code} WHERE "Guid" = ${guid} AND "ParticipantCode" IS NULL RETURNING "Guid"`;
        if (r.length) assigned++;
        break;
      } catch (err) {
        // Another import took this code at the same moment (unique index): try another one.
        if (err?.code !== '23505') throw err;
      }
    }
  }
  return { ok: true, assigned };
}

/**
 * Export helper: when the research has codes, every row gets a `ParticipantCode` column right after `ParticipantId` (looked up by
 * the row's ParticipantId inside the research). Without any code the rows are returned untouched, so older exports keep their shape.
 */
export async function withCodes(sql, researchId, rows) {
  if (researchId == null || !rows.length) return rows;
  const codeRows = await sql`SELECT "ParticipantId", "ParticipantCode" FROM "Participant" WHERE "ResearchId" = ${researchId} AND "ParticipantCode" IS NOT NULL`;
  if (!codeRows.length) return rows;
  const byId = new Map(codeRows.map((r) => [r.ParticipantId, r.ParticipantCode]));
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v;
      if (k === 'ParticipantId') out.ParticipantCode = byId.get(v) ?? '';
    }
    return out;
  });
}
