/**
 * Resolves the research id a request is allowed to query, from the authenticated
 * researcher's verified JWT claims (`req.researcher`) — NEVER from the raw client-supplied
 * query/body param directly. This is the one rule every participants/results route must follow.
 *
 * Since Phase B (2026-08-18), a researcher can be assigned to several researches (a real
 * many-to-many via the `ResearcherResearch` join table, resolved once at login and baked into
 * the JWT as `researchIds` — same convention `isSuperAdmin` already used, so an assignment
 * change takes effect on the researcher's next login, not instantly; acceptable for a handful
 * of known accounts, consistent with how role changes already worked before this).
 *
 * - Superadmin: returns Number(requestedResearchId) if one was supplied, else null
 *   (meaning "all researches" — every SQL query here uses a NULL-safe
 *   `WHERE (${researchId}::int IS NULL OR p."ResearchId" = ${researchId})` clause).
 * - Scoped researcher, one assigned research: returns that research id if no id (or that same
 *   id) was requested — same convenience default as before Phase B.
 * - Scoped researcher, several assigned researches: the caller MUST supply one of them; a
 *   missing id throws (their frontend always shows a picker in this case, same as superadmin's).
 * - Scoped researcher, zero assigned researches: throws — a misconfigured account, not silently
 *   treated as "sees nothing" or "sees everything".
 * - Any requested id outside the researcher's assigned set (or, for a single-research
 *   researcher, different from their one research) throws ScopeForbiddenError, so a crafted
 *   query param can never leak another site's data — even one that doesn't exist yet.
 */
export class ScopeForbiddenError extends Error {}

export function resolveResearchScope(researcher, requestedResearchId) {
  const requested =
    requestedResearchId !== undefined && requestedResearchId !== null && requestedResearchId !== ''
      ? Number(requestedResearchId)
      : null;

  if (requested !== null && !Number.isInteger(requested)) {
    throw new ScopeForbiddenError('Invalid researchId');
  }

  if (researcher.isSuperAdmin) {
    return requested;
  }

  const assigned = researcher.researchIds ?? [];

  if (requested !== null) {
    if (!assigned.includes(requested)) {
      throw new ScopeForbiddenError("Requested research is outside this researcher's scope");
    }
    return requested;
  }

  if (assigned.length === 1) {
    return assigned[0];
  }
  if (assigned.length === 0) {
    throw new ScopeForbiddenError('This researcher account is not assigned to any research');
  }
  throw new ScopeForbiddenError('researchId is required — this researcher is assigned to several researches');
}
