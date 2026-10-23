import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createHealthHandler } from '../src/utils/health.js';

// Isolated in-memory database. No provider HTTP calls or production credentials.
process.env.DB_ENGINE ||= 'sqlite';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'local-regression-only';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_regression';
process.env.WEBHOOK_SANDBOX_MODE = 'false';
process.env.NODE_ENV = 'test';
const { migrate, run, get, closeDatabase } = await import('../src/db.js');
await migrate();
after(closeDatabase);
const { handlePaymentWebhook } = await import('../src/routes/webhooks.js');
let sequence = 0;
async function seed(provider = 'paystack') {
  const ref = `TEST-${++sequence}`;
  const app = await run("INSERT INTO member_applications (status) VALUES ('PAYMENT_PENDING')");
  const id = Number(app.lastInsertRowid);
  await run("INSERT INTO membership_payments (application_id,provider,reference,amount,amount_kobo,status) VALUES (?,?,?,?,?,'PAYMENT_PENDING')", [id, provider, ref, 3000, 300000]);
  return ref;
}
function event(ref, overrides = {}) {
  return { event: 'charge.success', data: { id: ++sequence, reference: ref, domain: 'test', amount: 300000, currency: 'NGN', status: 'success', ...overrides } };
}
async function deliver(body, signature = undefined) {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]);
  req.headers = { 'x-paystack-signature': signature ?? crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex') };
  const res = { json(status, body) { this.status = status; this.body = body; } };
  try { await handlePaymentWebhook(req, res, { provider: 'paystack' }); }
  catch (error) { res.status = error.status || 500; res.body = { error: error.message }; }
  return res;
}
async function pending(ref) {
  assert.equal((await get('SELECT status FROM membership_payments WHERE reference = ?', [ref])).status, 'PAYMENT_PENDING');
}

