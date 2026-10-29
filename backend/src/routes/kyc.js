// routes/kyc.js
// Youverify is the sole KYC provider. Sandbox is the default. Live calls require explicit
// provider authorization, approved products, credentials and spending controls.
// Secret credentials are server-side only and raw NIN/BVN values are never
// written to the Obit database or audit log.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { audit } from '../utils/audit.js';
import crypto from 'node:crypto';
import { youverifyPost, youverifyMatch } from '../services/youverify.js';
import { requireKycAccess, reserveKycRequest, finishKycRequest, sandboxRequestStatus } from '../services/kyc-cost-controls.js';

export const kycRouter = new Router();

const PROVIDER = 'YOUVERIFY';
const KYC_ENV = (process.env.YOUVERIFY_ENV || 'sandbox').toLowerCase();
const providerConfigured = () => Boolean(process.env.YOUVERIFY_SECRET_KEY);

function validIdNumber(value) {
  return typeof value === 'string' && /^\d{11}$/.test(value.trim());
}

async function hasRequiredConsent(applicationId) {
  const terms = await get("SELECT accepted FROM consents WHERE application_id = ? AND type = 'terms' ORDER BY id DESC LIMIT 1", [applicationId]);
  const privacy = await get("SELECT accepted FROM consents WHERE application_id = ? AND type = 'privacy' ORDER BY id DESC LIMIT 1", [applicationId]);
  return Boolean(terms?.accepted && privacy?.accepted);
}

kycRouter.post('/api/kyc/session', async (req, res) => {
  const { application_id } = req.body || {};
  const application = await get('SELECT * FROM member_applications WHERE id = ?', [application_id]);
  if (!application) throw new HttpError(404, 'Application not found');
  const latest = await get('SELECT * FROM kyc_checks WHERE application_id = ? ORDER BY id DESC LIMIT 1', [application_id]);
  const replacingRetired = application.status === 'KYC_PENDING' && latest && latest.provider !== PROVIDER;
  if (!['APPLICATION_SUBMITTED', 'KYC_FAILED'].includes(application.status) && !replacingRetired) {
    throw new HttpError(409, `Application must be submitted to start KYC (currently ${application.status})`);
  }
  const unresolved = await get("SELECT id FROM kyc_provider_requests WHERE application_id = ? AND state IN ('DISPATCHED', 'UNKNOWN')", [application_id]);
  if (unresolved) throw new HttpError(409, 'Verification is pending reconciliation. Contact support before retrying.');
  if (!await hasRequiredConsent(application_id)) {
    throw new HttpError(409, 'Terms and privacy consent are required before KYC.');
  }

  if (!['sandbox', 'live'].includes(KYC_ENV)) throw new HttpError(503, 'Invalid KYC environment.');
  const sessionRef = `${PROVIDER.toLowerCase()}_${KYC_ENV}_${crypto.randomUUID()}`;
  await run(
    "INSERT INTO kyc_checks (application_id, provider, session_ref, status, raw_status_detail) VALUES (?, ?, ?, 'KYC_PENDING', ?)",
    [application_id, PROVIDER, sessionRef, JSON.stringify({ environment: KYC_ENV })]
  );
  await run("UPDATE member_applications SET status = 'KYC_PENDING', updated_at = datetime('now') WHERE id = ?", [application_id]);
  await audit(null, 'KYC_SESSION_STARTED', 'member_applications', application_id, {
    provider: PROVIDER, environment: KYC_ENV, sessionRef,
  });

  res.json(201, {
    session_ref: sessionRef,
    provider: PROVIDER,
    environment: KYC_ENV,
    configured: providerConfigured(),
    message: KYC_ENV === 'sandbox'
      ? `${PROVIDER} sandbox session created. Use synthetic test data only.`
      : `${PROVIDER} live KYC session created.`,
  });
});

