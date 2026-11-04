import { get } from '../db.js';
import { HttpError } from '../router.js';

export function registrationUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9._]{3,23}$/.test(username)) throw new HttpError(422, 'Choose a username of 4 to 24 characters, starting with a letter. Use letters, numbers, dots or underscores.');
  return username;
}

export async function usernameAvailable(username, userId = null) {
  const user = await get('SELECT id FROM users WHERE lower(username) = ?', [username]);
  const reserved = await get('SELECT application_id FROM registration_credentials WHERE username = ?', [username]);
  if ((user && Number(user.id) !== Number(userId)) || (reserved && !user)) throw new HttpError(409, 'That username is already registered. Choose another username.');
}

export async function applicationLoginInfo(applicationId) {
  const registration = await get('SELECT username FROM registration_credentials WHERE application_id = ?', [applicationId]);
  const user = await get(`SELECT u.username, u.password_hash FROM users u JOIN members m ON m.user_id = u.id
    WHERE m.application_id = ? OR m.id = (SELECT member_id FROM membership_application_links WHERE application_id = ?) LIMIT 1`, [applicationId, applicationId]);
  return { username: user?.username || registration?.username || null, has_login_credentials: Boolean(user ? user.password_hash : registration) };
}
