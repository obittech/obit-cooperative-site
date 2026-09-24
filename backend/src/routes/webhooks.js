// routes/webhooks.js
// This is the ONLY place a membership payment is ever marked verified.
// - Signature is checked against the raw request body (not the parsed JSON).
// - webhook_events has a UNIQUE(provider, event_id) constraint, so a replayed
//   or duplicated delivery is a no-op the second time (idempotency).
// - Amount/currency/reference are re-checked against our own PAYMENT_PENDING
//   row — we never trust the payload's amount blindly.

import { Router, HttpError, readRawBody } from '../router.js';
import { get, run, atomic } from '../db.js';
import { audit } from '../utils/audit.js';
import { generateMemberCode } from '../utils/auth.js';
import crypto from 'node:crypto';

export const webhooksRouter = new Router();

function verifyHmacSha512(rawBody, signatureHeader, secret) {
  if (!secret || typeof signatureHeader !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signatureHeader)) {
    return false;
  }
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function verifyPaystackSignature(rawBody, signatureHeader) {
  return verifyHmacSha512(rawBody, signatureHeader, process.env.PAYSTACK_SECRET_KEY);
}

function verifyMonnifySignature(rawBody, signatureHeader) {
  return verifyHmacSha512(rawBody, signatureHeader, process.env.MONNIFY_SECRET_KEY);
}

