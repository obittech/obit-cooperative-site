// routes/applications.js
// Covers: Visitor -> Become a Member -> Create Profile -> (KYC handled in routes/kyc.js)
// Deliberately does NOT accept full NIN/BVN fields — those belong to the
// approved KYC provider's own secure flow, never ordinary form POST bodies.

import { Router, HttpError } from '../router.js';
import { get, run, atomic } from '../db.js';
import { audit } from '../utils/audit.js';
import { validateApplicationProfile } from '../utils/application-profile.js';

import { applicationWithSponsor, saveSponsor, validateSavedSponsor, sponsorLocked } from '../services/member-referrals.js';

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

  const application = await atomic(async () => {
    const result = await run(
      `INSERT INTO member_applications (status, referral_source, campaign, interests_json)
       VALUES ('APPLICATION_STARTED', ?, ?, ?)`,
      [b.referral_source ?? null, b.campaign ?? null, interests]
    );
    const application = await get('SELECT * FROM member_applications WHERE id = ?', [result.lastInsertRowid]);
    if (b.referral_source) {
      await run('INSERT INTO referrals (application_id, referral_code, referred_by) VALUES (?, ?, ?)',
        [application.id, b.referral_source, b.referred_by ?? null]);
    }
    if ('sponsor_code' in b) await saveSponsor(application, b.sponsor_code);
    await audit(null, 'APPLICATION_STARTED', 'member_applications', application.id);
    return applicationWithSponsor(application);
  });
  res.json(201, application);
});

applicationsRouter.patch('/api/applications/:id', async (req, res, params) => {
  const application = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (!['LEAD', 'APPLICATION_STARTED', 'NEEDS_INFORMATION'].includes(application.status)) {
    throw new HttpError(409, `Application is ${application.status} and can no longer be edited directly`);
  }

  const b = req.body || {};
  const updates = [];
  const values = [];
  for (const field of EDITABLE_FIELDS) {
    if (field in b) {
      if (b[field] !== null && !['string', 'number'].includes(typeof b[field])) throw new HttpError(422, `Invalid value for ${field}`);
      updates.push(`${field} = ?`);
      values.push(typeof b[field] === 'string' ? b[field].trim() : b[field]);
    }
  }
  if (Array.isArray(b.interests)) { updates.push('interests_json = ?'); values.push(JSON.stringify(b.interests)); }
  if (updates.length === 0 && !('sponsor_code' in b)) throw new HttpError(400, 'No editable fields supplied');

  const updated = await atomic(async () => {
    await run('UPDATE member_applications SET status = status WHERE id = ?', [params.id]);
    const current = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
    if (!['LEAD', 'APPLICATION_STARTED', 'NEEDS_INFORMATION'].includes(current.status)) throw new HttpError(409, 'Application has already progressed. Refresh its status.');
    const locked = await sponsorLocked(params.id);
    if (locked && 'sponsor_code' in b && String(b.sponsor_code).trim().toUpperCase() !== (await applicationWithSponsor(current)).sponsor_code) throw new HttpError(409, 'The sponsor is fixed once payment instructions have been created. Contact support for corrections.');
    updates.push("updated_at = datetime('now')");
    values.push(params.id);
    await run(`UPDATE member_applications SET ${updates.join(', ')} WHERE id = ?`, values);

    const saved = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
    if (!locked) {
      if ('sponsor_code' in b) await saveSponsor(saved, b.sponsor_code);
      else await validateSavedSponsor(saved);
    }
    return applicationWithSponsor(saved);
  });
  res.json(200, updated);
});

applicationsRouter.post('/api/applications/:id/submit', async (req, res, params) => {
  const application = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (application.status === 'APPLICATION_SUBMITTED') return res.json(200, await applicationWithSponsor(application));
  if (!['LEAD', 'APPLICATION_STARTED', 'NEEDS_INFORMATION'].includes(application.status)) {
    throw new HttpError(409, `Application is ${application.status} and cannot be submitted again`);
  }
  validateApplicationProfile(application);

  const b = req.body || {};
  const consents = b.consents || {}; // { terms: true, privacy: true, marketing: false }
  if (consents.terms !== true || consents.privacy !== true) {
    throw new HttpError(422, 'Terms and Privacy consent are both required to submit');
  }
  await atomic(async () => {
    await run('UPDATE member_applications SET status = status WHERE id = ?', [params.id]);
    const fresh = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
    validateApplicationProfile(fresh);
    if (!await sponsorLocked(params.id)) await validateSavedSponsor(fresh);
    const changed = await run("UPDATE member_applications SET status = 'APPLICATION_SUBMITTED', updated_at = datetime('now') WHERE id = ? AND status IN ('LEAD', 'APPLICATION_STARTED', 'NEEDS_INFORMATION')", [params.id]);
    if (changed.changes !== 1) throw new HttpError(409, 'Application has already progressed. Refresh its status.');
    for (const type of ['terms', 'privacy', 'marketing']) {
      await run(
      `INSERT INTO consents (application_id, type, accepted, accepted_at, ip_address) VALUES (?, ?, ?, datetime('now'), ?)`,
      [params.id, type, consents[type] === true ? 1 : 0, req.socket?.remoteAddress || null]
    );
    }
    await audit(null, 'APPLICATION_SUBMITTED', 'member_applications', params.id);
  });

  const updated = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  res.json(200, await applicationWithSponsor(updated));
});

applicationsRouter.get('/api/applications/:id', async (req, res, params) => {
  const application = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  res.json(200, await applicationWithSponsor(application));
});
