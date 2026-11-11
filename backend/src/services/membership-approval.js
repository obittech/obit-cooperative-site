import { get, all, run } from '../db.js';
import { HttpError } from '../router.js';
import { nextMemberCode } from './member-code.js';
import { awardReferralBonus } from './member-referrals.js';

// A contact match requires staff review. It is not permission to merge accounts.
export async function existingMembershipForApplication(application) {
  return get(`SELECT m.id, m.application_id, m.member_code, m.status, m.user_id
    FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.application_id = ? OR lower(u.email) = lower(?) OR u.phone = ?
    ORDER BY CASE WHEN m.application_id = ? THEN 0 ELSE 1 END, m.id LIMIT 1`,
    [application.id, application.email, application.phone, application.id]);
}

export async function approvedMembershipForApplication(applicationId) {
  return get(`SELECT m.member_code, m.status FROM members m
    WHERE m.application_id = ? OR m.id = (SELECT member_id FROM membership_application_links WHERE application_id = ?)
    ORDER BY m.id LIMIT 1`, [applicationId, applicationId]);
}

// Called inside the caller's atomic transaction after payment is confirmed.
export async function activateApprovedMember(application, staffId) {
  const current = await get('SELECT status FROM member_applications WHERE id = ?', [application.id]);
  if (current?.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Application is not ready for approval');
  const applicationId = application.id;
      const confirmedPayment = await get("SELECT id FROM membership_bank_payments WHERE application_id = ? AND status = 'CONFIRMED'", [applicationId])
        || await get("SELECT id FROM membership_payments WHERE application_id = ? AND status = 'PAYMENT_VERIFIED'", [applicationId]);
      if (!confirmedPayment) throw new HttpError(409, 'Confirm the membership payment before approving this application.');
      const memberCode = await nextMemberCode();
      const credentials = await get('SELECT * FROM registration_credentials WHERE application_id = ?', [applicationId]);
      const matches = await all('SELECT * FROM users WHERE lower(email) = lower(?) OR phone = ?', [application.email, application.phone]);
      if (matches.length > 1) throw new HttpError(409, 'Member identity needs staff review');
      let user = matches[0];
      if (credentials && user) throw new HttpError(409, 'An existing account needs staff review before this registration login can be activated.');
      if (!user) {
        await run('INSERT INTO users (email, phone, role, username, password_hash) VALUES (?, ?, ?, ?, ?)', [application.email, application.phone, 'member', credentials?.username || null, credentials?.password_hash || null]);
        user = await get('SELECT * FROM users WHERE lower(email) = lower(?) OR phone = ?', [application.email, application.phone]);
      }
      if (user.role !== 'member' || user.status !== 'ACTIVE') throw new HttpError(409, 'An active separate member account is required');
      if (await get('SELECT id FROM members WHERE user_id = ?', [user.id])) throw new HttpError(409, 'This account already has a membership. Do not approve a duplicate application.');
      await run('INSERT INTO members (application_id, user_id, member_code, status) VALUES (?, ?, ?, ?)',
        [applicationId, user.id, memberCode, 'ACTIVE']);
      const member = await get('SELECT * FROM members WHERE application_id = ?', [applicationId]);
      await run('INSERT INTO community_onboarding (member_id) VALUES (?)', [member.id]);
      await run("INSERT INTO ledger_accounts (member_id) VALUES (?)", [member.id]);
      await run("UPDATE member_applications SET status = 'ACTIVE', user_id = ?, updated_at = datetime('now') WHERE id = ?", [user.id, applicationId]);
  await awardReferralBonus(applicationId, staffId);
  return get('SELECT * FROM members WHERE application_id = ?', [applicationId]);
}
