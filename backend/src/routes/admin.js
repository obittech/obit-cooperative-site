// routes/admin.js — Admin MVP (staff/admin only).
// Approving an application is the one place a `members` row (permanent
// member ID) gets created — deliberately a human decision, not automatic
// on payment webhook, per "PAYMENT_VERIFIED -> UNDER_REVIEW -> ACTIVE"
// in the handover's status flow.

import { randomUUID } from 'node:crypto';
import { Router, HttpError } from '../router.js';
import { get, all, run, atomic } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { activateApprovedMember } from '../services/membership-approval.js';


export const adminRouter = new Router();

adminRouter.get('/api/admin/referral-bonuses', requireAuth('staff', 'admin'), async (req, res) => {
  const rows = await all(`SELECT b.*, s.member_code AS sponsor_code, s.full_legal_name AS sponsor_name,
    s.phone AS sponsor_phone, a.full_legal_name AS new_member_name
    FROM referral_bonuses b JOIN application_sponsors s ON s.application_id = b.application_id
    JOIN member_applications a ON a.id = b.application_id ORDER BY b.earned_ms DESC LIMIT 200`);
  res.json(200, rows);
});

adminRouter.post('/api/admin/referral-bonuses/:id/paid', requireAuth('staff', 'admin'), async (req, res, params) => {
  const ref = String(req.body?.payout_reference || '').trim();
  if (req.body?.payout_completed !== true || req.body?.amount_kobo !== 50000 || ref.length < 6 || ref.length > 120) {
    throw new HttpError(422, 'Confirm the completed ₦500 payout and enter its bank transaction reference.');
  }
  const bonus = await atomic(async () => {
    await run('UPDATE referral_bonuses SET status = status WHERE id = ?', [params.id]);
    const row = await get('SELECT * FROM referral_bonuses WHERE id = ?', [params.id]);
    if (!row) throw new HttpError(404, 'Referral bonus not found');
    if (row.status === 'PAID') {
      if (row.payout_reference !== ref) throw new HttpError(409, 'This bonus was already paid with another reference.');
      return row;
    }
    if (await get('SELECT id FROM referral_bonuses WHERE payout_reference = ?', [ref])) throw new HttpError(409, 'This payout reference has already been used.');
    await run("UPDATE referral_bonuses SET status = 'PAID', paid_ms = ?, paid_by = ?, payout_reference = ? WHERE id = ?", [Date.now(), req.user.id, ref, row.id]);
    await audit(req.user.id, 'REFERRAL_BONUS_PAID', 'referral_bonuses', row.id, { amount_kobo: 50000 });
    return get('SELECT * FROM referral_bonuses WHERE id = ?', [row.id]);
  });
  res.json(200, bonus);
});

adminRouter.get('/api/admin/dashboard', requireAuth('staff', 'admin'), async (req, res) => {
  const counts = {};
  const rows = await all(`SELECT status, COUNT(*) as n FROM member_applications GROUP BY status`);
  rows.forEach((r) => { counts[r.status] = r.n; });
  const activeMembers = (await get(`SELECT COUNT(*) as n FROM members WHERE status = 'ACTIVE'`)).n;
  res.json(200, { applications_by_status: counts, active_members: activeMembers });
});

adminRouter.get('/api/admin/applications', requireAuth('staff', 'admin'), async (req, res) => {
  const applications = await all(`SELECT * FROM member_applications ORDER BY updated_at DESC LIMIT 200`);
  res.json(200, applications);
});

