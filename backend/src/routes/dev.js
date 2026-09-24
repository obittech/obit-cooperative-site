// routes/dev.js
// A single, secret-gated endpoint to seed or reset a staff/admin account
// directly inside the running server process — guaranteed to hit the same
// database the live app actually uses (sidesteps any shell/disk mismatch).
// Protect with DEV_SEED_SECRET on Render. Safe to leave in place; useless
// to anyone without that secret, and only ever creates/updates a user row.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { hashPassword } from '../utils/auth.js';

export const devRouter = new Router();

devRouter.post('/api/dev/seed-admin', async (req, res) => {
  const { secret, email, password, role } = req.body || {};
  if (!process.env.DEV_SEED_SECRET || secret !== process.env.DEV_SEED_SECRET) {
    throw new HttpError(403, 'Invalid secret');
  }
  if (!email || !password) throw new HttpError(400, 'email and password required');

  const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    await run('UPDATE users SET password_hash = ?, role = ?, status = ? WHERE id = ?',
      [hashPassword(password), role || 'admin', 'ACTIVE', existing.id]);
  } else {
    await run('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)',
      [email, hashPassword(password), role || 'admin']);
  }
  res.json(200, { ok: true });
});
