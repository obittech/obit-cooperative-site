import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

// --- tiny .env loader (no dotenv dependency) --------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { migrate } = await import('./db.js');
const { sendJson, readJsonBody, HttpError } = await import('./router.js');
const { authRouter } = await import('./routes/auth.js');
const { applicationsRouter } = await import('./routes/applications.js');
const { kycRouter } = await import('./routes/kyc.js');
const { paymentsRouter } = await import('./routes/payments.js');
const { meRouter } = await import('./routes/me.js');
const { adminRouter } = await import('./routes/admin.js');
const { devRouter } = await import('./routes/dev.js');
const { handlePaymentWebhook } = await import('./routes/webhooks.js');

migrate();

const routers = [authRouter, applicationsRouter, kycRouter, paymentsRouter, meRouter, adminRouter, devRouter];
const WEBHOOK_PATTERN = /^\/api\/webhooks\/payments\/([^/]+)\/?$/;

const server = http.createServer(async (req, res) => {
  res.json = (status, body) => sendJson(res, status, body);
  const corsOrigin = process.env.CORS_ORIGIN || 'https://obitcooperative.com';
  const origin = req.headers.origin;
  if (origin && origin === corsOrigin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || 'https://obitcooperative.com',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sandbox-signature',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    });
    return res.end();
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Webhooks read the raw body themselves (signature verification needs
    // the exact bytes), so route them before generic JSON body parsing.
    const webhookMatch = WEBHOOK_PATTERN.exec(pathname);
    if (webhookMatch && req.method === 'POST') {
      await handlePaymentWebhook(req, res, { provider: webhookMatch[1] });
      return;
    }

    let matched = null;
    for (const router of routers) {
      matched = router.match(req.method, pathname);
      if (matched) break;
    }
    if (!matched) throw new HttpError(404, 'Not found');

    req.body = ['POST', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};

    for (const handler of matched.handlers) {
      await handler(req, res, matched.params);
      if (res.writableEnded) break;
    }
    if (!res.writableEnded) throw new HttpError(500, 'Handler did not send a response');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.writableEnded) res.json(status, { error: err.message || 'Internal error' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Obit Membership MVP API listening on http://localhost:${PORT}`);
  console.log(`Mode: ${process.env.WEBHOOK_SANDBOX_MODE === 'true' ? 'SANDBOX' : 'LIVE-SIGNATURE (requires real provider secret keys)'}`);

  // Temporary internal E2E harness. Runs only when explicitly enabled and only
  // against Dojah sandbox test data. It drives the same HTTP routes as the UI.
  if (process.env.RUN_KYC_E2E_ON_START === 'true' && (process.env.DOJAH_ENV || 'sandbox').toLowerCase() === 'sandbox') {
    setTimeout(async () => {
      const base = `http://127.0.0.1:${PORT}`;
      const stamp = Date.now();
      const call = async (method, route, body) => {
        const r = await fetch(base + route, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${method} ${route}: ${data.error || r.status}`);
        return data;
      };
      try {
        const app = await call('POST', '/api/applications', { campaign: 'internal-dojah-e2e' });
        await call('PATCH', `/api/applications/${app.id}`, {
          full_legal_name: 'John Doe',
          date_of_birth: '1990-01-01',
          gender: 'Male',
          phone: `0809${String(stamp).slice(-7)}`,
          whatsapp: `0809${String(stamp).slice(-7)}`,
          email: `john.doe.e2e.${stamp}@example.com`,
          address: '1 Test Street, Abuja',
          state: 'FCT',
          lga: 'Abuja Municipal',
          occupation_category: 'Salary Earner',
          membership_type: 'Individual',
          next_of_kin_name: 'Jane Doe',
          next_of_kin_phone: '08000000002',
          intended_savings_amount: 10000,
          intended_savings_frequency: 'Monthly',
          interests: ['savings'],
        });
        await call('POST', `/api/applications/${app.id}/submit`, {
          consents: { terms: true, privacy: true, marketing: false },
        });
        const session = await call('POST', '/api/kyc/session', { application_id: app.id });
        const verification = await call('POST', `/api/kyc/session/${session.session_ref}/verify`, {
          type: 'bvn',
          id_number: '22222222222',
        });
        const finalApp = await call('GET', `/api/applications/${app.id}`);
        console.log('KYC_E2E_RESULT', JSON.stringify({
          ok: verification.status === 'KYC_VERIFIED',
          application_id: app.id,
          application_status: finalApp.status,
          kyc_status: verification.status,
          sandbox_match: verification.sandbox_match || null,
          message: verification.message,
        }));
      } catch (error) {
        console.error('KYC_E2E_ERROR', error.message);
      }
    }, 1500);
  }
});

export default server;
