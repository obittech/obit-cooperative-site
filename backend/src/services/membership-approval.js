import { get, run } from '../db.js';
import { HttpError } from '../router.js';
import { nextMemberCode } from './member-code.js';
import { awardReferralBonus } from './member-referrals.js';

// Called inside the caller's atomic transaction after payment is confirmed.
export async function activateApprovedMember(application, staffId) {
  const applicationId = application.id;
      const confirmedPayment = await get("SELECT id FROM membership_bank_payments WHERE application_id = ? AND status = 'CONFIRMED'", [applicationId])
        || await get("SELECT id FROM membership_payments WHERE application_id = ? AND status = 'PAYMENT_VERIFIED'", [applicationId]);
      if (!confirmedPayment) throw new HttpError(409, 'Confirm the membership payment before approving this application.');
      const memberCode = await nextMemberCode();
      let user = await get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
      if (!user) {
        await run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
        user = await get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
      }
      if (await get('SELECT id FROM members WHERE user_id = ?', [user.id])) throw new HttpError(409, 'This account already has a membership. Do not approve a duplicate application.');
      await run('INSERT INTO members (application_id, user_id, member_code, status) VALUES (?, ?, ?, ?)',
        [applicationId, user.id, memberCode, 'ACTIVE']);
      const member = await get('SELECT * FROM members WHERE application_id = ?', [applicationId]);
      await run('INSERT INTO community_onboarding (member_id) VALUES (?)', [member.id]);
      await run("INSERT INTO ledger_accounts (member_id) VALUES (?)", [member.id]);
      await run("UPDATE member_applications SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?", [applicationId]);
  await awardReferralBonus(applicationId, staffId);
  return get('SELECT * FROM members WHERE application_id = ?', [applicationId]);
}
