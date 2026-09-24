// routes/me.js — Member Portal Beta.
// Contribution-plan endpoints exist per the handover's API list, but they are
// COMING NEXT: creating a plan here only records member intent (status
// PROPOSED). No money moves and no ledger entries are written until Release 2
// ships real provider collection + reconciliation.

import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { parseNgnToKobo, koboToNgn } from '../utils/money.js';

export const meRouter = new Router();

async function memberForUser(userId) {
  const member = await get('SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!member) throw new HttpError(404, 'No activated membership found for this account yet');
  return member;
}

meRouter.get('/api/me', requireAuth(), async (req, res) => {
  res.json(200, { id: req.user.id, role: req.user.role });
});

meRouter.get('/api/me/membership', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const application = await get('SELECT * FROM member_applications WHERE id = ?', [member.application_id]);
  const kyc = await get('SELECT status, verified_at FROM kyc_checks WHERE application_id = ? ORDER BY id DESC LIMIT 1', [member.application_id]);
  const payment = await get(
    `SELECT status, verified_at, amount, currency
     FROM membership_payments
     WHERE application_id = ?
     ORDER BY CASE status WHEN 'PAYMENT_VERIFIED' THEN 0 ELSE 1 END,
              COALESCE(verified_at, created_at) DESC,
              id DESC
     LIMIT 1`,
    [member.application_id]
  );
  const onboarding = await get('SELECT whatsapp_joined, orientation_completed FROM community_onboarding WHERE member_id = ?', [member.id]);

  res.json(200, {
    member_code: member.member_code,
    digital_membership_id: member.member_code,
    status: member.status,
    activated_at: member.activated_at,
    full_legal_name: application.full_legal_name,
    kyc_status: kyc?.status || 'KYC_PENDING',
    membership_payment: payment || null,
    community_onboarding: onboarding || { whatsapp_joined: false, orientation_completed: false },
  });
});

meRouter.post('/api/me/contribution-plans', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const { amount, frequency, purpose, target_amount } = req.body || {};
  if (!amount || !frequency || !purpose) throw new HttpError(400, 'amount, frequency and purpose are required');

  const result = await run(
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
  const member = await memberForUser(req.user.id);
  const plans = await all('SELECT * FROM contribution_plans WHERE member_id = ? ORDER BY created_at DESC', [member.id]);
  res.json(200, plans);
});

meRouter.get('/api/me/receipts', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const rows = await all(`SELECT r.receipt_number, r.issued_at, t.type, t.amount, t.currency, t.provider_reference, t.status
                    FROM receipts r JOIN transactions t ON t.id = r.transaction_id
                    WHERE t.member_id = ? ORDER BY r.issued_at DESC`, [member.id]);
  res.json(200, rows);
});

meRouter.get('/api/me/transactions', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const txns = await all('SELECT * FROM transactions WHERE member_id = ? ORDER BY created_at DESC', [member.id]);
  res.json(200, txns);
});

async function paystack(path, options = {}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Bank verification is not configured');
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok || !data.status) throw new HttpError(502, data.message || 'Paystack request failed');
  return data.data;
}

meRouter.get('/api/me/banks', requireAuth('member'), async (req, res) => {
  const data = await paystack('/bank?country=nigeria&currency=NGN');
  res.json(200, data.filter(b => b.active !== false).map(b => ({ name: b.name, code: b.code })));
});

meRouter.post('/api/me/bank-accounts/verify', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const { account_number, bank_code, bank_name } = req.body || {};
  if (!/^\d{10}$/.test(String(account_number || ''))) throw new HttpError(400, 'Enter a valid 10-digit Nigerian account number');
  if (!bank_code || !bank_name) throw new HttpError(400, 'Select a bank');

  const resolved = await paystack(`/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`);
  const recipient = await paystack('/transferrecipient', {
    method: 'POST',
    body: JSON.stringify({ type: 'nuban', name: resolved.account_name, account_number, bank_code, currency: 'NGN' }),
  });

  await run(`INSERT INTO member_bank_accounts (member_id, bank_code, bank_name, account_number, account_name, recipient_code, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(member_id, bank_code, account_number) DO UPDATE SET
       bank_name=excluded.bank_name, account_name=excluded.account_name, recipient_code=excluded.recipient_code, verified_at=datetime('now')`,
      [member.id, bank_code, bank_name, account_number, resolved.account_name, recipient.recipient_code]);
  const row = await get('SELECT * FROM member_bank_accounts WHERE member_id = ? AND bank_code = ? AND account_number = ?', [member.id, bank_code, account_number]);
  res.json(200, { id: row.id, bank_name: row.bank_name, account_number: row.account_number, account_name: row.account_name, verified: true });
});

