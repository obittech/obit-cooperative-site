import crypto from 'node:crypto';
import { Router, HttpError } from '../router.js';
import { get, run, all, atomic } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { parseNgnToKobo } from '../utils/money.js';
import { bankTransferConfig } from '../services/market-bank-transfer.js';
import { allocateBankCredit } from '../services/bank-credit.js';
import { activateApprovedMember, existingMembershipForApplication } from '../services/membership-approval.js';

import { sponsorForApplication } from '../services/member-referrals.js';

export const membershipTransfersRouter = new Router();

function config() {
  const bank = bankTransferConfig();
  if (!bank.available || process.env.MEMBERSHIP_TRANSFER_ENABLED === 'false') throw new HttpError(503, 'Membership bank transfer is not configured. Please contact Obit support.');
  return bank;
}
function membershipFee() {
  try { return parseNgnToKobo(process.env.MEMBERSHIP_FEE_NGN || '3000'); }
  catch { throw new HttpError(503, 'Membership fee is not configured correctly.'); }
}
async function details(payment) {
  const sponsor = await sponsorForApplication(payment.application_id);
  const applicant = await get('SELECT full_legal_name, phone, whatsapp, email, address, state, lga FROM member_applications WHERE id = ?', [payment.application_id]);
  if (!applicant) throw new HttpError(404, 'Application not found');
  const amount = Number(payment.amount_kobo) / 100;
  let text = `Hello Obit, I have paid ₦${amount.toLocaleString('en-NG')} for my cooperative membership. Application: ${payment.application_id}. Payment reference: ${payment.reference}. Please check the bank credit and confirm my payment.`;
  text += `\nMember name: ${applicant.full_legal_name || 'Not provided'}.\nPhone: ${applicant.phone || 'Not provided'}.\nWhatsApp: ${applicant.whatsapp || applicant.phone || 'Not provided'}.\nAddress: ${[applicant.address, applicant.lga, applicant.state].filter(Boolean).join(', ') || 'Not provided'}.\nEmail: ${applicant.email || 'Not provided'}.`;
  text += sponsor ? ` Sponsor membership code: ${sponsor.member_code}. Sponsor name: ${sponsor.full_legal_name}. Sponsor phone: ${sponsor.phone}. Referral bonus: ₦500 after payment confirmation and membership approval.` : ' Sponsor: no member referral.';
  return { sponsor: sponsor || null, referral_bonus_amount_kobo: sponsor ? 50000 : 0, provider: 'bank_transfer', application_id: Number(payment.application_id), reference: payment.reference,
    amount, amount_kobo: Number(payment.amount_kobo), currency: 'NGN', status: payment.status,
    bank_name: payment.bank_name, account_name: payment.account_name, account_number: payment.account_number,
    whatsapp_url: `https://wa.me/${payment.whatsapp}?text=${encodeURIComponent(text)}`,
    receipt_reference: payment.status === 'CONFIRMED' ? `OBIT-MEMBER-${payment.reference}` : null,
    confirmed_at: payment.confirmed_ms ? new Date(Number(payment.confirmed_ms)).toISOString() : null };
}

membershipTransfersRouter.get('/api/payments/membership/options', async (req, res) => {
  const bank = config();
  res.json(200, { provider: 'bank_transfer', bank_name: bank.bank_name, account_name: bank.account_name,
    account_number: bank.account_number, amount_kobo: membershipFee(), currency: 'NGN', whatsapp: bank.whatsapp });
});

