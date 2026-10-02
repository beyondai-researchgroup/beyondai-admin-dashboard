import jwt from 'jsonwebtoken';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
}

export function signToken(researcher) {
  return jwt.sign(
    {
      sub: researcher.id,
      email: researcher.email,
      firstName: researcher.firstName,
      lastName: researcher.lastName,
      isSuperAdmin: researcher.isSuperAdmin,
      // Every research this researcher is currently assigned to (via ResearcherResearch),
      // resolved once at login — see scope.mjs's doc comment for the staleness trade-off.
      researchIds: researcher.researchIds,
      // Role granularity (Phase 6, 2026-09-04) — {researchId: 'OWNER'|'COLLABORATOR'|'VIEWER'},
      // consumed by server/roles.mjs's hasMinRole().
      researchRoles: researcher.researchRoles,
    },
    getSecret(),
    { expiresIn: process.env.JWT_EXPIRY || '12h' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, getSecret());
}
