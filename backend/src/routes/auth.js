// routes/auth.js
// SANDBOX NOTE: real deployments verify phone/email ownership via an SMS/email
// OTP provider before letting a member set a portal password. That provider
// is not wired up here — set_password below trusts a `setup_code` that this
// scaffold prints to the server log instead of sending it, so the flow is
// testable end-to-end without live SMS/email credentials. Replace before launch.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { hashPassword, verifyPassword, issueToken } from '../utils/auth.js';
import { audit } from '../utils/audit.js';
import crypto from 'node:crypto';

const setupCodes = new Map(); // userId -> { code, expires }  (in-memory; fine for a single sandbox instance)

export const authRouter = new Router();

authRouter.post('/api/auth/request-portal-setup', async (req, res, params) => {
  const { application_id } = req.body;
  const application = get('SELECT * FROM member_applications WHERE id = ?', [application_id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (!['PAYMENT_VERIFIED', 'UNDER_REVIEW', 'ACTIVE'].includes(application.status)) {
    throw new HttpError(409, 'Portal access opens after membership payment is verified');
  }

  let user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  if (!user) {
    run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
    user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  }

  const code = crypto.randomInt(100000, 999999).toString();
  setupCodes.set(user.id, { code, expires: Date.now() + 15 * 60 * 1000 });

  // SANDBOX: printed to the server log in place of a real SMS/email send.
  console.log(`[SANDBOX OTP] Portal setup code for user ${user.id} (${application.email || application.phone}): ${code}`);

  res.json(200, { user_id: user.id, sandbox_note: 'Code was NOT sent — check the server log. Replace with a real SMS/email provider before launch.' });
});

authRouter.post('/api/auth/set-password', async (req, res, params) => {
  const { user_id, setup_code, password } = req.body;
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  const entry = setupCodes.get(Number(user_id));
  if (!entry || entry.code !== String(setup_code) || entry.expires < Date.now()) {
    throw new HttpError(401, 'Invalid or expired setup code');
  }
  setupCodes.delete(Number(user_id));

  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user_id]);
  audit(user_id, 'PORTAL_PASSWORD_SET', 'user', user_id);
  res.json(200, { ok: true });
});

authRouter.post('/api/auth/login', async (req, res, params) => {
  const { identifier, password } = req.body; // identifier = email or phone
  const user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [identifier, identifier]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Incorrect credentials');
  }
  if (user.status !== 'ACTIVE') throw new HttpError(403, 'Account is not active');

  const token = issueToken(user);
  audit(user.id, 'LOGIN', 'user', user.id);
  res.json(200, { token, role: user.role });
});