kycRouter.post('/api/kyc/session/:ref/verify', async (req, res, params) => {
  const check = await get('SELECT * FROM kyc_checks WHERE session_ref = ?', [params.ref]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  if (check.status === 'KYC_VERIFIED') return res.json(200, { status: 'KYC_VERIFIED' });

  const application = await get('SELECT * FROM member_applications WHERE id = ?', [check.application_id]);
  if (!application) throw new HttpError(404, 'Application not found');

  const type = String(req.body?.type || 'nin').toLowerCase();
  const idNumber = String(req.body?.id_number || '').trim();
  if (!['nin', 'bvn'].includes(type)) throw new HttpError(400, 'KYC type must be nin or bvn.');
  if (!validIdNumber(idNumber)) throw new HttpError(400, 'Enter a valid 11-digit NIN or BVN.');

  if (check.provider !== PROVIDER || !check.session_ref.startsWith(`${PROVIDER.toLowerCase()}_${KYC_ENV}_`)) throw new HttpError(409, 'Create a new KYC session for this environment.');
  requireKycAccess(KYC_ENV, type);
  const requestId = await reserveKycRequest(check, KYC_ENV, type);

  // The identifier is used only for this provider request. It is never persisted.
  let providerResponse;
  try {
    providerResponse = await youverifyPost(type, idNumber, requestId, KYC_ENV);
  } catch (error) {
    await finishKycRequest(requestId, 'UNKNOWN', error.providerStatus || null);
    await run(
      "UPDATE kyc_checks SET raw_status_detail = ? WHERE id = ?",
      [JSON.stringify({ environment: KYC_ENV, outcome: 'PROVIDER_ERROR', provider_status: error.providerStatus || null }), check.id]
    );
    await audit(null, 'KYC_PROVIDER_ERROR', 'member_applications', check.application_id, {
      provider: PROVIDER, environment: KYC_ENV, sessionRef: check.session_ref,
      requestId, providerStatus: error.providerStatus || null, potentiallyBillable: true,
    });
    throw new HttpError(error.status || 502, 'Identity verification could not be completed. Contact support before retrying.');
  }

  const match = youverifyMatch(application, providerResponse.data);
  const matched = match.matched;
  const newStatus = matched ? 'KYC_VERIFIED' : 'KYC_FAILED';

  await run(
    "UPDATE kyc_checks SET status = ?, raw_status_detail = ?, verified_at = CASE WHEN ? = 'KYC_VERIFIED' THEN datetime('now') ELSE verified_at END WHERE id = ?",
    [newStatus, JSON.stringify({ environment: KYC_ENV, outcome: matched ? 'MATCH' : 'MISMATCH', id_type: type }), newStatus, check.id]
  );
  await run("UPDATE member_applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, check.application_id]);
  await audit(null, matched ? 'KYC_VERIFIED' : 'KYC_FAILED', 'member_applications', check.application_id, {
    provider: PROVIDER, environment: KYC_ENV, sessionRef: check.session_ref, idType: type, requestId, potentiallyBillable: true,
  });

  await finishKycRequest(requestId, matched ? 'MATCH' : 'MISMATCH', 200);
  res.json(200, {
    status: newStatus,
    provider: PROVIDER,
    environment: KYC_ENV,
    message: matched ? 'Identity details matched.' : 'Identity details did not match the application.',
    ...(KYC_ENV === 'sandbox' ? { sandbox_match: {
      name_match: match.nameMatch,
      dob_match: match.dobMatch,
      provider_dob_present: match.providerDobPresent,
      application_dob_present: match.appDobPresent,
    }} : {}),
  });
});

kycRouter.get('/api/kyc/:id/status', async (req, res, params) => {
  const numericId = /^\d+$/.test(String(params.id)) ? Number(params.id) : null;
  const check = numericId
    ? await get('SELECT * FROM kyc_checks WHERE session_ref = ? OR application_id = ? ORDER BY id DESC LIMIT 1', [params.id, numericId])
    : await get('SELECT * FROM kyc_checks WHERE session_ref = ? ORDER BY id DESC LIMIT 1', [params.id]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  const sandboxRequest = await sandboxRequestStatus(check, KYC_ENV);
  res.json(200, {
    status: check.status,
    session_ref: check.session_ref,
    provider: check.provider,
    environment: String(check.session_ref || '').split('_')[1] === 'live' ? 'live' : 'sandbox',
    restart_required: check.status !== 'KYC_VERIFIED' && (check.provider !== PROVIDER || !check.session_ref.startsWith(`youverify_${KYC_ENV}_`)),
    verified_at: check.verified_at,
    ...(sandboxRequest ? { sandbox_request: sandboxRequest } : {}),
  });
});

// Legacy simulation is deliberately disabled in deployed production. It is
// retained only for local development when explicitly enabled.
kycRouter.post('/api/kyc/session/:ref/simulate', async (req, res, params) => {
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_ROUTES !== 'true') {
    throw new HttpError(404, 'Not found');
  }
  const { outcome } = req.body || {};
  const check = await get('SELECT * FROM kyc_checks WHERE session_ref = ?', [params.ref]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  const newStatus = outcome === 'FAILED' ? 'KYC_FAILED' : 'KYC_VERIFIED';
  await run("UPDATE kyc_checks SET status = ?, verified_at = datetime('now') WHERE id = ?", [newStatus, check.id]);
  await run("UPDATE member_applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, check.application_id]);
  await audit(null, 'KYC_SIMULATED', 'member_applications', check.application_id, { newStatus });
  res.json(200, { status: newStatus });
});
