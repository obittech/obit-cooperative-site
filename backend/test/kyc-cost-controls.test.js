import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-kyc-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.DOJAH_ENV = 'sandbox';
process.env.DOJAH_APP_ID = 'test-only';
process.env.DOJAH_SECRET_KEY = 'test-only';
const { migrate, get, run, all, closeDatabase } = await import('../src/db.js');
const { reserveKycRequest, finishKycRequest, requireKycAccess } = await import('../src/services/kyc-cost-controls.js');
const { kycRouter } = await import('../src/routes/kyc.js');
await migrate();
after(async () => { await closeDatabase(); fs.rmSync(temp, { recursive: true, force: true }); });
async function fixture() {
  const app = await run("INSERT INTO member_applications (full_legal_name, date_of_birth, status) VALUES ('Test Person', '1990-01-01', 'KYC_PENDING')");
  for (const type of ['terms', 'privacy']) await run('INSERT INTO consents (application_id, type, accepted) VALUES (?, ?, 1)', [app.lastInsertRowid, type]);
  const check = await run("INSERT INTO kyc_checks (application_id, session_ref, status) VALUES (?, ?, 'KYC_PENDING')", [app.lastInsertRowid, `dojah_sandbox_${crypto.randomUUID()}`]);
  return get('SELECT * FROM kyc_checks WHERE id = ?', [check.lastInsertRowid]);
}
const verify = kycRouter.match('POST', '/api/kyc/session/test/verify').handlers[0];
const request = { body: { type: 'nin', id_number: '12345678901' } };
const response = { json: (status, body) => ({ status, body }) };

test('simultaneous requests across two sessions reserve only one dispatch', async () => {
  const check = await fixture();
  const other = await run("INSERT INTO kyc_checks (application_id, session_ref) VALUES (?, ?)", [check.application_id, `dojah_sandbox_${crypto.randomUUID()}`]);
  const second = await get('SELECT * FROM kyc_checks WHERE id = ?', [other.lastInsertRowid]);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveKycRequest(i % 2 ? check : second, 'sandbox', 'nin')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rows = await all('SELECT * FROM kyc_provider_requests WHERE application_id = ?', [check.application_id]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('12345678901'), false);
});

test('chargeable 404 is recorded once and repeated clicks never reach provider', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 422);
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
  assert.equal(calls, 1);
  const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
  assert.equal(row.state, 'NOT_FOUND'); assert.equal(row.provider_status, 404);
});

test('durable timeout stays blocked even after 24 hours', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('secret provider URL must not escape'); };
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502 && !e.message.includes('secret'));
  await run('UPDATE kyc_provider_requests SET started_ms = ? WHERE check_id = ?', [Date.now() - 172800000, check.id]);
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
  assert.equal(calls, 1);
});

test('latest withdrawn consent prevents dispatch without spending an attempt', async () => {
  const check = await fixture();
  await run("INSERT INTO consents (application_id, type, accepted) VALUES (?, 'privacy', 0)", [check.application_id]);
  await assert.rejects(reserveKycRequest(check, 'sandbox', 'nin'), e => e.status === 409);
  assert.equal((await get('SELECT attempt_count FROM kyc_checks WHERE id = ?', [check.id])).attempt_count, 0);
});

test('invalid identifiers and missing credentials never dispatch', async () => {
  const check = await fixture();
  await assert.rejects(verify({ body: { id_number: 'bad' } }, response, { ref: check.session_ref }), e => e.status === 400);
  delete process.env.DOJAH_SECRET_KEY;
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 503);
  process.env.DOJAH_SECRET_KEY = 'test-only';
  assert.equal((await get('SELECT attempt_count FROM kyc_checks WHERE id = ?', [check.id])).attempt_count, 0);
});

test('live access requires authorisation, product approval and valid cost settings', async () => {
  assert.throws(() => requireKycAccess('live', 'bvn'), e => e.status === 503);
  process.env.DOJAH_PRODUCTION_AUTHORIZED = 'true';
  process.env.DOJAH_APPROVED_PRODUCTS = 'bvn';
  assert.throws(() => requireKycAccess('live', 'bvn'), e => e.status === 503);
  process.env.DOJAH_DAILY_REQUEST_LIMIT = '2';
  process.env.DOJAH_DAILY_BUDGET_KOBO = '1500';
  process.env.DOJAH_BVN_MAX_COST_KOBO = '1000';
  assert.throws(() => requireKycAccess('live', 'nin'), e => e.status === 503);
  const one = await fixture();
  const id = await reserveKycRequest(one, 'live', 'bvn');
  await finishKycRequest(id, 'NOT_FOUND', 404);
  await assert.rejects(reserveKycRequest(await fixture(), 'live', 'bvn'), e => e.status === 429);
  assert.equal(Number((await get('SELECT reserved_kobo FROM kyc_provider_requests WHERE id = ?', [id])).reserved_kobo), 1000);
  process.env.DOJAH_DAILY_BUDGET_KOBO = '10000';
  await reserveKycRequest(await fixture(), 'live', 'bvn');
  await assert.rejects(reserveKycRequest(await fixture(), 'live', 'bvn'), e => e.status === 429);
  delete process.env.DOJAH_PRODUCTION_AUTHORIZED;
});

test('successful match remains idempotent and raw identities are not persisted', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ entity: { first_name: 'Test', last_name: 'Person', dob: '1990-01-01', nin: request.body.id_number } }) }; };
  let result;
  await verify(request, { json: (status, body) => { result = body; } }, { ref: check.session_ref });
  assert.equal(result.status, 'KYC_VERIFIED');
  await verify(request, response, { ref: check.session_ref });
  assert.equal(calls, 1);
  const row = await get('SELECT * FROM kyc_checks WHERE id = ?', [check.id]);
  assert.equal(JSON.stringify(row).includes(request.body.id_number), false);
});

test('legacy five-attempt cap survives migration', async () => {
  const check = await fixture();
  await run('UPDATE kyc_checks SET attempt_count = 5 WHERE id = ?', [check.id]);
  await assert.rejects(reserveKycRequest(check, 'sandbox', 'nin'), e => e.status === 429);
});
