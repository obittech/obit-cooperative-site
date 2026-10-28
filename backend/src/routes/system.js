import { Router } from '../router.js';
import { get, DB_ENGINE } from '../db.js';
import { createHealthHandler } from '../utils/health.js';

export const systemRouter = new Router();

systemRouter.get('/api/health', createHealthHandler(() => get('SELECT 1 AS ok')));

systemRouter.get('/api/readiness', async (_req, res) => {
  let databaseOk = false;
  try {
    databaseOk = Number((await get('SELECT 1 AS ok'))?.ok) === 1;
  } catch {
    databaseOk = false;
  }

  const paystackKey = String(process.env.PAYSTACK_SECRET_KEY || '');
  const paystackMode = paystackKey.startsWith('sk_live_') ? 'live'
    : paystackKey.startsWith('sk_test_') ? 'test'
    : 'unconfigured';

  const youverifyEnvironment = String(process.env.YOUVERIFY_ENV || 'sandbox').toLowerCase();
  const ready = databaseOk;

  res.json(ready ? 200 : 503, {
    ok: ready,
    database: {
      ok: databaseOk,
      runtime: DB_ENGINE,
    },
    paystack: {
      mode: paystackMode,
      live_enabled: process.env.PAYSTACK_LIVE_ENABLED === 'true',
    },
    youverify: {
      provider: 'YOUVERIFY',
      environment: youverifyEnvironment,
      configured: Boolean(process.env.YOUVERIFY_SECRET_KEY),
      production_authorized: process.env.YOUVERIFY_PRODUCTION_AUTHORIZED === 'true',
    },
    dev_routes_enabled: process.env.ENABLE_DEV_ROUTES === 'true',
  });
});
