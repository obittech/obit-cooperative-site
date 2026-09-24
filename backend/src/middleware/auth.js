import { verifyToken } from '../utils/auth.js';
import { get } from '../db.js';
import { HttpError } from '../router.js';

// Usage in a route chain: router.get('/api/me', requireAuth(), handler)
//                          router.get('/api/admin/x', requireAuth('staff','admin'), handler)
// Attaches req.user = { id, role } on success; throws HttpError otherwise.
export function requireAuth(...allowedRoles) {
  return async function authGuard(req) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (!payload) throw new HttpError(401, 'Missing or invalid session token');

    const user = await get('SELECT id, role, status, session_version FROM users WHERE id = ?', [payload.uid]);
    if (!user || user.status !== 'ACTIVE') throw new HttpError(401, 'Account is not active');
    if (Number(payload.sv || 0) !== Number(user.session_version || 0)) {
      throw new HttpError(401, 'Session has been revoked. Please sign in again.');
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      throw new HttpError(403, 'Not permitted for this role');
    }
    req.user = user;
  };
}
