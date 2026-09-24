// services/safepay-provider.js
// Obit SafePay provider boundary.
// Production calls remain fail-closed until EscrowPay issues sandbox credentials,
// the signed webhook contract, and written commercial terms.

import https from 'node:https';
import { URL } from 'node:url';

function configured() {
  return process.env.SAFEPAY_PROVIDER === 'escrowpay'
    && process.env.SAFEPAY_PROVIDER_ENABLED === 'true'
    && !!process.env.ESCROWPAY_API_KEY
    && !!process.env.ESCROWPAY_API_BASE;
}

export function safePayProviderStatus() {
  return {
    provider: process.env.SAFEPAY_PROVIDER || 'escrowpay',
    enabled: configured(),
    mode: process.env.SAFEPAY_MODE || 'sandbox',
  };
}

function request(method, path, body) {
  if (!configured()) {
    throw new Error('Obit SafePay provider is not enabled. Sandbox credentials and webhook contract are required.');
  }
  const base = new URL(process.env.ESCROWPAY_API_BASE);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || undefined,
      path: base.pathname.replace(/\/$/, '') + path,
      method,
      headers: {
        // EscrowPay must confirm the exact authentication scheme in its sandbox contract.
        // Do not change this to live mode until the issued docs are checked.
        Authorization: `Bearer ${process.env.ESCROWPAY_API_KEY}`,
        Accept: 'application/json',
        ...(payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {}),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.message || parsed.error || `SafePay provider returned ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('SafePay provider timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function createEscrow({ amountNaira, buyerPhone, sellerPhone, reference, terms }) {
  return request('POST', '/v1/escrows', {
    amount: amountNaira,
    currency: 'NGN',
    buyer: { phone: buyerPhone },
    seller: { phone: sellerPhone },
    reference,
    terms,
  });
}

export function getEscrow(id) { return request('GET', `/v1/escrows/${encodeURIComponent(id)}`); }
export function releaseEscrow(id) { return request('POST', `/v1/escrows/${encodeURIComponent(id)}/release`, {}); }
export function refundEscrow(id) { return request('POST', `/v1/escrows/${encodeURIComponent(id)}/refund`, {}); }
