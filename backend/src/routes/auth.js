// routes/auth.js
// Member authentication and first-time portal setup.
// Portal setup is restricted to ACTIVE members. A short-lived OTP is sent
// to the member's registered email through Resend when configured.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { hashPassword, verifyPassword, issueToken } from '../utils/auth.js';
import { audit } from '../utils/audit.js';
import crypto from 'node:crypto';

const setupCodes = new Map();
const adminSetupCodes = new Map(); // userId -> { codeHash, expires, attempts }

export const authRouter = new Router();

async function sendSetupEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new HttpError(503, 'Email verification is not configured yet');
  const from = process.env.RESEND_FROM_EMAIL || 'Obit Cooperative <onboarding@resend.dev>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Your Obit Member Portal verification code',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Obit Cooperative Society</h2><p>Use this verification code to set up your Member Portal:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 15 minutes. If you did not request it, you can ignore this email.</p></div>`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Resend send failed:', response.status, detail);
    throw new HttpError(502, 'We could not send your verification email. Please try again.');
  }
}

async function sendAdminSetupEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new HttpError(503, 'Email verification is not configured yet');
  const from = process.env.RESEND_FROM_EMAIL || 'Obit Cooperative <onboarding@resend.dev>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Your Obit Admin Console activation code',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Obit Cooperative Society</h2><p>Use this one-time code to activate your Admin Console account:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 15 minutes. Do not share it.</p></div>`,
    }),
  });
  if (!response.ok) throw new HttpError(502, 'We could not send the admin activation email.');
}

function hashSetupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

authRouter.post('/api/auth/request-portal-setup', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  if (!identifier) throw new HttpError(400, 'Enter your registered email address');
  const application = get('SELECT * FROM member_applications WHERE lower(email) = lower(?) OR phone = ?', [identifier, identifier]);
  if (!application) throw new HttpError(404, 'No membership application matches that email or phone');
  if (application.status !== 'ACTIVE') {
    throw new HttpError(409, 'Portal setup opens after your membership application is approved and activated');
  }

  let user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  if (!user) {
    run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
    user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  }

  if (!application.email) throw new HttpError(409, 'This membership has no email address. Please contact Obit support.');
  const code = crypto.randomInt(100000, 1000000).toString();
  setupCodes.set(user.id, { codeHash: hashSetupCode(code), expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
  try {
    await sendSetupEmail(application.email, code);
  } catch (err) {
    setupCodes.delete(user.id);
    throw err;
  }
  audit(user.id, 'PORTAL_SETUP_CODE_SENT', 'user', user.id);
  res.json(200, { user_id: user.id, message: 'Verification code sent to your registered email.' });
});

authRouter.post('/api/auth/set-password', async (req, res, params) => {
  const { user_id, setup_code, password } = req.body;
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

  const entry = setupCodes.get(Number(user_id));
  if (!entry || entry.expires < Date.now()) {
    setupCodes.delete(Number(user_id));
    throw new HttpError(401, 'Invalid or expired setup code');
  }
  if (entry.attempts >= 5) {
    setupCodes.delete(Number(user_id));
    throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');
  }
  if (entry.codeHash !== hashSetupCode(setup_code)) {
    entry.attempts += 1;
    throw new HttpError(401, 'Invalid or expired setup code');
  }
  setupCodes.delete(Number(user_id));

  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user_id]);
  audit(user_id, 'PORTAL_PASSWORD_SET', 'user', user_id);
  res.json(200, { ok: true });
});

authRouter.post('/api/auth/request-admin-setup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const bootstrapEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!bootstrapEmail) throw new HttpError(503, 'Super Admin activation is not configured');
  if (!email || email !== bootstrapEmail) throw new HttpError(403, 'This email is not authorized for Super Admin activation');

  let user = get('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  if (user && user.role === 'member') throw new HttpError(409, 'Use a separate administrator email. Member and administrator identities must remain separate.');
  if (!user) {
    run("INSERT INTO users (email, role, status) VALUES (?, 'admin', 'ACTIVE')", [email]);
    user = get('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  } else if (user.role !== 'admin') {
    run("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  adminSetupCodes.set(user.id, { codeHash: hashSetupCode(code), expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
  try { await sendAdminSetupEmail(email, code); } catch (err) { adminSetupCodes.delete(user.id); throw err; }
  audit(user.id, 'ADMIN_SETUP_CODE_SENT', 'user', user.id);
  res.json(200, { user_id: user.id, message: 'Admin activation code sent to the authorized email.' });
});

authRouter.post('/api/auth/set-admin-password', async (req, res) => {
  const { user_id, setup_code, password } = req.body || {};
  if (!password || password.length < 12) throw new HttpError(400, 'Admin password must be at least 12 characters');
  const user = get("SELECT * FROM users WHERE id = ? AND role = 'admin' AND status = 'ACTIVE'", [user_id]);
  if (!user) throw new HttpError(403, 'Admin account not authorized');
  const entry = adminSetupCodes.get(Number(user_id));
  if (!entry || entry.expires < Date.now()) { adminSetupCodes.delete(Number(user_id)); throw new HttpError(401, 'Invalid or expired activation code'); }
  if (entry.attempts >= 5) { adminSetupCodes.delete(Number(user_id)); throw new HttpError(429, 'Too many incorrect attempts. Request a new code.'); }
  if (entry.codeHash !== hashSetupCode(setup_code)) { entry.attempts += 1; throw new HttpError(401, 'Invalid or expired activation code'); }
  adminSetupCodes.delete(Number(user_id));
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
  audit(user.id, 'ADMIN_PASSWORD_SET', 'user', user.id);
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
