import crypto from 'node:crypto';
import { atomic, get, run } from '../db.js';
import { HttpError } from '../router.js';

const DAY = 86400000;
function positiveInteger(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(503, 'KYC spending controls require configuration.');
  return value;
}

export function requireKycAccess(environment, product) {
  if (!['sandbox', 'live'].includes(environment)) throw new HttpError(503, 'Invalid KYC environment.');
  if (!process.env.DOJAH_APP_ID || !process.env.DOJAH_SECRET_KEY) throw new HttpError(503, 'KYC provider is not configured yet.');
  if (environment === 'live') {
    const products = String(process.env.DOJAH_APPROVED_PRODUCTS || '').split(',').map(x => x.trim());
    if (process.env.DOJAH_PRODUCTION_AUTHORIZED !== 'true' || !products.includes(product)) {
      throw new HttpError(503, 'Live KYC awaits provider authorisation.');
    }
    positiveInteger('DOJAH_DAILY_REQUEST_LIMIT');
    positiveInteger('DOJAH_DAILY_BUDGET_KOBO');
    positiveInteger(`DOJAH_${product.toUpperCase()}_MAX_COST_KOBO`);
  }
}

// The shared guard row serializes reservations across PostgreSQL workers.
// Never hold this transaction open while waiting for the provider.
export async function reserveKycRequest(check, environment, product) {
  requireKycAccess(environment, product);
  const limit = environment === 'live' ? positiveInteger('DOJAH_DAILY_REQUEST_LIMIT') : 100;
  const cost = environment === 'live' ? positiveInteger(`DOJAH_${product.toUpperCase()}_MAX_COST_KOBO`) : 0;
  const budget = environment === 'live' ? positiveInteger('DOJAH_DAILY_BUDGET_KOBO') : Number.MAX_SAFE_INTEGER;
  return atomic(async () => {
    const guard = await run('UPDATE kyc_dispatch_guard SET version = version + 1 WHERE id = 1');
    if (guard.changes !== 1) throw new HttpError(503, 'KYC spending controls are unavailable.');
    const now = Date.now();
    const current = await get('SELECT status FROM kyc_checks WHERE id = ?', [check.id]);
    const application = await get('SELECT status FROM member_applications WHERE id = ?', [check.application_id]);
    if (current?.status === 'KYC_VERIFIED' || application?.status === 'KYC_VERIFIED') throw new HttpError(409, 'Identity verification is already complete.');
    if (!['KYC_PENDING', 'KYC_FAILED'].includes(application?.status)) throw new HttpError(409, 'Application is not awaiting identity verification.');
    for (const type of ['terms', 'privacy']) {
      const consent = await get('SELECT accepted FROM consents WHERE application_id = ? AND type = ? ORDER BY id DESC LIMIT 1', [check.application_id, type]);
      if (!consent?.accepted) throw new HttpError(409, 'Terms and privacy consent are required before KYC.');
    }
    const pending = await get("SELECT id FROM kyc_provider_requests WHERE application_id = ? AND state IN ('DISPATCHED', 'UNKNOWN')", [check.application_id]);
    if (pending) throw new HttpError(409, 'Verification is pending reconciliation. Contact support before retrying.');
    const duplicate = await get('SELECT id FROM kyc_provider_requests WHERE application_id = ? AND environment = ? AND product = ? AND started_ms >= ?', [check.application_id, environment, product, now - DAY]);
    if (duplicate) throw new HttpError(409, 'This verification product was already requested within 24 hours. Contact support before retrying.');
    const attempts = await get('SELECT COUNT(*) AS total FROM kyc_provider_requests WHERE application_id = ? AND started_ms >= ?', [check.application_id, now - DAY]);
    const legacy = await get("SELECT COALESCE(SUM(attempt_count), 0) AS total FROM kyc_checks WHERE application_id = ? AND created_at >= datetime('now', '-24 hours')", [check.application_id]);
    if (Math.max(Number(attempts.total), Number(legacy.total)) >= 5) throw new HttpError(429, 'Too many identity verification attempts.');
    const usage = await get('SELECT COUNT(*) AS total, COALESCE(SUM(reserved_kobo), 0) AS cost FROM kyc_provider_requests WHERE environment = ? AND started_ms >= ?', [environment, now - DAY]);
    if (Number(usage.total) >= limit || Number(usage.cost) + cost > budget) throw new HttpError(429, 'KYC spending limit reached. Contact support.');
    const id = crypto.randomUUID();
    await run("INSERT INTO kyc_provider_requests (id, application_id, check_id, environment, product, state, reserved_kobo, started_ms) VALUES (?, ?, ?, ?, ?, 'DISPATCHED', ?, ?)", [id, check.application_id, check.id, environment, product, cost, now]);
    await run("UPDATE kyc_checks SET attempt_count = COALESCE(attempt_count, 0) + 1, last_attempt_at = datetime('now') WHERE id = ?", [check.id]);
    return id;
  });
}

// All dispatched calls retain their reservation, including 404s and timeouts.
// Ambiguous outcomes remain blocked indefinitely until an operator reconciles.
export async function finishKycRequest(id, state, providerStatus = null) {
  if (!['MATCH', 'MISMATCH', 'NOT_FOUND', 'PROVIDER_ERROR', 'UNKNOWN'].includes(state)) throw new Error('Invalid KYC outcome');
  await run('UPDATE kyc_provider_requests SET state = ?, provider_status = ?, finished_ms = ? WHERE id = ?', [state, providerStatus, Date.now(), id]);
}
