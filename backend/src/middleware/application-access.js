import crypto from 'node:crypto';
import { get } from '../db.js';
import { HttpError } from '../router.js';
import { requireAuth } from './auth.js';

const TTL_SECONDS = 4 * 60 * 60;
const secret = () => {
  if (!process.env.AUTH_TOKEN_SECRET) throw new Error('AUTH_TOKEN_SECRET is required');
  return process.env.AUTH_TOKEN_SECRET;
};
const sign = body => crypto.createHmac('sha256', secret()).update(`application-session:${body}`).digest('base64url');

// No email/phone matching: only an application's explicit membership link proves ownership.
export async function applicationCredential(id) {
  const user = await get(`SELECT u.*, m.status AS membership_status FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.application_id = ? OR m.id = (SELECT member_id FROM membership_application_links WHERE application_id = ?) LIMIT 1`, [id, id]);
  if (user) return { ...user, linked: true };
  return await get('SELECT username, password_hash FROM registration_credentials WHERE application_id = ?', [id]) || {};
}
const version = credential => crypto.createHash('sha256').update(`${credential.password_hash || ''}:${Number(credential.session_version || 0)}`).digest('hex');
const usable = credential => !credential.linked || (credential.status === 'ACTIVE' && credential.membership_status === 'ACTIVE');

// Issued only at creation or after credential proof, never from an application number.
export async function issueApplicationSession(id) {
  const credential = await applicationCredential(id);
  if (!usable(credential)) throw new HttpError(403, 'Application access is unavailable. Contact support.');
  const payload = { aid: Number(id), ver: version(credential), exp: Math.floor(Date.now() / 1000) + TTL_SECONDS, nonce: crypto.randomBytes(16).toString('hex') };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `app.${body}.${sign(body)}`;
}

function readSession(token) {
  try {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'app') return null;
    const [ , body, sig ] = parts;
    const actual = Buffer.from(sig), expected = Buffer.from(sign(body));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(value.aid) || value.aid <= 0 || !Number.isSafeInteger(value.exp) || value.exp <= Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch { return null; }
}

// Authenticate before resolving a KYC/payment reference; a reference is not a credential.
export function requireApplicationAccess(resolveId) {
  return async (req, res, params) => {
    const header = req.headers?.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = readSession(token);
    if (!session) {
      if (!token || token.startsWith('app.')) throw new HttpError(401, 'Sign in to resume your application.');
      await requireAuth()(req);
    }
    const rawId = await resolveId(req, params);
    const id = Number(rawId);
    if (!['string', 'number'].includes(typeof rawId) || !/^[1-9]\d*$/.test(String(rawId)) || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(403, 'Application access denied.');
    if (session) {
      if (session.aid !== id) throw new HttpError(403, 'Application access denied.');
      const credential = await applicationCredential(id);
      if (!usable(credential) || session.ver !== version(credential)) throw new HttpError(401, 'Sign in to resume your application.');
    } else if (!['staff', 'admin'].includes(req.user.role)) {
      const credential = await applicationCredential(id);
      if (!credential.linked || !usable(credential) || Number(credential.id) !== Number(req.user.id)) throw new HttpError(403, 'Application access denied.');
    }
    res.setHeader?.('Cache-Control', 'no-store');
    req.applicationId = id;
  };
}
export const applicationParam = requireApplicationAccess((req, params) => params.id);
export const applicationBody = requireApplicationAccess(req => req.body?.application_id);
export const kycReference = requireApplicationAccess(async (req, params) => (await get('SELECT application_id FROM kyc_checks WHERE session_ref = ?', [params.ref]))?.application_id);
export const kycStatus = requireApplicationAccess(async (req, params) => /^\d+$/.test(params.id) ? params.id : (await get('SELECT application_id FROM kyc_checks WHERE session_ref = ?', [params.id]))?.application_id);
export const transferReference = requireApplicationAccess(async (req, params) => (await get('SELECT application_id FROM membership_bank_payments WHERE reference = ?', [params.reference]))?.application_id);
