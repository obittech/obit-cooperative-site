import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'membership-transfer-tests-only';
process.env.MARKET_TRANSFER_ENABLED = 'true';
process.env.MARKET_TRANSFER_BANK_NAME = 'Test Bank';
process.env.MARKET_TRANSFER_ACCOUNT_NAME = 'Obit Test Account';
process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
process.env.MEMBERSHIP_FEE_NGN = '3000';
const { migrate, run, get, all, atomic, closeDatabase } = await import('../src/db.js');
const { membershipTransfersRouter: router } = await import('../src/routes/membership-transfers.js');
const { paymentsRouter } = await import('../src/routes/payments.js');
const { issueToken } = await import('../src/utils/auth.js');
const { allocateBankCredit } = await import('../src/services/bank-credit.js');
await migrate();
after(closeDatabase);
const created = await run("INSERT INTO users (email,role,status) VALUES (?, 'staff','ACTIVE')", [`transfer-staff-${crypto.randomUUID()}@example.invalid`]);
const staff = issueToken(await get('SELECT * FROM users WHERE id = ?', [created.lastInsertRowid]));
async function call(method, path, body = {}, token = '', target = router) {
  const route = target.match(method, path);
  assert.ok(route);
  const req = { body, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
async function app(status = 'KYC_VERIFIED') {
  const r = await run('INSERT INTO member_applications (full_legal_name,status) VALUES (?,?)', ['Local Transfer Test', status]);
  return Number(r.lastInsertRowid);
}
const start = id => call('POST', '/api/payments/membership/bank-transfer', { application_id: id, amount: 1 });
const paid = p => call('POST', `/api/payments/membership/bank-transfer/${p.reference}/paid`);
const confirm = (p, ref, changes = {}, token = staff) => call('POST', `/api/admin/membership-transfers/${p.reference}/confirm`, { amount_kobo: p.amount_kobo, bank_reference: ref, bank_credit_checked: true, ...changes }, token);

test('internal membership checkout requires verified KYC and configured bank details', async () => {
  await assert.rejects(start(await app('APPLICATION_SUBMITTED')), e => e.status === 409);
  process.env.MARKET_TRANSFER_ENABLED = 'false';
  const id = await app();
  await assert.rejects(start(id), e => e.status === 503);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'KYC_VERIFIED');
  process.env.MARKET_TRANSFER_ENABLED = 'true';
});

test('checkout snapshots bank details and server fee, then resumes one reference', async () => {
  const id = await app();
  const results = await Promise.all([start(id), start(id)]);
  assert.equal(results[0].reference, results[1].reference);
  assert.equal(results[0].amount_kobo, 300000);
  assert.equal(results[0].status, 'READY');
  process.env.MEMBERSHIP_FEE_NGN = '9000';
  process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '1111111111';
  assert.equal((await start(id)).amount_kobo, 300000);
  assert.equal((await start(id)).account_number, '0000000000');
  process.env.MEMBERSHIP_FEE_NGN = '3000';
  process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
  await assert.rejects(call('POST', '/api/payments/membership/initialize', { application_id: id, provider: 'paystack' }, '', paymentsRouter), e => e.status === 409);
});

test('I Have Paid opens the correct WhatsApp message without verifying payment', async () => {
  const id = await app(), payment = await start(id);
  const claimed = await paid(payment);
  const url = new URL(claimed.whatsapp_url);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/2348030567787');
  assert.ok(url.searchParams.get('text').includes(payment.reference));
  assert.ok(url.searchParams.get('text').includes(String(id)));
  assert.ok(url.searchParams.get('text').includes('3,000'));
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(claimed.receipt_reference, null);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'PAYMENT_PENDING');
  await paid(payment);
  const audit = await all("SELECT id FROM audit_events WHERE action = 'MEMBERSHIP_TRANSFER_REPORTED' AND entity_id = ?", [id]);
  assert.equal(audit.length, 1);
});

test('staff verifies exact credit and records one receipt without activating membership', async () => {
  const id = await app(), payment = await start(id);
  await assert.rejects(confirm(payment, 'bank-ref-test'), e => e.status === 409);
  await paid(payment);
  await assert.rejects(confirm(payment, 'bank-ref-test', {}, ''), e => e.status === 401);
  await assert.rejects(confirm(payment, 'bank-ref-test', { bank_credit_checked: false }), e => e.status === 400);
  await assert.rejects(confirm(payment, 'bank-ref-test', { amount_kobo: 100 }), e => e.status === 409);
  const ref = `BANK-${crypto.randomUUID()}`;
  const result = await confirm(payment, ref);
  assert.equal(result.status, 'CONFIRMED');
  assert.ok(result.receipt_reference);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'UNDER_REVIEW');
  await confirm(payment, ref);
  assert.equal((await paid(payment)).status, 'CONFIRMED');
  await assert.rejects(confirm(payment, ref + '-other'), e => e.status === 409);
  const second = await start(await app());
  await paid(second);
  await assert.rejects(confirm(second, ref), e => e.status === 409);
  assert.equal((await get('SELECT status FROM membership_bank_payments WHERE reference=?', [second.reference])).status, 'CLAIMED');
});

test('a bank credit cannot fund both marketplace and membership, even concurrently', async () => {
  const ref = `CROSS-${crypto.randomUUID()}`;
  const results = await Promise.allSettled([
    atomic(() => allocateBankCredit(ref, 'MARKET', 123)),
    atomic(() => allocateBankCredit(ref, 'MEMBERSHIP', 456)),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.status === 409).length, 1);
  await migrate();
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM bank_credit_allocations WHERE bank_reference=?', [ref])).n), 1);
});
