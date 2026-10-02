import { verifyToken } from './jwt.mjs';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.researcher = {
      id: payload.sub,
      email: payload.email,
      firstName: payload.firstName,
      lastName: payload.lastName,
      isSuperAdmin: payload.isSuperAdmin,
      researchIds: payload.researchIds ?? [],
      researchRoles: payload.researchRoles ?? {},
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireSuperAdmin(req, res, next) {
  if (!req.researcher?.isSuperAdmin) {
    res.status(403).json({ error: 'Superadmin access required' });
    return;
  }
  next();
}
