// auth.js — password hashing (scrypt) and signed opaque bearer tokens.
// No external deps (no bcrypt/jsonwebtoken) so the scaffold runs with
// nothing but `node`. Swap for your standard stack (e.g. jsonwebtoken +
// argon2) if your team prefers — the interface below is what routes rely on.

import crypto from 'node:crypto';

const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET;
if (!TOKEN_SECRET) {
  throw new Error('AUTH_TOKEN_SECRET is not set. Copy .env.example to .env and set a real secret.');
}
const MEMBER_TOKEN_TTL_SECONDS = 60 * 60 * 4; // 4h member session
const ADMIN_TOKEN_TTL_SECONDS = 60 * 30; // 30m privileged admin session

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Opaque signed token: base64url(payload) + "." + hmac(payload)
// payload = { uid, role, exp }
export function issueToken(user) {
  const payload = {
    uid: user.id,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + (user.role === 'admin' ? ADMIN_TOKEN_TTL_SECONDS : MEMBER_TOKEN_TTL_SECONDS),
    iat: Math.floor(Date.now() / 1000),
    sv: Number(user.session_version || 0),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload; // { uid, role, exp, sv }
}

export function generateMemberCode(sequence) {
  const year = new Date().getFullYear();
  return `OBT-${year}-${String(sequence).padStart(6, '0')}`;
}