test('strict signed Paystack events', async t => {
  for (const [name, overrides] of [
    ['missing amount', { amount: undefined }], ['null amount', { amount: null }],
    ['string amount', { amount: '300000' }], ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }], ['fractional amount', { amount: 300000.5 }],
    ['unsafe integer', { amount: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing currency', { currency: undefined }], ['null currency', { currency: null }],
    ['missing reference', { reference: undefined }], ['blank reference', { reference: ' ' }],
    ['wrong domain', { domain: 'live' }], ['missing domain', { domain: undefined }],
    ['wrong status', { status: 'pending' }],
  ]) await t.test(name, async () => {
    const ref = await seed();
    const response = await deliver(event(ref, overrides));
    assert.equal(response.status, 422, JSON.stringify(response.body));
    await pending(ref);
  });
  await t.test('bad signature', async () => {
    const ref = await seed();
    assert.equal((await deliver(event(ref), '0'.repeat(128))).status, 401);
    await pending(ref);
  });
  await t.test('non-object payload', async () => {
    assert.equal((await deliver(null)).status, 400);
  });
  await t.test('unrelated event cannot activate membership', async () => {
    const ref = await seed(); const body = event(ref); body.event = 'refund.processed';
    const response = await deliver(body);
    assert.equal(response.status, 200); assert.equal(response.body.ignored, true);
    await pending(ref);
  });
  await t.test('wrong provider', async () => {
    const ref = await seed('monnify');
    assert.equal((await deliver(event(ref))).status, 422);
    await pending(ref);
  });
  await t.test('amount/currency mismatch never verifies payment', async () => {
    for (const overrides of [{ amount: 1 }, { currency: 'USD' }]) {
      const ref = await seed();
      assert.equal((await deliver(event(ref, overrides))).status, 422);
      assert.notEqual((await get('SELECT status FROM membership_payments WHERE reference=?', [ref])).status, 'PAYMENT_VERIFIED');
    }
  });
  await t.test('valid event then replay and new delivery ID', async () => {
    const ref = await seed(); const body = event(ref);
    assert.equal((await deliver(body)).status, 200);
    assert.equal((await get('SELECT status FROM membership_payments WHERE reference=?', [ref])).status, 'PAYMENT_VERIFIED');
    assert.equal((await deliver(body)).body.idempotent_replay, true);
    body.data.id = ++sequence;
    assert.equal((await deliver(body)).body.idempotent_replay, true);
  });
  await t.test('failed processing can retry rather than falsely acknowledge success', async () => {
    const ref = `RETRY-${++sequence}`; const body = event(ref);
    assert.equal((await deliver(body)).status, 404);
    const app = await run("INSERT INTO member_applications (status) VALUES ('PAYMENT_PENDING')");
    await run("INSERT INTO membership_payments (application_id,provider,reference,amount,amount_kobo) VALUES (?,'paystack',?,3000,300000)", [Number(app.lastInsertRowid), ref]);
    assert.equal((await deliver(body)).status, 200);
    assert.equal((await get('SELECT status FROM membership_payments WHERE reference=?', [ref])).status, 'PAYMENT_VERIFIED');
  });
  await t.test('live event requires explicit live switch', async () => {
    const ref = await seed(); process.env.PAYSTACK_SECRET_KEY = 'sk_live_local_regression';
    try { assert.equal((await deliver(event(ref, { domain: 'live' }))).status, 503); await pending(ref); }
    finally { process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_regression'; }
  });
  await t.test('production cannot enable local sandbox signature bypass', async () => {
    process.env.NODE_ENV = 'production'; process.env.WEBHOOK_SANDBOX_MODE = 'true';
    try { assert.equal((await deliver(event(await seed()))).status, 503); }
    finally { process.env.NODE_ENV = 'test'; process.env.WEBHOOK_SANDBOX_MODE = 'false'; }
  });
});

test('ledger delivery and rollback safety', async t => {
  const app = await run("INSERT INTO member_applications (status) VALUES ('ACTIVE')");
  const member = await run("INSERT INTO members (application_id,member_code) VALUES (?,?)", [Number(app.lastInsertRowid), `MEM-${++sequence}`]);
  const memberId = Number(member.lastInsertRowid);
  const account = await run("INSERT INTO ledger_accounts (member_id,balance,balance_kobo) VALUES (?,0,0)", [memberId]);
  const accountId = Number(account.lastInsertRowid);
  await t.test('concurrent deliveries credit once', async () => {
    const ref = `SAV-${++sequence}`;
    await run("INSERT INTO transactions (member_id,type,amount,amount_kobo,provider_reference) VALUES (?,'CONTRIBUTION',3000,300000,?)", [memberId,ref]);
    const body = event(ref);
    const results = await Promise.all([deliver(body), deliver(body), deliver({ ...body, data: { ...body.data, id: ++sequence } })]);
    assert.deepEqual(results.map(r => r.status), [200,200,200]);
    assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?', [accountId])).balance_kobo), 300000);
    assert.equal(Number((await get('SELECT COUNT(*) AS n FROM ledger_entries WHERE ledger_account_id=?', [accountId])).n), 1);
  });
  const ref = `WD-${++sequence}`;
  await run("INSERT INTO withdrawal_requests (member_id,ledger_account_id,amount,amount_kobo,transfer_reference,status) VALUES (?,?,5000,500000,?,'APPROVED')", [memberId, accountId, ref]);
  const body = event(ref, { amount: 500000 }); body.event = 'transfer.success';
  await t.test('transfer amount mismatch leaves withdrawal approved', async () => {
    const mismatch = { ...body, data: { ...body.data, amount: 1 } };
    assert.equal((await deliver(mismatch)).status, 422);
    assert.equal((await get('SELECT status FROM withdrawal_requests WHERE transfer_reference=?', [ref])).status, 'APPROVED');
  });
  await t.test('failed transfer processing rolls back event claim and retries', async () => {
    assert.equal((await deliver(body)).status, 409);
    assert.equal(Number((await get('SELECT COUNT(*) AS n FROM webhook_events WHERE event_id=?', [`transfer.success:${body.data.id}`])).n), 0);
    await run('UPDATE ledger_accounts SET balance=6000,balance_kobo=600000 WHERE id=?', [accountId]);
    assert.equal((await deliver(body)).status, 200);
    assert.equal((await get('SELECT status FROM withdrawal_requests WHERE transfer_reference=?', [ref])).status, 'PAID');
    assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?', [accountId])).balance_kobo), 100000);
    assert.equal((await deliver(body)).body.idempotent_replay, true);
  });
  await t.test('transfer reversal with same provider ID is not swallowed as duplicate', async () => {
    const reversal = { ...body, event: 'transfer.reversed', data: { ...body.data, status: 'reversed' } };
    assert.equal((await deliver(reversal)).status, 200);
    assert.equal(Number((await get('SELECT COUNT(*) AS n FROM webhook_events WHERE event_id=?', [`transfer.reversed:${body.data.id}`])).n), 1);
    // Reversals still require finance review, rather than automatically crediting money.
    assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?', [accountId])).balance_kobo), 100000);
  });
});

test('database-aware public health probe', async t => {
  for (const [name, query, expected] of [
    ['healthy database', async () => ({ ok: 1 }), 200],
    ['database failure', async () => { throw new Error('secret connection detail'); }, 503],
    ['unexpected result', async () => ({ ok: 0 }), 503],
    ['database timeout', () => new Promise(() => {}), 503],
  ]) await t.test(name, async () => {
    const res = { json(status, body) { this.status = status; this.body = body; } };
    await createHealthHandler(query, 20)({}, res);
    assert.equal(res.status, expected);
    assert.equal(res.body.ok, expected === 200);
    assert.equal(JSON.stringify(res.body).includes('secret'), false);
  });
});