membershipTransfersRouter.post('/api/payments/membership/bank-transfer', async (req, res) => {
  const payment = await atomic(async () => {
    const id = req.body?.application_id;
    await run('UPDATE member_applications SET status = status WHERE id = ?', [id]);
    const app = await get('SELECT * FROM member_applications WHERE id = ?', [id]);
    if (!app) throw new HttpError(404, 'Application not found');
    const old = await get('SELECT * FROM membership_bank_payments WHERE application_id = ?', [id]);
    if (old) {
      if (old.status !== 'CONFIRMED' && app.status !== 'PAYMENT_PENDING') throw new HttpError(409, 'Contact support before making any further payment for this application.');
      return old;
    }
    if (app.status !== 'KYC_VERIFIED') throw new HttpError(409, 'Complete identity verification before paying the membership fee.');
    if (await get("SELECT id FROM membership_payments WHERE application_id = ? AND status IN ('PAYMENT_PENDING','PAYMENT_VERIFIED')", [id])) throw new HttpError(409, 'Another payment record exists. Contact support before paying again.');
    const bank = config();
    const amount = membershipFee();
    const reference = `OBIT-MEM-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
    await run("INSERT INTO membership_bank_payments (application_id,reference,amount_kobo,bank_name,account_name,account_number,whatsapp,status,created_ms) VALUES (?,?,?,?,?,?,?,'READY',?)", [id, reference, amount, bank.bank_name, bank.account_name, bank.account_number, bank.whatsapp, Date.now()]);
    await run("UPDATE member_applications SET status = 'PAYMENT_PENDING', updated_at = datetime('now') WHERE id = ?", [id]);
    await audit(null, 'MEMBERSHIP_TRANSFER_STARTED', 'member_applications', id, { reference, amount_kobo: amount });
    return get('SELECT * FROM membership_bank_payments WHERE application_id = ?', [id]);
  });
  res.json(200, await details(payment));
});

membershipTransfersRouter.get('/api/payments/membership/bank-transfer/:applicationId', async (req, res, params) => {
  const payment = await get('SELECT * FROM membership_bank_payments WHERE application_id = ?', [params.applicationId]);
  if (!payment) throw new HttpError(404, 'Membership transfer not found');
  res.json(200, await details(payment));
});

membershipTransfersRouter.post('/api/payments/membership/bank-transfer/:reference/paid', async (req, res, params) => {
  const payment = await atomic(async () => {
    await run('UPDATE membership_bank_payments SET status = status WHERE reference = ?', [params.reference]);
    const row = await get('SELECT * FROM membership_bank_payments WHERE reference = ?', [params.reference]);
    if (!row) throw new HttpError(404, 'Membership transfer not found');
    if (row.status === 'READY') {
      await run("UPDATE membership_bank_payments SET status = 'CLAIMED', claimed_ms = ? WHERE id = ?", [Date.now(), row.id]);
      await audit(null, 'MEMBERSHIP_TRANSFER_REPORTED', 'member_applications', row.application_id, { reference: row.reference });
    }
    return get('SELECT * FROM membership_bank_payments WHERE id = ?', [row.id]);
  });
  res.json(200, await details(payment));
});

membershipTransfersRouter.get('/api/admin/membership-transfers', requireAuth('staff', 'admin'), async (req, res) => {
  res.json(200, await all(`SELECT b.*, a.full_legal_name, a.status AS application_status, s.member_code AS sponsor_code, s.full_legal_name AS sponsor_name, s.phone AS sponsor_phone,
    m.member_code AS existing_member_code, m.status AS existing_member_status, m.application_id AS existing_member_application_id
    FROM membership_bank_payments b JOIN member_applications a ON a.id = b.application_id LEFT JOIN application_sponsors s ON s.application_id = a.id
    LEFT JOIN members m ON m.id = (SELECT existing.id FROM members existing JOIN users u ON u.id = existing.user_id
      WHERE existing.application_id = a.id OR lower(u.email) = lower(a.email) OR u.phone = a.phone
      ORDER BY existing.id LIMIT 1)
    ORDER BY b.created_ms DESC LIMIT 200`));
});

membershipTransfersRouter.post('/api/admin/membership-transfers/:reference/confirm', requireAuth('staff', 'admin'), async (req, res, params) => {
  const ref = String(req.body?.bank_reference || '').trim();
  if (req.body?.bank_credit_checked !== true || ref.length < 6 || ref.length > 120) throw new HttpError(400, 'Verify the actual bank credit and enter its transaction reference.');
  const payment = await atomic(async () => {
    const initial = await get('SELECT * FROM membership_bank_payments WHERE reference = ?', [params.reference]);
    if (!initial) throw new HttpError(404, 'Membership transfer not found');
    await run('UPDATE member_applications SET status = status WHERE id = ?', [initial.application_id]);
    await run('UPDATE membership_bank_payments SET status = status WHERE id = ?', [initial.id]);
    const row = await get('SELECT * FROM membership_bank_payments WHERE id = ?', [initial.id]);
    if (req.body.amount_kobo !== Number(row.amount_kobo)) throw new HttpError(409, 'Bank credit must match the membership fee exactly.');
    if (row.status === 'CONFIRMED') {
      if (row.bank_reference !== ref) throw new HttpError(409, 'This payment was confirmed with another bank reference.');
      return row;
    }
    if (row.status !== 'CLAIMED') throw new HttpError(409, 'The applicant has not reported payment.');
    const app = await get('SELECT * FROM member_applications WHERE id = ?', [row.application_id]);
    if (app.status !== 'PAYMENT_PENDING') throw new HttpError(409, 'Application is not awaiting this payment.');
    await allocateBankCredit(ref, 'MEMBERSHIP', row.id);
    await run("UPDATE membership_bank_payments SET status = 'CONFIRMED', bank_reference = ?, confirmed_ms = ?, confirmed_by = ? WHERE id = ?", [ref, Date.now(), req.user.id, row.id]);
    await run("UPDATE member_applications SET status = 'UNDER_REVIEW', updated_at = datetime('now') WHERE id = ?", [row.application_id]);
    await audit(req.user.id, 'MEMBERSHIP_TRANSFER_CONFIRMED', 'member_applications', row.application_id, { reference: row.reference });
    return get('SELECT * FROM membership_bank_payments WHERE id = ?', [row.id]);
  });
  res.json(200, await details(payment));
});


// Verified bank credit is retained when a known membership conflict needs review.
// Other failures still roll back. No duplicate membership or referral is created.
membershipTransfersRouter.post('/api/admin/membership-transfers/:reference/confirm-and-approve', requireAuth('staff', 'admin'), async (req, res, params) => {
  const ref = String(req.body?.bank_reference || '').trim();
  if (req.body?.bank_credit_checked !== true || ref.length < 6 || ref.length > 120) throw new HttpError(400, 'Verify the bank credit and enter its transaction reference.');
  const result = await atomic(async () => {
    const initial = await get('SELECT * FROM membership_bank_payments WHERE reference = ?', [params.reference]);
    if (!initial) throw new HttpError(404, 'Membership transfer not found');
    await run('UPDATE member_applications SET status = status WHERE id = ?', [initial.application_id]);
    await run('UPDATE membership_bank_payments SET status = status WHERE id = ?', [initial.id]);
    const payment = await get('SELECT * FROM membership_bank_payments WHERE id = ?', [initial.id]);
    const app = await get('SELECT * FROM member_applications WHERE id = ?', [payment.application_id]);
    if (!app) throw new HttpError(404, 'Application not found');
    if (req.body.amount_kobo !== Number(payment.amount_kobo)) throw new HttpError(409, 'Bank credit must match the membership fee exactly.');
    const existing = await existingMembershipForApplication(app);
    const sameMembership = existing && Number(existing.application_id) === Number(app.id);
    if (app.status === 'ACTIVE' && (!sameMembership || existing.status !== 'ACTIVE')) throw new HttpError(409, 'Application status requires manual membership reconciliation.');
    if (payment.status === 'CONFIRMED') {
      if (payment.bank_reference !== ref || !['UNDER_REVIEW', 'ACTIVE'].includes(app.status)) throw new HttpError(409, 'Payment or application requires manual reconciliation.');
    } else {
      if (payment.status !== 'CLAIMED' || !['PAYMENT_PENDING', 'ACTIVE'].includes(app.status)) throw new HttpError(409, 'Applicant must complete KYC and report payment before approval.');
      await allocateBankCredit(ref, 'MEMBERSHIP', payment.id);
      await run("UPDATE membership_bank_payments SET status = 'CONFIRMED', bank_reference = ?, confirmed_ms = ?, confirmed_by = ? WHERE id = ?", [ref, Date.now(), req.user.id, payment.id]);
      if (app.status !== 'ACTIVE') await run("UPDATE member_applications SET status = 'UNDER_REVIEW', updated_at = datetime('now') WHERE id = ?", [app.id]);
      await audit(req.user.id, 'MEMBERSHIP_TRANSFER_CONFIRMED', 'member_applications', app.id, { reference: payment.reference });
    }
    if (existing) {
      if (sameMembership && existing.status === 'ACTIVE') {
        await run("UPDATE member_applications SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?", [app.id]);
        return { application: await get('SELECT * FROM member_applications WHERE id = ?', [app.id]), member: existing, already_approved: true, payment_confirmed: true };
      }
      if (payment.status !== 'CONFIRMED') await audit(req.user.id, 'MEMBERSHIP_EXISTING_ACCOUNT_REVIEW', 'member_applications', app.id, { existing_member_id: existing.id, existing_application_id: existing.application_id });
      return { application: await get('SELECT * FROM member_applications WHERE id = ?', [app.id]), member: null,
        payment_confirmed: true, membership_review_required: true, existing_member: existing };
    }
    const member = await activateApprovedMember(app, req.user.id);
    await audit(req.user.id, 'APPLICATION_DECISION_APPROVE', 'member_applications', app.id, { via: 'confirm-and-approve' });
    return { application: await get('SELECT * FROM member_applications WHERE id = ?', [app.id]), member };
  });
  res.json(200, result);
});
