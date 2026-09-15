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
import crypto from 'node:crypto';

export const paymentsRouter = new Router();

const MEMBERSHIP_FEE_NGN = Number(process.env.MEMBERSHIP_FEE_NGN || 2000);

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

  const hasLiveKeys = provider === 'paystack' ? !!process.env.PAYSTACK_SECRET_KEY : !!process.env.MONNIFY_SECRET_KEY;

  res.json(201, {
    reference,
    amount: MEMBERSHIP_FEE_NGN,
    currency: 'NGN',
    // In production, call the provider's real "initialize transaction" API
    // here with the SECRET key (server-side only) and return their
    // authorization_url instead of this placeholder.
    checkout_url: hasLiveKeys
      ? null // real integration point — call provider SDK/API here
      : `about:blank#sandbox-checkout-${reference}`,
    sandbox_note: hasLiveKeys
      ? undefined
      : `No ${provider.toUpperCase()} secret key configured — this is a placeholder checkout pointer, not a real payment page.`,
  });
});
