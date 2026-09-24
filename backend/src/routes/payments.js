// routes/payments.js
// Correct sequence per handover doc:
//   backend creates reference -> secure provider checkout -> provider processes
//   -> provider webhook/server verification -> verify signature/amount/currency/
//   reference -> idempotent DB update -> activate or route for approval.
// This route only ever creates a PAYMENT_PENDING record and a checkout
// pointer. It NEVER marks a payment verified — only routes/webhooks.js does
// that, after signature verification. There is no "confirm from browser"
// endpoint on purpose.

import { Router, HttpError } from '../router.js';
import { get, run } from '../db.js';
import { audit } from '../utils/audit.js';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'node:crypto';
import https from 'node:https';
import { parseNgnToKobo, koboToNgn } from '../utils/money.js';

export const paymentsRouter = new Router();

const MEMBERSHIP_FEE_NGN = Number(process.env.MEMBERSHIP_FEE_NGN || 2000);

function assertPaystackModeSafe() {
  const key = String(process.env.PAYSTACK_SECRET_KEY || '');
  const isLiveKey = key.startsWith('sk_live_');
  if (isLiveKey && process.env.PAYSTACK_LIVE_ENABLED !== 'true') {
    throw new HttpError(503, 'Live Paystack processing is not enabled yet.');
  }
  if (process.env.PAYSTACK_LIVE_ENABLED === 'true' && !isLiveKey) {
    throw new HttpError(503, 'Paystack live mode requires a live secret key.');
  }
  return isLiveKey ? 'live' : 'test';
}

// Real call to Paystack's "initialize transaction" API. Secret key stays
// server-side only — never sent to or exposed in the browser.
function initializePaystackTransaction({ email, amountNaira, reference }) {
  assertPaystackModeSafe();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      email,
      amount: Math.round(amountNaira * 100), // Paystack expects kobo
      reference,
      currency: 'NGN',
      callback_url: process.env.PAYSTACK_CALLBACK_URL || 'https://obitcooperative.com/apply.html?payment=return',
    });

    const req = https.request(
      {
        hostname: 'api.paystack.co',
        path: '/transaction/initialize',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300 && parsed.status) {
              resolve(parsed.data); // { authorization_url, access_code, reference }
            } else {
              reject(new Error(parsed.message || `Paystack returned status ${res.statusCode}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

paymentsRouter.post('/api/payments/contributions/initialize', requireAuth('member'), async (req, res) => {
  const { amount, plan_id } = req.body || {};
  let amountKobo;
  try { amountKobo = parseNgnToKobo(amount, { minKobo: 10000 }); }
  catch { throw new HttpError(400, 'Contribution amount must be at least ₦100 and use no more than two decimal places'); }
  const amountNaira = koboToNgn(amountKobo);
  if (amountNaira > Number(process.env.MAX_CONTRIBUTION_NGN || 5000000)) throw new HttpError(400, 'Contribution amount exceeds the permitted online limit');

  const member = get('SELECT * FROM members WHERE user_id = ?', [req.user.id]);
  if (!member || member.status !== 'ACTIVE') throw new HttpError(403, 'Active membership required');

  const user = get('SELECT email FROM users WHERE id = ?', [req.user.id]);
  const application = get('SELECT email FROM member_applications WHERE id = ?', [member.application_id]);
  const email = user?.email || application?.email;
  if (!email) throw new HttpError(400, 'Member email is required');

  if (plan_id) {
    const plan = get('SELECT * FROM contribution_plans WHERE id = ? AND member_id = ?', [plan_id, member.id]);
    if (!plan) throw new HttpError(404, 'Savings goal not found');
  }

  const reference = `OBIT-SAV-${member.id}-${crypto.randomBytes(6).toString('hex')}`;
  run(`INSERT INTO transactions (member_id, type, amount, amount_kobo, currency, provider_reference, status)
       VALUES (?, 'CONTRIBUTION', ?, ?, 'NGN', ?, 'PENDING')`,
      [member.id, amountNaira, amountKobo, reference]);

  try {
    const paystackData = await initializePaystackTransaction({ email, amountNaira, reference });
    audit(req.user.id, 'CONTRIBUTION_INITIALIZED', 'members', member.id, { reference, amount: amountNaira, plan_id: plan_id || null });
    return res.json(201, { reference, amount: amountNaira, currency: 'NGN', checkout_url: paystackData.authorization_url });
  } catch (err) {
    run("UPDATE transactions SET status = 'FAILED' WHERE provider_reference = ?", [reference]);
    audit(req.user.id, 'CONTRIBUTION_INIT_FAILED', 'members', member.id, { reference, error: err.message });
    throw new HttpError(502, `Could not start contribution checkout: ${err.message}`);
  }
});

paymentsRouter.post('/api/payments/membership/initialize', async (req, res) => {
  const { application_id, provider } = req.body || {};
  if (!['paystack', 'monnify'].includes(provider)) {
    throw new HttpError(400, "provider must be 'paystack' or 'monnify'");
  }

  const application = get('SELECT * FROM member_applications WHERE id = ?', [application_id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (!['KYC_VERIFIED', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(application.status)) {
    throw new HttpError(409, `Application must be KYC_VERIFIED before payment (currently ${application.status})`);
  }

  const reference = `OBIT-${application_id}-${crypto.randomBytes(6).toString('hex')}`;
  run(
    `INSERT INTO membership_payments (application_id, provider, reference, amount, currency, status)
     VALUES (?, ?, ?, ?, 'NGN', 'PAYMENT_PENDING')`,
    [application_id, provider, reference, MEMBERSHIP_FEE_NGN]
  );
  run("UPDATE member_applications SET status = 'PAYMENT_PENDING', updated_at = datetime('now') WHERE id = ?", [application_id]);
  audit(null, 'PAYMENT_INITIALIZED', 'member_applications', application_id, { reference, provider });

  // Paystack: real integration, live once PAYSTACK_SECRET_KEY is set.
  if (provider === 'paystack' && process.env.PAYSTACK_SECRET_KEY) {
    try {
      const paystackData = await initializePaystackTransaction({
        email: application.email,
        amountNaira: MEMBERSHIP_FEE_NGN,
        reference,
      });
      return res.json(201, {
        reference,
        amount: MEMBERSHIP_FEE_NGN,
        currency: 'NGN',
        checkout_url: paystackData.authorization_url,
      });
    } catch (err) {
      audit(null, 'PAYSTACK_INIT_FAILED', 'member_applications', application_id, { error: err.message });
      throw new HttpError(502, `Could not start Paystack checkout: ${err.message}`);
    }
  }

  // Monnify real integration is not yet implemented — still sandboxed.
  // Paystack without a key configured also falls through to sandbox mode.
  res.json(201, {
    reference,
    amount: MEMBERSHIP_FEE_NGN,
    currency: 'NGN',
    checkout_url: `about:blank#sandbox-checkout-${reference}`,
    sandbox_note: provider === 'monnify'
      ? 'Monnify live checkout is not implemented yet — this is a placeholder checkout pointer, not a real payment page.'
      : `No PAYSTACK secret key configured — this is a placeholder checkout pointer, not a real payment page.`,
  });
});