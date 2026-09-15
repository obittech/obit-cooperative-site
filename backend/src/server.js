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
const { handlePaymentWebhook } = await import('./routes/webhooks.js');

migrate();

const routers = [authRouter, applicationsRouter, kycRouter, paymentsRouter, meRouter, adminRouter];
const WEBHOOK_PATTERN = /^\/api\/webhooks\/payments\/([^/]+)\/?$/;

const server = http.createServer(async (req, res) => {
  res.json = (status, body) => sendJson(res, status, body);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
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
});

export default server;
