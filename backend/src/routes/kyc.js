// routes/kyc.js
// Dojah KYC adapter. Sandbox is the safe default. Real identity verification
// remains disabled until DOJAH_ENV=live and production credentials are set.
// Secret credentials are server-side only and raw NIN/BVN values are never
// written to the Obit database or audit log.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { audit } from '../utils/audit.js';
import crypto from 'node:crypto';

export const kycRouter = new Router();

const DOJAH_ENV = (process.env.DOJAH_ENV || 'sandbox').toLowerCase();
const DOJAH_BASE_URL = DOJAH_ENV === 'live' ? 'https://api.dojah.io' : 'https://sandbox.dojah.io';

function dojahConfigured() {
  return Boolean(process.env.DOJAH_APP_ID && process.env.DOJAH_SECRET_KEY);
}

function requireDojah() {
  if (!dojahConfigured()) {
    throw new HttpError(503, 'KYC provider is not configured yet.');
  }
  if (!['sandbox', 'live'].includes(DOJAH_ENV)) {
    throw new HttpError(500, 'Invalid KYC provider environment.');
  }
}

async function dojahGet(path, params) {
  requireDojah();
  const url = new URL(path, DOJAH_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      AppId: process.env.DOJAH_APP_ID,
      Authorization: process.env.DOJAH_SECRET_KEY,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const providerMessage = body?.error || body?.message || `Dojah returned HTTP ${response.status}`;
    const error = new HttpError(response.status === 404 ? 422 : 502, 'Identity verification could not be completed.');
    error.providerDetail = String(providerMessage).slice(0, 300);
    throw error;
  }
  return body;
}

function validIdNumber(value) {
  return typeof value === 'string' && /^\d{11}$/.test(value.trim());
}

function hasRequiredConsent(applicationId) {
  const terms = get("SELECT accepted FROM consents WHERE application_id = ? AND type = 'terms' ORDER BY id DESC LIMIT 1", [applicationId]);
  const privacy = get("SELECT accepted FROM consents WHERE application_id = ? AND type = 'privacy' ORDER BY id DESC LIMIT 1", [applicationId]);
  return Boolean(terms?.accepted && privacy?.accepted);
}

function canonicalDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return raw.slice(0, 10);
}

function identityMatchDetails(application, entity = {}) {
  const normalize = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameParts = String(application.full_legal_name || '').trim().split(/\s+/).filter(Boolean);
  const first = normalize(entity.first_name || entity.firstname || entity.firstName);
  const last = normalize(entity.last_name || entity.surname || entity.last_name || entity.lastName);
  const nameBlob = normalize(application.full_legal_name);
  const nameMatch = Boolean(first && last && nameParts.length >= 2 && nameBlob.includes(first) && nameBlob.includes(last));
  const providerDob = canonicalDate(entity.dob || entity.date_of_birth || entity.dateOfBirth);
  const appDob = canonicalDate(application.date_of_birth);
  const dobMatch = !providerDob || !appDob || providerDob === appDob;
  return { matched: nameMatch && dobMatch, nameMatch, dobMatch, providerDobPresent: Boolean(providerDob), appDobPresent: Boolean(appDob) };
}

