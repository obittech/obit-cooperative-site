// scripts/simulate-webhook.js
// Local-only helper: posts a fake "payment successful" webhook to the API
// using WEBHOOK_SANDBOX_SECRET, so you can test the full
// ACQUIRE -> VERIFY -> ACTIVATE -> COLLECT flow before real Paystack/Monnify
// keys exist. Requires WEBHOOK_SANDBOX_MODE=true in the running server's .env.
//
// Usage: node scripts/simulate-webhook.js <reference> <amountNaira> [status]
//   node scripts/simulate-webhook.js OBIT-1-abc123 2000 success

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
}

const [, , reference, amountNaira, status = 'success'] = process.argv;
if (!reference || !amountNaira) {
  console.error('Usage: node scripts/simulate-webhook.js <reference> <amountNaira> [status]');
  process.exit(1);
}

const body = JSON.stringify({
  id: `evt_${crypto.randomUUID()}`,
  data: { reference, amount: Math.round(Number(amountNaira) * 100), currency: 'NGN', status },
});

const secret = env.WEBHOOK_SANDBOX_SECRET || 'dev-only-shared-secret';
const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
const port = env.PORT || 4000;

const res = await fetch(`http://localhost:${port}/api/webhooks/payments/paystack`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-sandbox-signature': signature },
  body,
});
console.log(res.status, await res.text());
