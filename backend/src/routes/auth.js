// routes/auth.js
// Member authentication and first-time portal setup.
// Portal setup is restricted to ACTIVE members. A short-lived OTP is sent
// to the member's registered email through Resend when configured.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { hashPassword, verifyPassword, issueToken } from '../utils/auth.js';
import { audit } from '../utils/audit.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'node:crypto';

const setupCodes = new Map();
const adminSetupCodes = new Map(); // userId -> { codeHash, expires, attempts }
const loginAttempts = new Map();
const adminLoginCodes = new Map();
const resetCodes = new Map();

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


async function sendAdminLoginEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new HttpError(503, 'Admin verification email is not configured');
  const from = process.env.RESEND_FROM_EMAIL || 'Obit Cooperative <onboarding@resend.dev>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject: 'Your Obit Admin login code',
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Obit Cooperative Society</h2><p>Use this one-time code to complete your Admin Console login:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. Do not share it.</p></div>`,
    }),
  });
  if (!response.ok) throw new HttpError(502, 'We could not send the admin login code.');
}

function hashSetupCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

authRouter.post('/api/auth/request-portal-setup', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  if (!identifier) throw new HttpError(400, 'Enter your registered email address');
  const application = await get('SELECT * FROM member_applications WHERE lower(email) = lower(?) OR phone = ?', [identifier, identifier]);
  if (!application) throw new HttpError(404, 'No membership application matches that email or phone');
  if (application.status !== 'ACTIVE') {
    throw new HttpError(409, 'Portal setup opens after your membership application is approved and activated');
  }

  let user = await get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  if (!user) {
    await run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
    user = await get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  }

  if (!application.email) throw new HttpError(409, 'This membership has no email address. Please contact Obit support.');
  const code = crypto.randomInt(100000, 1000000).toString();
  setupCodes.set(Number(user.id), { codeHash: hashSetupCode(code), expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
  try {
    await sendSetupEmail(application.email, code);
  } catch (err) {
    setupCodes.delete(Number(user.id));
    throw err;
  }
  await audit(user.id, 'PORTAL_SETUP_CODE_SENT', 'user', user.id);
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

  await run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [hashPassword(password), user_id]);
  await audit(user_id, 'PORTAL_PASSWORD_SET', 'user', user_id);
  res.json(200, { ok: true });
});

authRouter.post('/api/auth/request-admin-setup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const bootstrapEmail = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!bootstrapEmail) throw new HttpError(503, 'Super Admin activation is not configured');
  if (!email || email !== bootstrapEmail) throw new HttpError(403, 'This email is not authorized for Super Admin activation');

  let user = await get('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  if (user && user.role === 'member') throw new HttpError(409, 'Use a separate administrator email. Member and administrator identities must remain separate.');
  if (!user) {
    await run("INSERT INTO users (email, role, status) VALUES (?, 'admin', 'ACTIVE')", [email]);
    user = await get('SELECT * FROM users WHERE lower(email) = lower(?)', [email]);
  } else if (user.role !== 'admin') {
    await run("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  adminSetupCodes.set(Number(user.id), { codeHash: hashSetupCode(code), expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
  try { await sendAdminSetupEmail(email, code); } catch (err) { adminSetupCodes.delete(Number(user.id)); throw err; }
  await audit(user.id, 'ADMIN_SETUP_CODE_SENT', 'user', user.id);
  res.json(200, { user_id: user.id, message: 'Admin activation code sent to the authorized email.' });
});

authRouter.post('/api/auth/set-admin-password', async (req, res) => {
  const { user_id, setup_code, password } = req.body || {};
  if (!password || password.length < 12) throw new HttpError(400, 'Admin password must be at least 12 characters');
  const user = await get("SELECT * FROM users WHERE id = ? AND role = 'admin' AND status = 'ACTIVE'", [user_id]);
  if (!user) throw new HttpError(403, 'Admin account not authorized');
  const entry = adminSetupCodes.get(Number(user_id));
  if (!entry || entry.expires < Date.now()) { adminSetupCodes.delete(Number(user_id)); throw new HttpError(401, 'Invalid or expired activation code'); }
  if (entry.attempts >= 5) { adminSetupCodes.delete(Number(user_id)); throw new HttpError(429, 'Too many incorrect attempts. Request a new code.'); }
  if (entry.codeHash !== hashSetupCode(setup_code)) { entry.attempts += 1; throw new HttpError(401, 'Invalid or expired activation code'); }
  adminSetupCodes.delete(Number(user_id));
  await run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [hashPassword(password), user.id]);
  await audit(user.id, 'ADMIN_PASSWORD_SET', 'user', user.id);
  res.json(200, { ok: true });
});

authRouter.post('/api/auth/request-password-reset', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  const generic = { message: 'If an active account matches that email, a password reset code has been sent.' };
  if (!identifier) { res.json(200, generic); return; }
  const user = await get("SELECT * FROM users WHERE lower(email) = lower(?) AND status = 'ACTIVE'", [identifier]);
  if (!user?.email) { res.json(200, generic); return; }
  const code = crypto.randomInt(100000, 1000000).toString();
  resetCodes.set(Number(user.id), { codeHash: hashSetupCode(code), expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
  try { await sendSetupEmail(user.email, code); } catch (err) { resetCodes.delete(Number(user.id)); throw err; }
  await audit(user.id, 'PASSWORD_RESET_CODE_SENT', 'user', user.id);
  res.json(200, generic);
});

authRouter.post('/api/auth/reset-password', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');
  const user = await get("SELECT * FROM users WHERE lower(email) = lower(?) AND status = 'ACTIVE'", [identifier]);
  if (!user) throw new HttpError(401, 'Invalid or expired reset code');
  const minLength = user.role === 'admin' ? 12 : 8;
  if (password.length < minLength) throw new HttpError(400, `Password must be at least ${minLength} characters`);
  const entry = resetCodes.get(Number(user.id));
  if (!entry || entry.expires < Date.now()) { resetCodes.delete(Number(user.id)); throw new HttpError(401, 'Invalid or expired reset code'); }
  if (entry.attempts >= 5) { resetCodes.delete(Number(user.id)); throw new HttpError(429, 'Too many incorrect attempts. Request a new code.'); }
  if (entry.codeHash !== hashSetupCode(code)) { entry.attempts += 1; throw new HttpError(401, 'Invalid or expired reset code'); }
  resetCodes.delete(Number(user.id));
  await run('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [hashPassword(password), user.id]);
  await audit(user.id, 'PASSWORD_RESET_COMPLETED', 'user', user.id);
  res.json(200, { ok: true });
});

authRouter.post('/api/auth/login', async (req, res, params) => {
  const { identifier, password } = req.body; // identifier = email or phone
  const key = String(identifier || '').trim().toLowerCase();
  const state = loginAttempts.get(key);
  if (state?.lockedUntil > Date.now()) throw new HttpError(429, 'Too many failed login attempts. Try again later.');
  const user = await get('SELECT * FROM users WHERE lower(email) = lower(?) OR phone = ?', [identifier, identifier]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    const current = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
    current.count += 1;
    if (current.count >= 5) { current.count = 0; current.lockedUntil = Date.now() + 15 * 60 * 1000; }
    loginAttempts.set(key, current);
    throw new HttpError(401, 'Incorrect credentials');
  }
  loginAttempts.delete(key);
  if (user.status !== 'ACTIVE') throw new HttpError(403, 'Account is not active');

  if (user.role === 'admin') {
    const code = crypto.randomInt(100000, 1000000).toString();
    adminLoginCodes.set(Number(user.id), { codeHash: hashSetupCode(code), expires: Date.now() + 10 * 60 * 1000, attempts: 0 });
    try { await sendAdminLoginEmail(user.email, code); } catch (err) { adminLoginCodes.delete(Number(user.id)); throw err; }
    await audit(user.id, 'ADMIN_LOGIN_MFA_SENT', 'user', user.id);
    res.json(200, { mfa_required: true, user_id: user.id, role: user.role });
    return;
  }
  const token = issueToken(user);
  await audit(user.id, 'LOGIN', 'user', user.id);
  res.json(200, { token, role: user.role });
});


authRouter.post('/api/auth/admin-mfa', async (req, res) => {
  const userId = Number(req.body?.user_id);
  const code = String(req.body?.code || '').trim();
  const user = await get("SELECT * FROM users WHERE id = ? AND role = 'admin' AND status = 'ACTIVE'", [userId]);
  const entry = adminLoginCodes.get(userId);
  if (!user || !entry || entry.expires < Date.now()) {
    adminLoginCodes.delete(userId);
    throw new HttpError(401, 'Invalid or expired admin login code');
  }
  if (entry.attempts >= 5) {
    adminLoginCodes.delete(userId);
    throw new HttpError(429, 'Too many incorrect attempts. Sign in again.');
  }
  if (entry.codeHash !== hashSetupCode(code)) {
    entry.attempts += 1;
    throw new HttpError(401, 'Invalid or expired admin login code');
  }
  adminLoginCodes.delete(userId);
  const token = issueToken(user);
  await audit(user.id, 'ADMIN_LOGIN_MFA_VERIFIED', 'user', user.id);
  res.json(200, { token, role: user.role });
});


authRouter.post('/api/auth/logout', requireAuth(), async (req, res) => {
  await run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [req.user.id]);
  await audit(req.user.id, 'LOGOUT_ALL_SESSIONS', 'user', req.user.id);
  res.json(200, { ok: true });
});
