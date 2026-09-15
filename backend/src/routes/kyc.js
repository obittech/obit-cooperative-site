// routes/kyc.js
// SANDBOX PROVIDER: in production, `session_ref` is returned by your real KYC
// vendor's API and the member is redirected into THEIR hosted flow to submit
// NIN/BVN/selfie etc. This app never touches that data directly. Here, the
// "provider" just flips PENDING -> VERIFIED after a short delay so the rest
// of the funnel (payment, activation) is testable end-to-end.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { audit } from '../utils/audit.js';
import crypto from 'node:crypto';

export const kycRouter = new Router();

kycRouter.post('/api/kyc/session', async (req, res) => {
  const { application_id } = req.body || {};
  const application = get('SELECT * FROM member_applications WHERE id = ?', [application_id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (application.status !== 'APPLICATION_SUBMITTED') {
    throw new HttpError(409, `Application must be APPLICATION_SUBMITTED to start KYC (currently ${application.status})`);
  }

  const sessionRef = `sandbox_kyc_${crypto.randomUUID()}`;
  run(
    `INSERT INTO kyc_checks (application_id, provider, session_ref, status) VALUES (?, 'SANDBOX', ?, 'KYC_PENDING')`,
    [application_id, sessionRef]
  );
  run("UPDATE member_applications SET status = 'KYC_PENDING', updated_at = datetime('now') WHERE id = ?", [application_id]);
  audit(null, 'KYC_SESSION_STARTED', 'member_applications', application_id, { sessionRef });

  res.json(201, {
    session_ref: sessionRef,
    sandbox_note: 'No real identity document is collected here. Poll GET /api/kyc/:id/status, or call POST /api/kyc/session/:ref/simulate to move it along in dev.',
  });
});

kycRouter.get('/api/kyc/:id/status', async (req, res, params) => {
  const check = get('SELECT * FROM kyc_checks WHERE session_ref = ? OR application_id = ? ORDER BY id DESC LIMIT 1', [params.id, params.id]);
  if (!check) throw new HttpError(404, 'KYC session not found');
  res.json(200, { status: check.status, session_ref: check.session_ref, verified_at: check.verified_at });
});

// Dev-only helper to simulate the provider's callback locally.
kycRouter.post('/api/kyc/session/:ref/simulate', async (req, res, params) => {
  const { outcome } = req.body || {}; // 'VERIFIED' | 'FAILED'
  const check = get('SELECT * FROM kyc_checks WHERE session_ref = ?', [params.ref]);
  if (!check) throw new HttpError(404, 'KYC session not found');

  const newStatus = outcome === 'FAILED' ? 'KYC_FAILED' : 'KYC_VERIFIED';
  run("UPDATE kyc_checks SET status = ?, verified_at = datetime('now') WHERE id = ?", [newStatus, check.id]);
  run("UPDATE member_applications SET status = ?, updated_at = datetime('now') WHERE id = ?", [newStatus, check.application_id]);
  audit(null, 'KYC_SIMULATED', 'member_applications', check.application_id, { newStatus });

  res.json(200, { status: newStatus });
});