kycRouter.post('/api/kyc/session', async (req, res) => {
  const { application_id } = req.body || {};
  const application = get('SELECT * FROM member_applications WHERE id = ?', [application_id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (application.status !== 'APPLICATION_SUBMITTED' && application.status !== 'KYC_FAILED') {
    throw new HttpError(409, `Application must be submitted to start KYC (currently ${application.status})`);
  }
  if (!hasRequiredConsent(application_id)) {
    throw new HttpError(409, 'Terms and privacy consent are required before KYC.');
  }

  const sessionRef = `dojah_${DOJAH_ENV}_${crypto.randomUUID()}`;
  run(
    "INSERT INTO kyc_checks (application_id, provider, session_ref, status, raw_status_detail) VALUES (?, 'DOJAH', ?, 'KYC_PENDING', ?)",
    [application_id, sessionRef, JSON.stringify({ environment: DOJAH_ENV })]
  );
  run("UPDATE member_applications SET status = 'KYC_PENDING', updated_at = datetime('now') WHERE id = ?", [application_id]);
  audit(null, 'KYC_SESSION_STARTED', 'member_applications', application_id, {
    provider: 'DOJAH', environment: DOJAH_ENV, sessionRef,
  });

  res.json(201, {
    session_ref: sessionRef,
    provider: 'DOJAH',
    environment: DOJAH_ENV,
    configured: dojahConfigured(),
    message: DOJAH_ENV === 'sandbox'
      ? 'Dojah sandbox session created. No live identity source will be queried.'
      : 'Dojah live KYC session created.',
  });
});

kycRouter.post('/api/kyc/session/:ref/verify', async (req, res, params) => {
  const check = get('SELECT * FROM kyc_checks WHERE session_ref = ?', [params.ref]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  if (check.status === 'KYC_VERIFIED') return res.json(200, { status: 'KYC_VERIFIED' });

  const application = get('SELECT * FROM member_applications WHERE id = ?', [check.application_id]);
  if (!application) throw new HttpError(404, 'Application not found');

  const type = String(req.body?.type || 'nin').toLowerCase();
  const idNumber = String(req.body?.id_number || '').trim();
  if (!['nin', 'bvn'].includes(type)) throw new HttpError(400, 'KYC type must be nin or bvn.');
  if (!validIdNumber(idNumber)) throw new HttpError(400, 'Enter a valid 11-digit NIN or BVN.');

  // The identifier is used only for this provider request. It is never persisted.
  const path = type === 'bvn' ? '/api/v1/kyc/bvn' : '/api/v1/kyc/nin';
  let providerResponse;
  try {
    providerResponse = await dojahGet(path, { [type]: idNumber });
  } catch (error) {
    run(
      "UPDATE kyc_checks SET raw_status_detail = ? WHERE id = ?",
      [JSON.stringify({ environment: DOJAH_ENV, outcome: 'PROVIDER_ERROR', detail: error.providerDetail || null }), check.id]
    );
    audit(null, 'KYC_PROVIDER_ERROR', 'member_applications', check.application_id, {
      provider: 'DOJAH', environment: DOJAH_ENV, sessionRef: check.session_ref,
    });
    throw error;
  }

  const entity = providerResponse?.entity || providerResponse?.data?.entity || providerResponse?.data || {};
  // Normalize Dojah field-name variants without depending on letter case.
  // Some provider payloads use firstname/surname/birthdate while others use
  // first_name/last_name/dob.
  const entityByKey = Object.fromEntries(
    Object.entries(entity || {}).map(([key, value]) => [
      String(key).toLowerCase().replace(/[^a-z0-9]/g, ''),
      value,
    ])
  );
  const pick = (...keys) => {
    for (const key of keys) {
      const value = entityByKey[String(key).toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  };
  const normalizedEntity = {
    ...entity,
    first_name: pick('first_name', 'firstname', 'firstName', 'first'),
    last_name: pick('last_name', 'lastname', 'lastName', 'surname', 'family_name'),
    dob: pick('dob', 'date_of_birth', 'dateOfBirth', 'birthdate', 'birth_date'),
  };
  const match = identityMatchDetails(application, normalizedEntity);
  const matched = match.matched;
  const newStatus = matched ? 'KYC_VERIFIED' : 'KYC_FAILED';

  run(
    "UPDATE kyc_checks SET status = ?, raw_status_detail = ?, verified_at = CASE WHEN ? = 'KYC_VERIFIED' THEN datetime('now') ELSE verified_at END WHERE id = ?",
    [newStatus, JSON.stringify({ environment: DOJAH_ENV, outcome: matched ? 'MATCH' : 'MISMATCH', id_type: type }), newStatus, check.id]
  );
  run("UPDATE member_applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, check.application_id]);
  audit(null, matched ? 'KYC_VERIFIED' : 'KYC_FAILED', 'member_applications', check.application_id, {
    provider: 'DOJAH', environment: DOJAH_ENV, sessionRef: check.session_ref, idType: type,
  });

  res.json(200, {
    status: newStatus,
    provider: 'DOJAH',
    environment: DOJAH_ENV,
    message: matched ? 'Identity details matched.' : 'Identity details did not match the application.',
    ...(DOJAH_ENV === 'sandbox' ? { sandbox_match: {
      name_match: match.nameMatch,
      dob_match: match.dobMatch,
      provider_dob_present: match.providerDobPresent,
      application_dob_present: match.appDobPresent,
    }} : {}),
  });
});

kycRouter.get('/api/kyc/:id/status', async (req, res, params) => {
  const check = get('SELECT * FROM kyc_checks WHERE session_ref = ? OR application_id = ? ORDER BY id DESC LIMIT 1', [params.id, params.id]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  res.json(200, {
    status: check.status,
    session_ref: check.session_ref,
    provider: check.provider,
    environment: check.session_ref?.startsWith('dojah_live_') ? 'live' : 'sandbox',
    verified_at: check.verified_at,
  });
});

// Legacy simulation is deliberately disabled in deployed production. It is
// retained only for local development when explicitly enabled.
kycRouter.post('/api/kyc/session/:ref/simulate', async (req, res, params) => {
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEV_ROUTES !== 'true') {
    throw new HttpError(404, 'Not found');
  }
  const { outcome } = req.body || {};
  const check = get('SELECT * FROM kyc_checks WHERE session_ref = ?', [params.ref]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  const newStatus = outcome === 'FAILED' ? 'KYC_FAILED' : 'KYC_VERIFIED';
  run("UPDATE kyc_checks SET status = ?, verified_at = datetime('now') WHERE id = ?", [newStatus, check.id]);
  run("UPDATE member_applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, check.application_id]);
  audit(null, 'KYC_SIMULATED', 'member_applications', check.application_id, { newStatus });
  res.json(200, { status: newStatus });
});
