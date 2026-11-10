// Business-flow tests authorize their synthetic fixture owner. Security tests
// deliberately do not use this helper.
import { get } from '../../src/db.js';
import { issueApplicationSession } from '../../src/middleware/application-access.js';
export async function fixtureApplicationToken(path, body = {}, params = {}) {
  if (path.startsWith('/api/admin/') || path.startsWith('/api/me') || path.startsWith('/api/auth')) return '';
  let id;
  if (/^\/api\/applications\/\d+/.test(path)) id = params.id;
  else if (path.startsWith('/api/kyc/')) {
    if (body.application_id) id = body.application_id;
    else {
      const ref = params.ref || params.id;
      id = /^\d+$/.test(String(ref)) ? ref : (await get('SELECT application_id FROM kyc_checks WHERE session_ref = ?', [ref]))?.application_id;
    }
  } else if (path.startsWith('/api/payments/membership/')) {
    id = body.application_id || params.applicationId;
    if (!id && params.reference) id = (await get('SELECT application_id FROM membership_bank_payments WHERE reference = ?', [params.reference]))?.application_id;
  }
  return id ? issueApplicationSession(id) : '';
}
export function authorizedFixtureHandler(router, method, path) {
  const route = router.match(method, path);
  return async (request, res, params = route.params) => {
    const req = { ...request, headers: { ...(request.headers || {}), authorization: `Bearer ${await fixtureApplicationToken(path, request.body, params)}` } };
    let result;
    for (const handler of route.handlers) { result = await handler(req, res, params); if (res.writableEnded) break; }
    return result;
  };
}
