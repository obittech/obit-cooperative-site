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
const { systemRouter } = await import('./routes/system.js');
const { opportunitiesRouter } = await import('./routes/opportunities.js');
const { devRouter } = await import('./routes/dev.js');
const { handlePaymentWebhook } = await import('./routes/webhooks.js');
const { safePayRouter } = await import('./routes/safepay.js');
const { handleSafePayWebhook } = await import('./routes/safepay-webhook.js');

migrate();

const routers = [systemRouter, authRouter, applicationsRouter, kycRouter, paymentsRouter, opportunitiesRouter, safePayRouter, meRouter, adminRouter];
if (process.env.ENABLE_DEV_ROUTES === 'true') routers.push(devRouter);

const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || 'https://obitcooperative.com,https://www.obitcooperative.com,https://obit-cooperative-site.onrender.com')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const WEBHOOK_PATTERN = /^\/api\/webhooks\/payments\/([^/]+)\/?$/;
const SAFEPAY_WEBHOOK_PATTERN = /^\/api\/webhooks\/safepay\/([^/]+)\/?$/;

const server = http.createServer(async (req, res) => {
  res.json = (status, body) => sendJson(res, status, body);
  const origin = req.headers.origin;
  const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : null;
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin) {
      res.writeHead(403);
      return res.end();
    }
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-sandbox-signature',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Max-Age': '600',
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
    const safePayWebhookMatch = SAFEPAY_WEBHOOK_PATTERN.exec(pathname);
    if (safePayWebhookMatch && req.method === 'POST') {
      await handleSafePayWebhook(req, res, { provider: safePayWebhookMatch[1] });
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

});

export default server;
