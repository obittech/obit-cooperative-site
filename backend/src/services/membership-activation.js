import { get, all, run } from '../db.js';
import { HttpError } from '../router.js';
import { nextMemberCode } from './member-code.js';
// Caller must hold the application lock inside one database transaction.
export async function activateReviewedApplication(application) {
  if (application.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Application is not ready for approval');
  const memberCode = await nextMemberCode();
  const matches = await all('SELECT * FROM users WHERE lower(email) = lower(?) OR phone = ?', [application.email, application.phone]);
  if (matches.length > 1) throw new HttpError(409, 'Member identity needs staff review');
  let user = matches[0];
  if (!user) {
    await run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
    user = await get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
  }
  if (user.role !== 'member' || user.status !== 'ACTIVE') throw new HttpError(409, 'An active separate member account is required');
  if (await get('SELECT id FROM members WHERE user_id = ?', [user.id])) throw new HttpError(409, 'This account already has a membership. Do not approve a duplicate application.');
  await run('INSERT INTO members (application_id, user_id, member_code, status) VALUES (?, ?, ?, ?)',
    [application.id, user.id, memberCode, 'ACTIVE']);
  const member = await get('SELECT * FROM members WHERE application_id = ?', [application.id]);
  await run('INSERT INTO community_onboarding (member_id) VALUES (?)', [member.id]);
  await run("INSERT INTO ledger_accounts (member_id) VALUES (?)", [member.id]);
  await run("UPDATE member_applications SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?", [application.id]);
  return get('SELECT * FROM members WHERE application_id = ?', [application.id]);
}
