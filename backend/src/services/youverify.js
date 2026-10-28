import { HttpError } from '../router.js';
import { recordProviderResponse } from './kyc-cost-controls.js';

// Quickcheck performs only the requested identity check. It does not create an
// Entity 360 or subscribe the subject to additional screening or monitoring.
export async function youverifyPost(type, idNumber, requestId, environment) {
  if (!['nin', 'bvn'].includes(type) || !['sandbox', 'live'].includes(environment)) {
    throw new HttpError(503, 'Invalid Youverify configuration.');
  }
  const base = environment === 'live' ? 'https://api.youverify.co' : 'https://api.sandbox.youverify.co';
  const response = await fetch(`${base}/v2/api/identity/ng/${type}`, {
    method: 'POST',
    headers: { token: process.env.YOUVERIFY_SECRET_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ id: idNumber, isSubjectConsent: true, metadata: { requestId } }),
    signal: AbortSignal.timeout(15000),
  });
  let body = null;
  try { body = await response.json(); } catch {}
  const tracked = await recordProviderResponse(requestId, body, response.status);
  // HTTP success alone is insufficient. Pending, missing and unrecognised
  // reports require reconciliation and never trigger an automatic retry.
  if (!response.ok || !tracked || body?.success !== true || body?.data?.status !== 'found') {
    const error = new HttpError(502, 'Verification requires reconciliation.');
    error.providerStatus = response.status;
    error.uncertain = true;
    throw error;
  }
  return body;
}

export function youverifyMatch(application, entity) {
  const tokens = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const supplied = tokens(application.full_legal_name);
  const first = tokens(entity.firstName);
  const last = tokens(entity.lastName);
  const nameMatch = first.length > 0 && last.length > 0 && supplied.length >= 2
    && [...first, ...last].every(part => supplied.includes(part));
  // Require a complete, real date on both sides. A missing provider DOB must
  // never silently satisfy the application's identity check.
  const date = value => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
    const parsed = new Date(`${raw}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw ? raw : '';
  };
  const providerDob = date(entity.dateOfBirth);
  const appDob = date(application.date_of_birth);
  const dobMatch = Boolean(providerDob && appDob && providerDob === appDob);
  return { matched: nameMatch && dobMatch, nameMatch, dobMatch, providerDobPresent: Boolean(providerDob), appDobPresent: Boolean(appDob) };
}