// Handler is registered manually in server.js (needs the raw body, so it
// bypasses the standard JSON-body-parsing middleware).
export async function handlePaymentWebhook(req, res, params) {
  const provider = params.provider;
  if (!['paystack', 'monnify'].includes(provider)) throw new HttpError(404, 'Unknown provider');

  const raw = await readRawBody(req);

  const sandboxMode = process.env.WEBHOOK_SANDBOX_MODE === 'true';
  let verified;
  if (sandboxMode) {
    // Local testing only — see scripts/simulate-webhook.js. Never enable in production.
    const localSecret = process.env.WEBHOOK_SANDBOX_SECRET;
    const header = req.headers['x-sandbox-signature'];
    verified = !!localSecret && header === crypto.createHmac('sha256', localSecret).update(raw).digest('hex');
  } else if (provider === 'paystack') {
    verified = verifyPaystackSignature(raw, req.headers['x-paystack-signature']);
  } else {
    verified = verifyMonnifySignature(raw, req.headers['monnify-signature']);
  }

  if (!verified) {
    await audit(null, 'WEBHOOK_SIGNATURE_REJECTED', 'webhook_events', null, { provider });
    throw new HttpError(401, 'Signature verification failed');
  }

  let event;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }

  const eventId = event.id || event.data?.id || event.reference || event.data?.reference || crypto.randomUUID();
  const alreadyProcessed = await get('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
  if (alreadyProcessed) {
    res.json(200, { ok: true, idempotent_replay: true });
    return;
  }
  await run(
    `INSERT INTO webhook_events (provider, event_id, payload_json, processed) VALUES (?, ?, ?, 0)`,
    [provider, String(eventId), raw]
  );

  const reference = event.data?.reference || event.reference;
  const amountKobo = event.data?.amount ?? event.amount;
  const currency = event.data?.currency || event.currency || 'NGN';
  const status = event.data?.status || event.status;

  // Transfer events use the same signed Paystack webhook endpoint but are not membership payments.
  if (provider === 'paystack' && ['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)) {
    const withdrawal = await get('SELECT * FROM withdrawal_requests WHERE transfer_reference = ?', [reference]);
    if (!withdrawal) {
      await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
      await audit(null, 'TRANSFER_UNKNOWN_REFERENCE', 'webhook_events', null, { reference, event: event.event });
      res.json(200, { ok: true });
      return;
    }

    if (event.event === 'transfer.success' && withdrawal.status === 'APPROVED') {
      const account = await get('SELECT * FROM ledger_accounts WHERE id = ?', [withdrawal.ledger_account_id]);
      if (!account || Number(account.balance_kobo ?? Math.round(account.balance * 100)) < Number(withdrawal.amount_kobo ?? Math.round(withdrawal.amount * 100))) throw new HttpError(409, 'Insufficient current savings balance');

      await atomic(async () => {
        let tx = await get("SELECT * FROM transactions WHERE provider_reference = ? AND type = 'WITHDRAWAL'", [reference]);
        if (!tx) {
          const withdrawalKobo = Number(withdrawal.amount_kobo ?? Math.round(withdrawal.amount * 100));
          const created = await run(`INSERT INTO transactions (member_id, type, amount, amount_kobo, currency, provider_reference, status)
                               VALUES (?, 'WITHDRAWAL', ?, ?, 'NGN', ?, 'VERIFIED')`,
                              [withdrawal.member_id, withdrawal.amount, withdrawalKobo, reference]);
          tx = await get('SELECT * FROM transactions WHERE id = ?', [Number(created.lastInsertRowid)]);
        }
        const withdrawalKobo = Number(withdrawal.amount_kobo ?? Math.round(withdrawal.amount * 100));
        const entry = await run("INSERT OR IGNORE INTO ledger_entries (ledger_account_id, transaction_id, direction, amount, amount_kobo) VALUES (?, ?, 'debit', ?, ?)",
                          [account.id, tx.id, withdrawal.amount, withdrawalKobo]);
        if (Number(entry.changes) > 0) await run('UPDATE ledger_accounts SET balance = balance - ?, balance_kobo = COALESCE(balance_kobo, CAST(ROUND(balance * 100) AS INTEGER)) - ? WHERE id = ?', [withdrawal.amount, withdrawalKobo, account.id]);
        await run("UPDATE withdrawal_requests SET status = 'PAID', reviewed_at = datetime('now') WHERE id = ?", [withdrawal.id]);
        const receiptNo = `OBW-${new Date().getUTCFullYear()}-${String(tx.id).padStart(8, '0')}`;
        await run('INSERT OR IGNORE INTO receipts (transaction_id, receipt_number) VALUES (?, ?)', [tx.id, receiptNo]);
        await audit(null, 'WITHDRAWAL_TRANSFER_CONFIRMED', 'withdrawal_requests', withdrawal.id, { reference, receiptNo });
      });
    } else if (event.event !== 'transfer.success') {
      await audit(null, event.event === 'transfer.reversed' ? 'WITHDRAWAL_TRANSFER_REVERSED' : 'WITHDRAWAL_TRANSFER_FAILED', 'withdrawal_requests', withdrawal.id, { reference });
    }

    await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    res.json(200, { ok: true });
    return;
  }

  const payment = await get('SELECT * FROM membership_payments WHERE reference = ?', [reference]);
  const contribution = !payment ? await get("SELECT * FROM transactions WHERE provider_reference = ? AND type = 'CONTRIBUTION'", [reference]) : null;
  if (!payment && !contribution) {
    await audit(null, 'WEBHOOK_UNKNOWN_REFERENCE', 'webhook_events', null, { provider, reference });
    throw new HttpError(404, 'Unknown payment reference');
  }

  if (contribution) {
    if (contribution.status === 'VERIFIED') {
      await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
      res.json(200, { ok: true, idempotent_replay: true });
      return;
    }

    const expectedContributionKobo = Number(contribution.amount_kobo ?? Math.round(contribution.amount * 100));
    const contributionAmountMatches = amountKobo === undefined || Number(amountKobo) === expectedContributionKobo;
    const contributionCurrencyMatches = currency === contribution.currency;
    const contributionSuccess = ['success', 'PAID', 'successful'].includes(status);

    if (!contributionAmountMatches || !contributionCurrencyMatches || !contributionSuccess) {
      await run("UPDATE transactions SET status = 'FAILED' WHERE id = ?", [contribution.id]);
      await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
      await audit(null, 'CONTRIBUTION_FAILED', 'transactions', contribution.id, { reference, status, amountKobo });
      if (!contributionAmountMatches || !contributionCurrencyMatches) throw new HttpError(422, 'Amount or currency mismatch');
      res.json(200, { ok: true });
      return;
    }

    await run("INSERT OR IGNORE INTO ledger_accounts (member_id, account_type, balance, balance_kobo, currency) VALUES (?, 'SAVINGS', 0, 0, 'NGN')", [contribution.member_id]);
    const account = await get("SELECT * FROM ledger_accounts WHERE member_id = ? AND account_type = 'SAVINGS'", [contribution.member_id]);
    await run("UPDATE transactions SET status = 'VERIFIED' WHERE id = ?", [contribution.id]);
    const contributionKobo = Number(contribution.amount_kobo ?? Math.round(contribution.amount * 100));
    const entry = await run("INSERT OR IGNORE INTO ledger_entries (ledger_account_id, transaction_id, direction, amount, amount_kobo) VALUES (?, ?, 'credit', ?, ?)", [account.id, contribution.id, contribution.amount, contributionKobo]);
    if (Number(entry.changes) > 0) {
      await run("UPDATE ledger_accounts SET balance = balance + ?, balance_kobo = COALESCE(balance_kobo, CAST(ROUND(balance * 100) AS INTEGER)) + ? WHERE id = ?", [contribution.amount, contributionKobo, account.id]);
    }
    const receiptNo = `OBR-${new Date().getUTCFullYear()}-${String(contribution.id).padStart(8, '0')}`;
    await run("INSERT OR IGNORE INTO receipts (transaction_id, receipt_number) VALUES (?, ?)", [contribution.id, receiptNo]);
    await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    await audit(null, 'CONTRIBUTION_VERIFIED', 'transactions', contribution.id, { reference, receiptNo });
    res.json(200, { ok: true });
    return;
  }

  // A reference that is already PAYMENT_VERIFIED must never be reprocessed,
  // even if the provider sends a fresh event id for what is logically the
  // same payment (e.g. a retried webhook with a new delivery id). Prevents
  // an application from bouncing back to UNDER_REVIEW after admin has
  // already acted on it.
  if (payment.status === 'PAYMENT_VERIFIED') {
    await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    res.json(200, { ok: true, idempotent_replay: true });
    return;
  }

  const expectedAmountKobo = Number(payment.amount_kobo ?? Math.round(payment.amount * 100));
  const amountMatches = amountKobo === undefined || Number(amountKobo) === expectedAmountKobo;
  const currencyMatches = currency === payment.currency;
  const success = ['success', 'PAID', 'successful'].includes(status);

  if (!amountMatches || !currencyMatches) {
    await run("UPDATE membership_payments SET status = 'PAYMENT_FAILED' WHERE id = ?", [payment.id]);
    await run("UPDATE member_applications SET status = 'PAYMENT_FAILED', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    await audit(null, 'PAYMENT_AMOUNT_MISMATCH', 'membership_payments', payment.id, { amountKobo, expectedAmountKobo, currency });
    throw new HttpError(422, 'Amount or currency mismatch');
  }

  if (success) {
    await run("UPDATE membership_payments SET status = 'PAYMENT_VERIFIED', verified_at = datetime('now') WHERE id = ?", [payment.id]);
    await run("UPDATE member_applications SET status = 'UNDER_REVIEW', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    await audit(null, 'PAYMENT_VERIFIED', 'membership_payments', payment.id, { reference });
  } else {
    await run("UPDATE membership_payments SET status = 'PAYMENT_FAILED' WHERE id = ?", [payment.id]);
    await run("UPDATE member_applications SET status = 'PAYMENT_FAILED', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    await audit(null, 'PAYMENT_FAILED', 'membership_payments', payment.id, { reference, status });
  }

  await run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
  res.json(200, { ok: true });
}

// Exposed so admin can see the generated code function without duplicating logic elsewhere.
export { generateMemberCode };
