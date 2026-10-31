import { get, run } from '../db.js';
import { HttpError } from '../router.js';
import { audit } from '../utils/audit.js';

function phoneKey(value) {
  return String(value || '').replace(/\D/g, '').replace(/^(?:234|0)(?=\d{10}$)/, '');
}
function samePerson(app, sponsor) {
  return Number(app.id) === Number(sponsor.application_id)
    || (app.email && String(app.email).trim().toLowerCase() === String(sponsor.email || '').trim().toLowerCase())
    || (phoneKey(app.phone) && phoneKey(app.phone) === phoneKey(sponsor.phone));
}
export async function sponsorForApplication(id) {
  return get('SELECT member_code, full_legal_name, phone FROM application_sponsors WHERE application_id = ?', [id]);
}
export async function applicationWithSponsor(app) {
  const sponsor = await sponsorForApplication(app.id);
  return { ...app, sponsor_code: sponsor?.member_code || '' };
}
// The caller locks the application inside a transaction. Names and telephone
// numbers always come from the activated membership record, never form input.
export async function saveSponsor(app, value) {
  if (typeof value !== 'string') throw new HttpError(422, 'Enter the sponsor membership code as text.');
  const code = value.trim().toUpperCase();
  if (!code) {
    await run('DELETE FROM application_sponsors WHERE application_id = ?', [app.id]);
    return;
  }
  if (!/^OBT-\d{4}-\d{6,}$/.test(code)) throw new HttpError(422, 'Enter a valid sponsor membership code, for example OBT-2026-000123.');
  const sponsor = await get(`SELECT m.id, m.application_id, m.member_code, a.full_legal_name, a.phone, a.email
    FROM members m JOIN member_applications a ON a.id = m.application_id
    JOIN users u ON u.id = m.user_id
    WHERE m.member_code = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' AND u.status = 'ACTIVE'`, [code]);
  if (!sponsor || !sponsor.full_legal_name || !/^\d{10,15}$/.test(String(sponsor.phone || '').replace(/\D/g, ''))) {
    throw new HttpError(422, 'This sponsor code is not linked to an active member with a registered phone number. Please check the code.');
  }
  if (samePerson(app, sponsor)) throw new HttpError(422, 'You cannot refer yourself. Use another active member’s membership code.');
  await run(`INSERT INTO application_sponsors (application_id,sponsor_member_id,member_code,full_legal_name,phone,created_ms)
    VALUES (?,?,?,?,?,?) ON CONFLICT(application_id) DO UPDATE SET sponsor_member_id=excluded.sponsor_member_id,
    member_code=excluded.member_code,full_legal_name=excluded.full_legal_name,phone=excluded.phone,created_ms=excluded.created_ms
    RETURNING application_id`, [app.id, sponsor.id, sponsor.member_code, sponsor.full_legal_name, sponsor.phone, Date.now()]);
}
export async function sponsorLocked(id) {
  return Boolean(await get('SELECT id FROM membership_bank_payments WHERE application_id = ?', [id])
    || await get('SELECT id FROM membership_payments WHERE application_id = ?', [id]));
}
export async function validateSavedSponsor(app) {
  const sponsor = await sponsorForApplication(app.id);
  if (sponsor) await saveSponsor(app, sponsor.member_code);
}
// Earned bonuses are separate from member savings. This records an amount
// payable by Obit, and never initiates a bank transfer or credits savings.
export async function awardReferralBonus(applicationId, actorId) {
  const app = await get('SELECT * FROM member_applications WHERE id = ?', [applicationId]);
  if (app?.status !== 'ACTIVE') return;
  const sponsor = await get('SELECT * FROM application_sponsors WHERE application_id = ?', [applicationId]);
  if (!sponsor) return;
  const source = await get('SELECT a.* FROM members m JOIN member_applications a ON a.id = m.application_id WHERE m.id = ?', [sponsor.sponsor_member_id]);
  if (source && samePerson(app, { ...source, application_id: source.id })) throw new HttpError(409, 'A member cannot earn a referral bonus for their own application.');
  const payment = await get("SELECT id FROM membership_bank_payments WHERE application_id = ? AND status = 'CONFIRMED'", [applicationId])
    || await get("SELECT id FROM membership_payments WHERE application_id = ? AND status = 'PAYMENT_VERIFIED'", [applicationId]);
  if (!payment) return;
  const result = await run(`INSERT INTO referral_bonuses (application_id,sponsor_member_id,amount_kobo,status,earned_ms)
    VALUES (?,?,50000,'EARNED',?) ON CONFLICT(application_id) DO NOTHING RETURNING id`, [applicationId, sponsor.sponsor_member_id, Date.now()]);
  if (result.changes) await audit(actorId, 'REFERRAL_BONUS_EARNED', 'member_applications', applicationId, { sponsor_member_id: sponsor.sponsor_member_id, amount_kobo: 50000 });
}