adminRouter.post('/api/admin/applications/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const result = await atomic(async () => {
    await run('UPDATE member_applications SET status = status WHERE id = ?', [params.id]);
    const application = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
    if (!application) throw new HttpError(404, 'Application not found');
    if (application.status !== 'UNDER_REVIEW') {
      throw new HttpError(409, `Application must be UNDER_REVIEW to decide (currently ${application.status})`);
    }

    const { decision, note } = req.body || {}; // 'APPROVE' | 'REJECT' | 'NEEDS_INFORMATION'
    if (!['APPROVE', 'REJECT', 'NEEDS_INFORMATION'].includes(decision)) {
      throw new HttpError(400, "decision must be 'APPROVE', 'REJECT' or 'NEEDS_INFORMATION'");
    }

    if (decision === 'REJECT') {
      await run("UPDATE member_applications SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?", [params.id]);
    } else if (decision === 'NEEDS_INFORMATION') {
      await run("UPDATE member_applications SET status = 'NEEDS_INFORMATION', updated_at = datetime('now') WHERE id = ?", [params.id]);
    } else {
      await activateApprovedMember(application, req.user.id);
    }

    await audit(req.user.id, `APPLICATION_DECISION_${decision}`, 'member_applications', params.id, { note: note ?? null });
    const updated = await get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
    const member = await get('SELECT * FROM members WHERE application_id = ?', [params.id]);
    return { application: updated, member: member ?? null };
  });
  res.json(200, result);
});

adminRouter.get('/api/admin/finance/summary', requireAuth('staff', 'admin'), async (req, res) => {
  const verified = await get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo, COUNT(*) AS n FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'VERIFIED'");
  const balances = await get("SELECT COALESCE(SUM(balance_kobo),0) AS total_kobo FROM ledger_accounts WHERE account_type = 'SAVINGS'");
  const pendingWithdrawals = await get("SELECT COALESCE(SUM(amount_kobo),0) AS total_kobo, COUNT(*) AS n FROM withdrawal_requests WHERE status = 'PENDING'");
  res.json(200, { verified_contributions: { total: Number(verified.total_kobo)/100, total_kobo: verified.total_kobo, n: verified.n }, member_savings_balances: Number(balances.total_kobo)/100, pending_withdrawals: { total: Number(pendingWithdrawals.total_kobo)/100, total_kobo: pendingWithdrawals.total_kobo, n: pendingWithdrawals.n } });
});

adminRouter.get('/api/admin/withdrawals', requireAuth('staff', 'admin'), async (req, res) => {
  const rows = await all(`SELECT w.*, m.member_code, a.full_legal_name
                    FROM withdrawal_requests w
                    JOIN members m ON m.id = w.member_id
                    JOIN member_applications a ON a.id = m.application_id
                    ORDER BY w.created_at DESC LIMIT 200`);
  res.json(200, rows);
});

adminRouter.post('/api/admin/withdrawals/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const w = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status !== 'PENDING') throw new HttpError(409, 'Only pending withdrawals can be decided');
  const { decision } = req.body || {};
  if (!['APPROVE','REJECT'].includes(decision)) throw new HttpError(400, "decision must be 'APPROVE' or 'REJECT'");
  if (decision === 'APPROVE') {
    const account = await get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
    if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) < Number(w.amount_kobo ?? Math.round(w.amount * 100))) throw new HttpError(409, 'Insufficient current member balance');
    const changed = await run("UPDATE withdrawal_requests SET status = 'APPROVED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'PENDING' AND transfer_reference IS NULL", [req.user.id, w.id]);
    if (!Number(changed.changes)) throw new HttpError(409, 'Withdrawal already decided');
  } else {
    const changed = await run("UPDATE withdrawal_requests SET status = 'REJECTED', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'PENDING' AND transfer_reference IS NULL", [req.user.id, w.id]);
    if (!Number(changed.changes)) throw new HttpError(409, 'Withdrawal already decided');
  }
  await audit(req.user.id, `WITHDRAWAL_${decision}`, 'withdrawal_requests', w.id, { amount: w.amount });
  res.json(200, await get('SELECT * FROM withdrawal_requests WHERE id = ?', [w.id]));
});

