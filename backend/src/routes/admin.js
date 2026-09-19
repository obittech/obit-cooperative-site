// routes/admin.js — Admin MVP (staff/admin only).
// Approving an application is the one place a `members` row (permanent
// member ID) gets created — deliberately a human decision, not automatic
// on payment webhook, per "PAYMENT_VERIFIED -> UNDER_REVIEW -> ACTIVE"
// in the handover's status flow.

import { Router, HttpError } from '../router.js';
import { get, all, run, atomic } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { generateMemberCode } from '../utils/auth.js';

export const adminRouter = new Router();

adminRouter.get('/api/admin/dashboard', requireAuth('staff', 'admin'), async (req, res) => {
  const counts = {};
  const rows = all(`SELECT status, COUNT(*) as n FROM member_applications GROUP BY status`);
  rows.forEach((r) => { counts[r.status] = r.n; });
  const activeMembers = get(`SELECT COUNT(*) as n FROM members WHERE status = 'ACTIVE'`).n;
  res.json(200, { applications_by_status: counts, active_members: activeMembers });
});

adminRouter.get('/api/admin/applications', requireAuth('staff', 'admin'), async (req, res) => {
  const applications = all(`SELECT * FROM member_applications ORDER BY updated_at DESC LIMIT 200`);
  res.json(200, applications);
});

adminRouter.post('/api/admin/applications/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const application = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (application.status !== 'UNDER_REVIEW') {
    throw new HttpError(409, `Application must be UNDER_REVIEW to decide (currently ${application.status})`);
  }

  const { decision, note } = req.body || {}; // 'APPROVE' | 'REJECT' | 'NEEDS_INFORMATION'
  if (!['APPROVE', 'REJECT', 'NEEDS_INFORMATION'].includes(decision)) {
    throw new HttpError(400, "decision must be 'APPROVE', 'REJECT' or 'NEEDS_INFORMATION'");
  }

  if (decision === 'REJECT') {
    run("UPDATE member_applications SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?", [params.id]);
  } else if (decision === 'NEEDS_INFORMATION') {
    run("UPDATE member_applications SET status = 'NEEDS_INFORMATION', updated_at = datetime('now') WHERE id = ?", [params.id]);
  } else {
    const countRow = get(`SELECT COUNT(*) as n FROM members`);
    const memberCode = generateMemberCode(countRow.n + 1);
    let user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
    if (!user) {
      run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
      user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
    }
    run('INSERT INTO members (application_id, user_id, member_code, status) VALUES (?, ?, ?, ?)',
      [params.id, user.id, memberCode, 'ACTIVE']);
    const member = get('SELECT * FROM members WHERE application_id = ?', [params.id]);
    run('INSERT INTO community_onboarding (member_id) VALUES (?)', [member.id]);
    run("INSERT INTO ledger_accounts (member_id) VALUES (?)", [member.id]);
    run("UPDATE member_applications SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?", [params.id]);
  }

  audit(req.user.id, `APPLICATION_DECISION_${decision}`, 'member_applications', params.id, { note: note ?? null });
  const updated = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  const member = get('SELECT * FROM members WHERE application_id = ?', [params.id]);
  res.json(200, { application: updated, member: member ?? null });
});

adminRouter.get('/api/admin/finance/summary', requireAuth('staff', 'admin'), async (req, res) => {
  const verified = get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo, COUNT(*) AS n FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'VERIFIED'");
  const balances = get("SELECT COALESCE(SUM(balance_kobo),0) AS total_kobo FROM ledger_accounts WHERE account_type = 'SAVINGS'");
  const pendingWithdrawals = get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo, COUNT(*) AS n FROM withdrawal_requests WHERE status = 'PENDING'");
  res.json(200, { verified_contributions: { total: Number(verified.total_kobo)/100, total_kobo: verified.total_kobo, n: verified.n }, member_savings_balances: Number(balances.total_kobo)/100, pending_withdrawals: { total: Number(pendingWithdrawals.total_kobo)/100, total_kobo: pendingWithdrawals.total_kobo, n: pendingWithdrawals.n } });
});

adminRouter.get('/api/admin/withdrawals', requireAuth('staff', 'admin'), async (req, res) => {
  const rows = all(`SELECT w.*, m.member_code, a.full_legal_name
                    FROM withdrawal_requests w
                    JOIN members m ON m.id = w.member_id
                    JOIN member_applications a ON a.id = m.application_id
                    ORDER BY w.created_at DESC LIMIT 200`);
  res.json(200, rows);
});