meRouter.get('/api/me/bank-accounts', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const rows = await all('SELECT id, bank_name, account_number, account_name, verified_at FROM member_bank_accounts WHERE member_id = ? ORDER BY verified_at DESC', [member.id]);
  res.json(200, rows.map((row) => ({
    id: row.id,
    bank_name: row.bank_name,
    account_name: row.account_name,
    verified_at: row.verified_at,
    account_number_masked: row.account_number ? '******' + String(row.account_number).slice(-4) : '',
  })));
});

meRouter.get('/api/me/withdrawals', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const rows = await all('SELECT id, amount, bank_name, account_name, account_number, status, reviewed_at, created_at FROM withdrawal_requests WHERE member_id = ? ORDER BY created_at DESC', [member.id]);
  res.json(200, rows.map((row) => ({
    ...row,
    account_number: undefined,
    account_number_masked: row.account_number ? '******' + String(row.account_number).slice(-4) : '',
  })));
});

meRouter.post('/api/me/withdrawals', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const { amount, bank_account_id } = req.body || {};
  let amountKobo;
  try { amountKobo = parseNgnToKobo(amount); }
  catch { throw new HttpError(400, 'Enter a valid withdrawal amount with no more than two decimal places'); }
  const n = koboToNgn(amountKobo);
  const minWithdrawal = Number(process.env.MIN_WITHDRAWAL_NGN || 100);
  const maxWithdrawal = Number(process.env.MAX_WITHDRAWAL_NGN || 500000);
  if (n < minWithdrawal || n > maxWithdrawal) throw new HttpError(400, `Withdrawal must be between ₦${minWithdrawal.toLocaleString()} and ₦${maxWithdrawal.toLocaleString()}`);
  const bank = await get('SELECT * FROM member_bank_accounts WHERE id = ? AND member_id = ? AND verified_at IS NOT NULL', [bank_account_id, member.id]);
  if (!bank) throw new HttpError(400, 'Select a verified bank account');
  const account = await get("SELECT * FROM ledger_accounts WHERE member_id = ? AND account_type = 'SAVINGS'", [member.id]);
  if (!account || amountKobo > Number(account.balance_kobo ?? Math.round(account.balance * 100))) throw new HttpError(409, 'Withdrawal amount exceeds available savings balance');
  const daily = await get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo FROM withdrawal_requests WHERE member_id = ? AND status IN ('APPROVED','PAID') AND created_at >= datetime('now','-24 hours')", [member.id]);
  const dailyLimitKobo = Math.round(Number(process.env.DAILY_WITHDRAWAL_LIMIT_NGN || 1000000) * 100);
  if (Number(daily.total_kobo || 0) + amountKobo > dailyLimitKobo) throw new HttpError(409, 'Daily withdrawal limit exceeded. Contact Obit support for review.');
  const pending = await get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo FROM withdrawal_requests WHERE member_id = ? AND status IN ('PENDING','APPROVED')", [member.id]);
  if (amountKobo > Number(account.balance_kobo ?? Math.round(account.balance * 100)) - Number(pending.total_kobo || 0)) throw new HttpError(409, 'Amount exceeds balance available after pending withdrawal requests');

  // Prevent accidental double-click / rapid duplicate withdrawal submissions.
  const recentDuplicate = await get(`SELECT id, status FROM withdrawal_requests
                               WHERE member_id = ? AND bank_account_id = ? AND amount_kobo = ?
                                 AND status = 'PENDING'
                                 AND created_at >= datetime('now', '-2 minutes')
                               ORDER BY id DESC LIMIT 1`, [member.id, bank.id, amountKobo]);
  if (recentDuplicate) {
    res.json(200, { id: recentDuplicate.id, amount: n, status: recentDuplicate.status, duplicate_prevented: true });
    return;
  }

  const result = await run(`INSERT INTO withdrawal_requests (member_id, ledger_account_id, amount, amount_kobo, bank_name, account_name, account_number, bank_account_id)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [member.id, account.id, n, amountKobo, bank.bank_name, bank.account_name, bank.account_number, bank.id]);
  res.json(201, { id: result.lastInsertRowid, amount: n, status: 'PENDING' });
});

meRouter.get('/api/me/statement', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  let account = await get("SELECT * FROM ledger_accounts WHERE member_id = ? AND account_type = 'SAVINGS'", [member.id]);
  if (!account) {
    await run("INSERT OR IGNORE INTO ledger_accounts (member_id, account_type, balance, balance_kobo, currency) VALUES (?, 'SAVINGS', 0, 0, 'NGN')", [member.id]);
    account = await get("SELECT * FROM ledger_accounts WHERE member_id = ? AND account_type = 'SAVINGS'", [member.id]);
  }
  res.json(200, {
    member_code: member.member_code,
    balance: Number(account?.balance_kobo ?? Math.round(Number(account?.balance || 0) * 100)) / 100,
    balance_kobo: Number(account?.balance_kobo ?? Math.round(Number(account?.balance || 0) * 100)),
    currency: account?.currency ?? 'NGN',
    sandbox_note: 'Savings collection is not enabled yet. This balance is derived only from reconciled ledger entries.',
  });
});
