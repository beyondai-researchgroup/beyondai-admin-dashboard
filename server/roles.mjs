// Researcher role granularity — Phase 6 of the modular-platform plan (2026-09-04). Sits on top of
// the existing many-to-many (`ResearcherResearch`, Phase B of platform-ification) — membership
// (who can see a research at all) stays resolveResearchScope's job in scope.mjs, unchanged; this
// module answers the separate question "what is this researcher allowed to DO on a research they
// already have access to". OWNER/COLLABORATOR both keep today's full read/write access;
// VIEWER is the new restriction — read-only, blocked from destructive/mutating routes that opt
// into a role check.
//
// Every existing assignment defaulted to OWNER when the Role column was added (2026-09-04
// migration), so this is purely additive — no researcher lost any access they had before this
// phase. Reference enforcement is wired into DELETE /api/admin/experimental-sessions/:id only so
// far (the plan's own named example); extending the same one-line check to other destructive
// routes is future work, not done project-wide in this pass.
export const RESEARCHER_ROLES = ['OWNER', 'COLLABORATOR', 'VIEWER'];

/**
 * True if `researcher` is allowed to act on `researchId` at the level required by
 * `allowedRoles`. A superadmin always passes (mirrors resolveResearchScope's own superadmin
 * bypass). A researcher with no role recorded for that research (shouldn't happen for anyone who
 * passed a membership check, but checked defensively) is treated as not permitted.
 */
export function hasMinRole(researcher, researchId, allowedRoles) {
  if (researcher.isSuperAdmin) return true;
  const role = researcher.researchRoles?.[researchId];
  return role != null && allowedRoles.includes(role);
}
