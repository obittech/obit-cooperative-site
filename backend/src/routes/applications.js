// routes/applications.js
// Covers: Visitor -> Become a Member -> Create Profile -> (KYC handled in routes/kyc.js)
// Deliberately does NOT accept full NIN/BVN fields — those belong to the
// approved KYC provider's own secure flow, never ordinary form POST bodies.

import { Router, HttpError } from '../router.js';
import { get, run, all } from '../db.js';
import { audit } from '../utils/audit.js';

export const applicationsRouter = new Router();

const EDITABLE_FIELDS = [
  'full_legal_name', 'date_of_birth', 'gender', 'phone', 'whatsapp', 'email',
  'address', 'state', 'lga', 'occupation_category', 'membership_type',
  'next_of_kin_name', 'next_of_kin_phone', 'intended_savings_amount',
  'intended_savings_frequency', 'referral_source', 'campaign',
];

applicationsRouter.post('/api/applications', async (req, res) => {
  const b = req.body || {};
  const interests = Array.isArray(b.interests) ? JSON.stringify(b.interests) : null;

  const result = run(
    `INSERT INTO member_applications (status, referral_source, campaign, interests_json)
     VALUES ('APPLICATION_STARTED', ?, ?, ?)`,
    [b.referral_source ?? null, b.campaign ?? null, interests]
  );
  const application = get('SELECT * FROM member_applications WHERE id = ?', [result.lastInsertRowid]);
  if (b.referral_source) {
    run('INSERT INTO referrals (application_id, referral_code, referred_by) VALUES (?, ?, ?)',
      [application.id, b.referral_source, b.referred_by ?? null]);
  }
  audit(null, 'APPLICATION_STARTED', 'member_applications', application.id);
  res.json(201, application);
});

applicationsRouter.patch('/api/applications/:id', async (req, res, params) => {
  const application = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (!['LEAD', 'APPLICATION_STARTED', 'NEEDS_INFORMATION'].includes(application.status)) {
    throw new HttpError(409, `Application is ${application.status} and can no longer be edited directly`);
  }

  const b = req.body || {};
  const updates = [];
  const values = [];
  for (const field of EDITABLE_FIELDS) {
    if (field in b) { updates.push(`${field} = ?`); values.push(b[field]); }
  }
  if (Array.isArray(b.interests)) { updates.push('interests_json = ?'); values.push(JSON.stringify(b.interests)); }
  if (updates.length === 0) throw new HttpError(400, 'No editable fields supplied');

  updates.push("updated_at = datetime('now')");
  values.push(params.id);
  run(`UPDATE member_applications SET ${updates.join(', ')} WHERE id = ?`, values);

  const updated = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  res.json(200, updated);
});

applicationsRouter.post('/api/applications/:id/submit', async (req, res, params) => {
  const application = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');

  const required = ['full_legal_name', 'phone', 'email', 'address', 'state', 'membership_type'];
  const missing = required.filter((f) => !application[f]);
  if (missing.length > 0) throw new HttpError(422, `Missing required fields: ${missing.join(', ')}`);

  const b = req.body || {};
  const consents = b.consents || {}; // { terms: true, privacy: true, marketing: false }
  if (!consents.terms || !consents.privacy) {
    throw new HttpError(422, 'Terms and Privacy consent are both required to submit');
  }
  for (const [type, accepted] of Object.entries(consents)) {
    run(
      `INSERT INTO consents (application_id, type, accepted, accepted_at, ip_address) VALUES (?, ?, ?, datetime('now'), ?)`,
      [params.id, type, accepted ? 1 : 0, req.socket.remoteAddress || null]
    );
  }

  run("UPDATE member_applications SET status = 'APPLICATION_SUBMITTED', updated_at = datetime('now') WHERE id = ?", [params.id]);
  audit(null, 'APPLICATION_SUBMITTED', 'member_applications', params.id);

  const updated = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  res.json(200, updated);
});

applicationsRouter.get('/api/applications/:id', async (req, res, params) => {
  const application = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  res.json(200, application);
});
