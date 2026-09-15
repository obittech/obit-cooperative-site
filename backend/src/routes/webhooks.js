// routes/webhooks.js
// This is the ONLY place a membership payment is ever marked verified.
// - Signature is checked against the raw request body (not the parsed JSON).
// - webhook_events has a UNIQUE(provider, event_id) constraint, so a replayed
//   or duplicated delivery is a no-op the second time (idempotency).
// - Amount/currency/reference are re-checked against our own PAYMENT_PENDING
//   row — we never trust the payload's amount blindly.

import { Router, HttpError, readRawBody } from '../router.js';
import { get, run } from '../db.js';
import { audit } from '../utils/audit.js';
import { generateMemberCode } from '../utils/auth.js';
import crypto from 'node:crypto';

export const webhooksRouter = new Router();

function verifyPaystackSignature(rawBody, signatureHeader) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false; // sandbox: no live key configured, refuse rather than trust
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, Buffer.from(b));
}

function verifyMonnifySignature(rawBody, signatureHeader) {
  const secret = process.env.MONNIFY_SECRET_KEY;
  if (!secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, Buffer.from(b));
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
    audit(null, 'WEBHOOK_SIGNATURE_REJECTED', 'webhook_events', null, { provider });
    throw new HttpError(401, 'Signature verification failed');
  }

  let event;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }

  const eventId = event.id || event.reference || event.data?.reference || crypto.randomUUID();
  const alreadyProcessed = get('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
  if (alreadyProcessed) {
    res.json(200, { ok: true, idempotent_replay: true });
    return;
  }
  run(
    `INSERT INTO webhook_events (provider, event_id, payload_json, processed) VALUES (?, ?, ?, 0)`,
    [provider, String(eventId), raw]
  );

  const reference = event.data?.reference || event.reference;
  const amountKobo = event.data?.amount ?? event.amount;
  const currency = event.data?.currency || event.currency || 'NGN';
  const status = event.data?.status || event.status;

  const payment = get('SELECT * FROM membership_payments WHERE reference = ?', [reference]);
  if (!payment) {
    audit(null, 'WEBHOOK_UNKNOWN_REFERENCE', 'webhook_events', null, { provider, reference });
    throw new HttpError(404, 'Unknown payment reference');
  }

  // A reference that is already PAYMENT_VERIFIED must never be reprocessed,
  // even if the provider sends a fresh event id for what is logically the
  // same payment (e.g. a retried webhook with a new delivery id). Prevents
  // an application from bouncing back to UNDER_REVIEW after admin has
  // already acted on it.
  if (payment.status === 'PAYMENT_VERIFIED') {
    run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    res.json(200, { ok: true, idempotent_replay: true });
    return;
  }

  const expectedAmountKobo = Math.round(payment.amount * 100);
  const amountMatches = amountKobo === undefined || Number(amountKobo) === expectedAmountKobo;
  const currencyMatches = currency === payment.currency;
  const success = ['success', 'PAID', 'successful'].includes(status);

  if (!amountMatches || !currencyMatches) {
    run("UPDATE membership_payments SET status = 'PAYMENT_FAILED' WHERE id = ?", [payment.id]);
    run("UPDATE member_applications SET status = 'PAYMENT_FAILED', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
    audit(null, 'PAYMENT_AMOUNT_MISMATCH', 'membership_payments', payment.id, { amountKobo, expectedAmountKobo, currency });
    throw new HttpError(422, 'Amount or currency mismatch');
  }

  if (success) {
    run("UPDATE membership_payments SET status = 'PAYMENT_VERIFIED', verified_at = datetime('now') WHERE id = ?", [payment.id]);
    run("UPDATE member_applications SET status = 'UNDER_REVIEW', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    audit(null, 'PAYMENT_VERIFIED', 'membership_payments', payment.id, { reference });
  } else {
    run("UPDATE membership_payments SET status = 'PAYMENT_FAILED' WHERE id = ?", [payment.id]);
    run("UPDATE member_applications SET status = 'PAYMENT_FAILED', updated_at = datetime('now') WHERE id = ?", [payment.application_id]);
    audit(null, 'PAYMENT_FAILED', 'membership_payments', payment.id, { reference, status });
  }

  run('UPDATE webhook_events SET processed = 1 WHERE provider = ? AND event_id = ?', [provider, String(eventId)]);
  res.json(200, { ok: true });
}

// Exposed so admin can see the generated code function without duplicating logic elsewhere.
export { generateMemberCode };