adminRouter.post('/api/admin/withdrawals/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const w = get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status !== 'PENDING') throw new HttpError(409, 'Only pending withdrawals can be decided');
  const { decision } = req.body || {};
  if (!['APPROVE','REJECT'].includes(decision)) throw new HttpError(400, "decision must be 'APPROVE' or 'REJECT'");
  if (decision === 'APPROVE') {
    const account = get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
    if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) < Number(w.amount_kobo ?? Math.round(w.amount * 100))) throw new HttpError(409, 'Insufficient current member balance');
    run("UPDATE withdrawal_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [req.user.id, w.id]);
  } else {
    run("UPDATE withdrawal_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [req.user.id, w.id]);
  }
  audit(req.user.id, `WITHDRAWAL_${decision}`, 'withdrawal_requests', w.id, { amount: w.amount });
  res.json(200, get('SELECT * FROM withdrawal_requests WHERE id = ?', [w.id]));
});

adminRouter.post('/api/admin/withdrawals/:id/initiate-payout', requireAuth('admin'), async (req, res, params) => {
  const w = get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status !== 'APPROVED') throw new HttpError(409, 'Withdrawal must be approved first');
  let bank = get('SELECT * FROM member_bank_accounts WHERE id = ? AND member_id = ? AND verified_at IS NOT NULL', [w.bank_account_id, w.member_id]);

  // Backfill older withdrawal requests created before bank_account_id was added.
  if (!bank) {
    bank = get(`SELECT * FROM member_bank_accounts
                WHERE member_id = ? AND account_number = ? AND verified_at IS NOT NULL
                ORDER BY verified_at DESC LIMIT 1`, [w.member_id, w.account_number]);
    if (bank) run('UPDATE withdrawal_requests SET bank_account_id = ? WHERE id = ?', [bank.id, w.id]);
  }

  if (!bank?.recipient_code) throw new HttpError(409, 'A verified Paystack transfer recipient is required');
  const account = get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
  if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) < Number(w.amount_kobo ?? Math.round(w.amount * 100))) throw new HttpError(409, 'Insufficient current savings balance');

  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Paystack transfers are not configured');
  const reference = `obit-wd-${w.id}-${Date.now()}`;
  const response = await fetch('https://api.paystack.co/transfer', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'balance', amount: Number(w.amount_kobo ?? Math.round(Number(w.amount) * 100)), recipient: bank.recipient_code, reference, reason: 'Obit Cooperative savings withdrawal', currency: 'NGN' }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.status) throw new HttpError(502, payload.message || 'Could not initiate payout');
  run('UPDATE withdrawal_requests SET transfer_reference = ?, provider_status = ? WHERE id = ?', [reference, payload.data?.status || 'pending', w.id]);
  audit(req.user.id, 'WITHDRAWAL_PAYOUT_INITIATED', 'withdrawal_requests', w.id, { reference, paystack_status: payload.data?.status });
  res.json(200, { reference, provider_status: payload.data?.status || 'pending' });
});