adminRouter.post('/api/admin/withdrawals/:id/initiate-payout', requireAuth('admin'), async (req, res, params) => {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Paystack transfers are not configured');
  // Commit the durable claim BEFORE contacting Paystack. An uncertain outcome
  // must never clear or replace its reference, including after a process crash.
  const claim = await atomic(async () => {
    await run('UPDATE withdrawal_requests SET status = status WHERE id = ?', [params.id]);
    const w = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
    if (!w) throw new HttpError(404, 'Withdrawal request not found');
    if (w.transfer_reference) return { existing: true, w };
    if (w.status !== 'APPROVED') throw new HttpError(409, 'Withdrawal must be approved first');
    let bank = await get('SELECT * FROM member_bank_accounts WHERE id = ? AND member_id = ? AND verified_at IS NOT NULL', [w.bank_account_id, w.member_id]);
    if (!bank) {
      bank = await get(`SELECT * FROM member_bank_accounts
        WHERE member_id = ? AND account_number = ? AND verified_at IS NOT NULL
        ORDER BY verified_at DESC LIMIT 1`, [w.member_id, w.account_number]);
    }
    if (!bank?.recipient_code) throw new HttpError(409, 'A verified Paystack transfer recipient is required');
    // Serialize claims for this account, including different withdrawal requests.
    await run('UPDATE ledger_accounts SET balance = balance WHERE id = ?', [w.ledger_account_id]);
    const account = await get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
    const amount = Number(w.amount_kobo ?? Math.round(Number(w.amount) * 100));
    const reserved = await get(`SELECT COALESCE(SUM(COALESCE(amount_kobo, CAST(ROUND(amount * 100) AS INTEGER))), 0) AS total
      FROM withdrawal_requests WHERE ledger_account_id = ? AND status = 'APPROVED' AND transfer_reference IS NOT NULL`, [w.ledger_account_id]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new HttpError(409, 'Invalid withdrawal amount');
    if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) - Number(reserved.total) < amount) throw new HttpError(409, 'Insufficient unreserved savings balance');
    const reference = `obit-wd-${w.id}-${randomUUID()}`;
    await run("UPDATE withdrawal_requests SET transfer_reference = ?, provider_status = 'initiating', bank_account_id = ? WHERE id = ?", [reference, bank.id, w.id]);
    await audit(req.user.id, 'WITHDRAWAL_PAYOUT_CLAIMED', 'withdrawal_requests', w.id, { reference });
    return { w, reference, amount, recipient: bank.recipient_code };
  });
  if (claim.existing) {
    res.json(200, { reference: claim.w.transfer_reference, provider_status: claim.w.provider_status, idempotent: true });
    return;
  }
  const { w, reference, amount, recipient } = claim;
  let payload;
  try {
    const response = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ source: 'balance', amount, recipient, reference, reason: 'Obit Cooperative savings withdrawal', currency: 'NGN' }),
    });
    payload = await response.json();
    if (!response.ok || !payload.status) throw new Error('Provider did not confirm transfer');
  } catch {
    await run("UPDATE withdrawal_requests SET provider_status = 'unknown' WHERE id = ? AND provider_status = 'initiating'", [w.id]);
    throw new HttpError(502, 'Payout outcome is uncertain. Reconcile this reference before any further action; do not initiate a replacement payout.');
  }
  // Do not overwrite a newer state observed by concurrent reconciliation.
  await run("UPDATE withdrawal_requests SET provider_status = ? WHERE id = ? AND provider_status = 'initiating'", [payload.data?.status || 'pending', w.id]);
  await audit(req.user.id, 'WITHDRAWAL_PAYOUT_INITIATED', 'withdrawal_requests', w.id, { reference, paystack_status: payload.data?.status });
  res.json(200, { reference, provider_status: (await get('SELECT provider_status FROM withdrawal_requests WHERE id = ?', [w.id])).provider_status });
});

