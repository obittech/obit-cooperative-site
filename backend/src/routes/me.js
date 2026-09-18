// routes/me.js — Member Portal Beta.
// Contribution-plan endpoints exist per the handover's API list, but they are
// COMING NEXT: creating a plan here only records member intent (status
// PROPOSED). No money moves and no ledger entries are written until Release 2
// ships real provider collection + reconciliation.

import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const meRouter = new Router();

function memberForUser(userId) {
  const member = get('SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!member) throw new HttpError(404, 'No activated membership found for this account yet');
  return member;
}

meRouter.get('/api/me', requireAuth(), async (req, res) => {
  res.json(200, { id: req.user.id, role: req.user.role });
});

meRouter.get('/api/me/membership', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const application = get('SELECT * FROM member_applications WHERE id = ?', [member.application_id]);
  const kyc = get('SELECT status, verified_at FROM kyc_checks WHERE application_id = ? ORDER BY id DESC LIMIT 1', [member.application_id]);
  const payment = get(
    `SELECT status, verified_at, amount, currency
     FROM membership_payments
     WHERE application_id = ?
     ORDER BY CASE status WHEN 'PAYMENT_VERIFIED' THEN 0 ELSE 1 END,
              COALESCE(verified_at, created_at) DESC,
              id DESC
     LIMIT 1`,
    [member.application_id]
  );
  const onboarding = get('SELECT whatsapp_joined, orientation_completed FROM community_onboarding WHERE member_id = ?', [member.id]);

  res.json(200, {
    member_code: member.member_code,
    status: member.status,
    activated_at: member.activated_at,
    full_legal_name: application.full_legal_name,
    kyc_status: kyc?.status || 'KYC_PENDING',
    membership_payment: payment || null,
    community_onboarding: onboarding || { whatsapp_joined: false, orientation_completed: false },
  });
});

meRouter.post('/api/me/contribution-plans', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const { amount, frequency, purpose, target_amount } = req.body || {};
  if (!amount || !frequency || !purpose) throw new HttpError(400, 'amount, frequency and purpose are required');

  const result = run(
    `INSERT INTO contribution_plans (member_id, amount, frequency, purpose, target_amount, status)
     VALUES (?, ?, ?, ?, ?, 'PROPOSED')`,
    [member.id, amount, frequency, purpose, target_amount ?? null]
  );
  res.json(201, {
    id: result.lastInsertRowid,
    status: 'PROPOSED',
    sandbox_note: 'Release 2 (thrift/contributions) is not live yet — this records intent only, no payment collection is triggered.',
  });
});

meRouter.get('/api/me/contribution-plans', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const plans = all('SELECT * FROM contribution_plans WHERE member_id = ? ORDER BY created_at DESC', [member.id]);
  res.json(200, plans);
});

meRouter.get('/api/me/transactions', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const txns = all('SELECT * FROM transactions WHERE member_id = ? ORDER BY created_at DESC', [member.id]);
  res.json(200, txns);
});

meRouter.get('/api/me/statement', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const account = get('SELECT * FROM ledger_accounts WHERE member_id = ?', [member.id]);
  res.json(200, {
    member_code: member.member_code,
    balance: account?.balance ?? 0,
    currency: account?.currency ?? 'NGN',
    sandbox_note: 'Ledger balances are not populated until Release 2 contribution processing is live.',
  });
});