adminRouter.post('/api/admin/withdrawals/:id/finalize-payout', requireAuth('admin'), async (req, res, params) => {
  const w = get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status !== 'APPROVED') throw new HttpError(409, 'Withdrawal must be approved first');
  if (!w.transfer_reference) throw new HttpError(409, 'No Paystack transfer is waiting for confirmation');

  const otp = String(req.body?.otp || '').trim();
  if (!/^\d{6}$/.test(otp)) throw new HttpError(400, 'Enter the 6-digit Paystack transfer OTP');

  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Paystack transfers are not configured');
  const verifyResponse = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(w.transfer_reference)}`, { headers: { Authorization: `Bearer ${key}` } });
  const verified = await verifyResponse.json();
  const transferCode = verified.data?.transfer_code;
  if (!verifyResponse.ok || !verified.status || !transferCode) throw new HttpError(502, verified.message || 'Could not retrieve Paystack transfer code');

  const response = await fetch('https://api.paystack.co/transfer/finalize_transfer', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transfer_code: transferCode, otp }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.status) throw new HttpError(502, payload.message || 'Could not finalize payout');
  run('UPDATE withdrawal_requests SET provider_status = ? WHERE id = ?', [payload.data?.status || 'pending', w.id]);
  audit(req.user.id, 'WITHDRAWAL_PAYOUT_OTP_CONFIRMED', 'withdrawal_requests', w.id, { reference: w.transfer_reference, paystack_status: payload.data?.status });
  res.json(200, { reference: w.transfer_reference, provider_status: payload.data?.status || 'pending' });
});

adminRouter.post('/api/admin/withdrawals/:id/reconcile-payout', requireAuth('admin'), async (req, res, params) => {
  const w = get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status === 'PAID') { res.json(200, { status: 'PAID', idempotent: true }); return; }
  if (w.status !== 'APPROVED' || !w.transfer_reference) throw new HttpError(409, 'No initiated approved payout to reconcile');
  const key = process.env.PAYSTACK_SECRET_KEY;
  const response = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(w.transfer_reference)}`, { headers: { Authorization: `Bearer ${key}` } });
  const payload = await response.json();
  if (!response.ok || !payload.status) throw new HttpError(502, payload.message || 'Could not verify payout');
  if (payload.data?.status !== 'success') { run('UPDATE withdrawal_requests SET provider_status = ? WHERE id = ?', [payload.data?.status || 'unknown', w.id]); res.json(200, { status: w.status, provider_status: payload.data?.status || 'unknown' }); return; }

  const account = get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
  if (!account || Number(account.balance) < Number(w.amount)) throw new HttpError(409, 'Insufficient current savings balance');
  let receiptNo;
  atomic(() => {
    let tx = get("SELECT * FROM transactions WHERE provider_reference = ? AND type = 'WITHDRAWAL'", [w.transfer_reference]);
    if (!tx) {
      const wk = Number(w.amount_kobo ?? Math.round(w.amount * 100));
      const created = run(`INSERT INTO transactions (member_id, type, amount, amount_kobo, currency, provider_reference, status) VALUES (?, 'WITHDRAWAL', ?, ?, 'NGN', ?, 'VERIFIED')`, [w.member_id, w.amount, wk, w.transfer_reference]);
      tx = get('SELECT * FROM transactions WHERE id = ?', [Number(created.lastInsertRowid)]);
    }
    const wk = Number(w.amount_kobo ?? Math.round(w.amount * 100));
    const entry = run("INSERT OR IGNORE INTO ledger_entries (ledger_account_id, transaction_id, direction, amount, amount_kobo) VALUES (?, ?, 'debit', ?, ?)", [account.id, tx.id, w.amount, wk]);
    if (Number(entry.changes) > 0) run('UPDATE ledger_accounts SET balance = balance - ?, balance_kobo = COALESCE(balance_kobo, CAST(ROUND(balance * 100) AS INTEGER)) - ? WHERE id = ?', [w.amount, wk, account.id]);
    run("UPDATE withdrawal_requests SET status = 'PAID', provider_status = 'success', reviewed_at = datetime('now') WHERE id = ?", [w.id]);
    receiptNo = `OBW-${new Date().getUTCFullYear()}-${String(tx.id).padStart(8, '0')}`;
    run('INSERT OR IGNORE INTO receipts (transaction_id, receipt_number) VALUES (?, ?)', [tx.id, receiptNo]);
    audit(req.user.id, 'WITHDRAWAL_RECONCILED_FROM_PAYSTACK', 'withdrawal_requests', w.id, { reference: w.transfer_reference, receiptNo });
  });
  res.json(200, { status: 'PAID', provider_status: payload.data.status, receipt_number: receiptNo });
});

// Manual mark-paid is intentionally disabled in production because it can
// bypass Paystack provider confirmation. Recovery must use reconcile-payout.
adminRouter.post('/api/admin/withdrawals/:id/mark-paid', requireAuth('admin'), async (req, res) => {
  throw new HttpError(403, 'Manual mark-paid is disabled. Verify the payout with Paystack reconciliation.');
});

adminRouter.get('/api/admin/reconciliation/exceptions', requireAuth('staff', 'admin'), async (req, res) => {
  // Anything with a webhook event recorded but not marked processed, or a
  // payment stuck PENDING for a while, needs a human look.
  const stuckWebhooks = all(`SELECT * FROM webhook_events WHERE processed = 0 ORDER BY received_at DESC`);
  const stuckPayments = all(
    `SELECT * FROM membership_payments WHERE status = 'PAYMENT_PENDING' AND created_at < datetime('now', '-1 day')`
  );
  const staleContributions = all("SELECT * FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'PENDING' AND created_at < datetime('now', '-1 hour')");
  const balanceMismatch = get(`SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_kobo ELSE -amount_kobo END),0) AS ledger_total
                               FROM ledger_entries`);
  const storedBalance = get("SELECT COALESCE(SUM(balance_kobo),0) AS total FROM ledger_accounts").total;
  res.json(200, { stuck_webhooks: stuckWebhooks, stale_pending_payments: stuckPayments, stale_pending_contributions: staleContributions,
                  ledger_total: balanceMismatch.ledger_total, stored_balance_total: storedBalance,
                  ledger_balance_matches: Number(balanceMismatch.ledger_total) === Number(storedBalance) });
});

adminRouter.get('/api/admin/audit', requireAuth('staff', 'admin'), async (req, res) => {
  const events = all(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200`);
  res.json(200, events);
});