adminRouter.post('/api/admin/withdrawals/:id/finalize-payout', requireAuth('admin'), async (req, res, params) => {
  const w = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
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
  await run("UPDATE withdrawal_requests SET provider_status = ? WHERE id = ? AND status = 'APPROVED' AND transfer_reference = ?", [payload.data?.status || 'pending', w.id, w.transfer_reference]);
  await audit(req.user.id, 'WITHDRAWAL_PAYOUT_OTP_CONFIRMED', 'withdrawal_requests', w.id, { reference: w.transfer_reference, paystack_status: payload.data?.status });
  res.json(200, { reference: w.transfer_reference, provider_status: payload.data?.status || 'pending' });
});

adminRouter.post('/api/admin/withdrawals/:id/reconcile-payout', requireAuth('admin'), async (req, res, params) => {
  const w = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [params.id]);
  if (!w) throw new HttpError(404, 'Withdrawal request not found');
  if (w.status === 'PAID') { res.json(200, { status: 'PAID', idempotent: true }); return; }
  if (w.status !== 'APPROVED' || !w.transfer_reference) throw new HttpError(409, 'No initiated approved payout to reconcile');
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503, 'Paystack transfers are not configured');
  const response = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(w.transfer_reference)}`, { headers: { Authorization: `Bearer ${key}` } });
  const payload = await response.json();
  if (!response.ok || !payload.status) throw new HttpError(502, payload.message || 'Could not verify payout');
  if (payload.data?.reference !== w.transfer_reference || payload.data?.currency !== 'NGN' || Number(payload.data?.amount) !== Number(w.amount_kobo ?? Math.round(w.amount * 100))) throw new HttpError(409, 'Provider transfer does not match this withdrawal');
  if (payload.data?.status !== 'success') {
    await run("UPDATE withdrawal_requests SET provider_status = ? WHERE id = ? AND status = 'APPROVED' AND transfer_reference = ?", [payload.data?.status || 'unknown', w.id, w.transfer_reference]);
    const current = await get('SELECT status, provider_status FROM withdrawal_requests WHERE id = ?', [w.id]);
    res.json(200, { ...current, ...(current.status === 'PAID' ? { idempotent: true } : {}) });
    return;
  }

  let receiptNo;
  await atomic(async () => {
    await run('UPDATE withdrawal_requests SET status = status WHERE id = ?', [w.id]);
    const current = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [w.id]);
    if (current.status === 'PAID') return;
    if (current.status !== 'APPROVED' || current.transfer_reference !== w.transfer_reference) throw new HttpError(409, 'Withdrawal changed during reconciliation');
    await run('UPDATE ledger_accounts SET balance = balance WHERE id = ?', [w.ledger_account_id]);
    const account = await get('SELECT * FROM ledger_accounts WHERE id = ?', [w.ledger_account_id]);
    if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) < Number(w.amount_kobo ?? Math.round(w.amount * 100))) throw new HttpError(409, 'Insufficient current savings balance');
    let tx = await get("SELECT * FROM transactions WHERE provider_reference = ? AND type = 'WITHDRAWAL'", [w.transfer_reference]);
    if (!tx) {
      const wk = Number(w.amount_kobo ?? Math.round(w.amount * 100));
      const created = await run(`INSERT INTO transactions (member_id, type, amount, amount_kobo, currency, provider_reference, status) VALUES (?, 'WITHDRAWAL', ?, ?, 'NGN', ?, 'VERIFIED')`, [w.member_id, w.amount, wk, w.transfer_reference]);
      tx = await get('SELECT * FROM transactions WHERE id = ?', [Number(created.lastInsertRowid)]);
    }
    const wk = Number(w.amount_kobo ?? Math.round(w.amount * 100));
    const entry = await run("INSERT OR IGNORE INTO ledger_entries (ledger_account_id, transaction_id, direction, amount, amount_kobo) VALUES (?, ?, 'debit', ?, ?)", [account.id, tx.id, w.amount, wk]);
    if (Number(entry.changes) > 0) await run('UPDATE ledger_accounts SET balance = balance - ?, balance_kobo = COALESCE(balance_kobo, CAST(ROUND(balance * 100) AS INTEGER)) - ? WHERE id = ?', [w.amount, wk, account.id]);
    await run("UPDATE withdrawal_requests SET status = 'PAID', provider_status = 'success', reviewed_at = datetime('now') WHERE id = ?", [w.id]);
    receiptNo = `OBW-${new Date().getUTCFullYear()}-${String(tx.id).padStart(8, '0')}`;
    await run('INSERT OR IGNORE INTO receipts (transaction_id, receipt_number) VALUES (?, ?)', [tx.id, receiptNo]);
    await audit(req.user.id, 'WITHDRAWAL_RECONCILED_FROM_PAYSTACK', 'withdrawal_requests', w.id, { reference: w.transfer_reference, receiptNo });
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
  const stuckWebhooks = await all(`SELECT * FROM webhook_events WHERE processed = 0 ORDER BY received_at DESC`);
  const stuckPayments = await all(
    `SELECT * FROM membership_payments WHERE status = 'PAYMENT_PENDING' AND created_at < datetime('now', '-1 day')`
  );
  const staleContributions = await all("SELECT * FROM transactions WHERE type = 'CONTRIBUTION' AND status = 'PENDING' AND created_at < datetime('now', '-1 hour')");
  const balanceMismatch = await get(`SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_kobo ELSE -amount_kobo END),0) AS ledger_total
                               FROM ledger_entries`);
  const storedBalance = (await get("SELECT COALESCE(SUM(balance_kobo),0) AS total FROM ledger_accounts")).total;
  const missingKobo = {
    transactions: (await get("SELECT COUNT(*) AS n FROM transactions WHERE amount IS NOT NULL AND amount_kobo IS NULL")).n,
    ledger_entries: (await get("SELECT COUNT(*) AS n FROM ledger_entries WHERE amount IS NOT NULL AND amount_kobo IS NULL")).n,
    ledger_accounts: (await get("SELECT COUNT(*) AS n FROM ledger_accounts WHERE balance_kobo IS NULL")).n,
    withdrawals: (await get("SELECT COUNT(*) AS n FROM withdrawal_requests WHERE amount IS NOT NULL AND amount_kobo IS NULL")).n,
  };
  const negativeBalances = (await get("SELECT COUNT(*) AS n FROM ledger_accounts WHERE COALESCE(balance_kobo,0) < 0")).n;
  const paidWithoutDebit = await get(`SELECT COUNT(*) AS n FROM withdrawal_requests w
    WHERE w.status = 'PAID' AND NOT EXISTS (
      SELECT 1 FROM transactions t JOIN ledger_entries le ON le.transaction_id=t.id
      WHERE t.member_id=w.member_id AND t.type='WITHDRAWAL' AND t.provider_reference=w.transfer_reference
        AND le.ledger_account_id=w.ledger_account_id AND le.direction='debit'
    )`).n;
  const integrityOk = Number(balanceMismatch.ledger_total) === Number(storedBalance)
    && Object.values(missingKobo).every(Number.isFinite) && Object.values(missingKobo).every(n => Number(n) === 0)
    && Number(negativeBalances) === 0 && Number(paidWithoutDebit) === 0;
  res.json(200, { stuck_webhooks: stuckWebhooks, stale_pending_payments: stuckPayments, stale_pending_contributions: staleContributions,
                  ledger_total: balanceMismatch.ledger_total, stored_balance_total: storedBalance,
                  ledger_balance_matches: Number(balanceMismatch.ledger_total) === Number(storedBalance),
                  missing_kobo_fields: missingKobo, negative_balances: negativeBalances,
                  paid_withdrawals_without_debit: paidWithoutDebit, financial_integrity_ok: integrityOk });
});

adminRouter.get('/api/admin/audit', requireAuth('staff', 'admin'), async (req, res) => {
  const events = await all(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200`);
  res.json(200, events);
});
