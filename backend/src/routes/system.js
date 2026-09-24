import { Router } from '../router.js';
import { get } from '../db.js';

export const systemRouter = new Router();

systemRouter.get('/api/health', async (_req, res) => {
  res.json(200, {
    ok: true,
    service: 'obit-cooperative-api',
    time: new Date().toISOString(),
  });
});

systemRouter.get('/api/readiness', async (_req, res) => {
  let databaseOk = false;
  try {
    databaseOk = Number(await get('SELECT 1 AS ok')?.ok) === 1;
  } catch {
    databaseOk = false;
  }

  const paystackKey = String(process.env.PAYSTACK_SECRET_KEY || '');
  const paystackMode = paystackKey.startsWith('sk_live_') ? 'live'
    : paystackKey.startsWith('sk_test_') ? 'test'
    : 'unconfigured';

  const dojahEnvironment = String(process.env.DOJAH_ENV || 'sandbox').toLowerCase();
  const ready = databaseOk;

  res.json(ready ? 200 : 503, {
    ok: ready,
    database: {
      ok: databaseOk,
      runtime: 'sqlite',
    },
    paystack: {
      mode: paystackMode,
      live_enabled: process.env.PAYSTACK_LIVE_ENABLED === 'true',
    },
    dojah: {
      environment: dojahEnvironment,
      configured: Boolean(process.env.DOJAH_APP_ID && process.env.DOJAH_SECRET_KEY),
    },
    dev_routes_enabled: process.env.ENABLE_DEV_ROUTES === 'true',
  });
});
