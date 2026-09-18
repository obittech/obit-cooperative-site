// routes/admin.js — Admin MVP (staff/admin only).
// Approving an application is the one place a `members` row (permanent
// member ID) gets created — deliberately a human decision, not automatic
// on payment webhook, per "PAYMENT_VERIFIED -> UNDER_REVIEW -> ACTIVE"
// in the handover's status flow.

import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
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
  const verified = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'VERIFIED'");
  const balances = get("SELECT COALESCE(SUM(balance),0) AS total FROM ledger_accounts WHERE account_type = 'SAVINGS'");
  const pendingWithdrawals = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM withdrawal_requests WHERE status = 'PENDING'");
  res.json(200, { verified_contributions: verified, member_savings_balances: balances.total, pending_withdrawals: pendingWithdrawals });
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
    if (!account || Number(account.balance) < Number(w.amount)) throw new HttpError(409, 'Insufficient current member balance');
    run("UPDATE withdrawal_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [req.user.id, w.id]);
  } else {
    run("UPDATE withdrawal_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [req.user.id, w.id]);
  }
  audit(req.user.id, `WITHDRAWAL_${decision}`, 'withdrawal_requests', w.id, { amount: w.amount });
  res.json(200, get('SELECT * FROM withdrawal_requests WHERE id = ?', [w.id]));
});

adminRouter.post('/api/admin/withdrawals/:id/mark-paid', requireAuth('admin'), async (req, res, params) => {
  const w = get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status !== 'APPROVED') throw new HttpError(409, 'Withdrawal must be APPROVED before it can be marked paid');

  const account = get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
  if (!account || Number(account.balance) < Number(w.amount)) throw new HttpError(409, 'Insufficient current savings balance');

  const providerReference = (req.body?.provider_reference || '').trim();
  if (!providerReference) throw new HttpError(400, 'Payout reference is required before marking a withdrawal paid');

  const existing = get("SELECT * FROM transactions WHERE provider_reference = ?", [providerReference]);
  if (existing) throw new HttpError(409, 'Payout reference has already been used');

  const tx = run(`INSERT INTO transactions (member_id, type, amount, currency, provider_reference, status)
                  VALUES (?, 'WITHDRAWAL', ?, 'NGN', ?, 'VERIFIED')`,
                 [w.member_id, w.amount, providerReference]);
  const txId = Number(tx.lastInsertRowid);
  const entry = run("INSERT OR IGNORE INTO ledger_entries (ledger_account_id, transaction_id, direction, amount) VALUES (?, ?, 'debit', ?)",
                    [account.id, txId, w.amount]);
  if (Number(entry.changes) !== 1) throw new HttpError(409, 'Withdrawal ledger entry already exists');

  run('UPDATE ledger_accounts SET balance = balance - ? WHERE id = ?', [w.amount, account.id]);
  run("UPDATE withdrawal_requests SET status = 'PAID', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?", [req.user.id, w.id]);
  const receiptNo = `OBW-${new Date().getUTCFullYear()}-${String(txId).padStart(8, '0')}`;
  run('INSERT OR IGNORE INTO receipts (transaction_id, receipt_number) VALUES (?, ?)', [txId, receiptNo]);
  audit(req.user.id, 'WITHDRAWAL_PAID', 'withdrawal_requests', w.id, { amount: w.amount, provider_reference: providerReference, receipt_number: receiptNo });

  res.json(200, { withdrawal: get('SELECT * FROM withdrawal_requests WHERE id = ?', [w.id]), receipt_number: receiptNo });
});

adminRouter.get('/api/admin/reconciliation/exceptions', requireAuth('staff', 'admin'), async (req, res) => {
  // Anything with a webhook event recorded but not marked processed, or a
  // payment stuck PENDING for a while, needs a human look.
  const stuckWebhooks = all(`SELECT * FROM webhook_events WHERE processed = 0 ORDER BY received_at DESC`);
  const stuckPayments = all(
    `SELECT * FROM membership_payments WHERE status = 'PAYMENT_PENDING' AND created_at < datetime('now', '-1 day')`
  );
  const staleContributions = all("SELECT * FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'PENDING' AND created_at < datetime('now', '-1 hour')");
  const balanceMismatch = get(`SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount ELSE -amount END),0) AS ledger_total
                               FROM ledger_entries`);
  const storedBalance = get("SELECT COALESCE(SUM(balance),0) AS total FROM ledger_accounts").total;
  res.json(200, { stuck_webhooks: stuckWebhooks, stale_pending_payments: stuckPayments, stale_pending_contributions: staleContributions,
                  ledger_total: balanceMismatch.ledger_total, stored_balance_total: storedBalance,
                  ledger_balance_matches: Number(balanceMismatch.ledger_total) === Number(storedBalance) });
});

adminRouter.get('/api/admin/audit', requireAuth('staff', 'admin'), async (req, res) => {
  const events = all(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200`);
  res.json(200, events);
});
