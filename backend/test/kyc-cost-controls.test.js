import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-kyc-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.YOUVERIFY_ENV = 'sandbox';
process.env.YOUVERIFY_SECRET_KEY = 'test-only';
const { migrate, get, run, all, closeDatabase } = await import('../src/db.js');
const { reserveKycRequest, finishKycRequest, requireKycAccess, providerReference } = await import('../src/services/kyc-cost-controls.js');
const { kycRouter } = await import('../src/routes/kyc.js');
await migrate();
after(async () => { await closeDatabase(); fs.rmSync(temp, { recursive: true, force: true }); });
async function fixture() {
  const app = await run("INSERT INTO member_applications (full_legal_name, date_of_birth, status) VALUES ('Test Person', '1990-01-01', 'KYC_PENDING')");
  for (const type of ['terms', 'privacy']) await run('INSERT INTO consents (application_id, type, accepted) VALUES (?, ?, 1)', [app.lastInsertRowid, type]);
  const check = await run("INSERT INTO kyc_checks (application_id, provider, session_ref, status) VALUES (?, 'YOUVERIFY', ?, 'KYC_PENDING')", [app.lastInsertRowid, `youverify_sandbox_${crypto.randomUUID()}`]);
  return get('SELECT * FROM kyc_checks WHERE id = ?', [check.lastInsertRowid]);
}
const verify = kycRouter.match('POST', '/api/kyc/session/test/verify').handlers[0];
const request = { body: { type: 'nin', id_number: '12345678901' } };
const response = { json: (status, body) => ({ status, body }) };

test('simultaneous requests across two sessions reserve only one dispatch', async () => {
  const check = await fixture();
  const other = await run("INSERT INTO kyc_checks (application_id, provider, session_ref) VALUES (?, 'YOUVERIFY', ?)", [check.application_id, `youverify_sandbox_${crypto.randomUUID()}`]);
  const second = await get('SELECT * FROM kyc_checks WHERE id = ?', [other.lastInsertRowid]);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveKycRequest(i % 2 ? check : second, 'sandbox', 'nin')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rows = await all('SELECT * FROM kyc_provider_requests WHERE application_id = ?', [check.application_id]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('12345678901'), false);
});

test('chargeable 404 is recorded once and repeated clicks never reach provider', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 404, json: async () => ({ success: false, data: { id: 'yv-not-found-ref' } }) }; };
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502);
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
  assert.equal(calls, 1);
  const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
  assert.equal(row.state, 'UNKNOWN'); assert.equal(row.provider_status, 404);
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
  delete process.env.YOUVERIFY_SECRET_KEY;
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 503);
  process.env.YOUVERIFY_SECRET_KEY = 'test-only';
  assert.equal((await get('SELECT attempt_count FROM kyc_checks WHERE id = ?', [check.id])).attempt_count, 0);
});

test('live access requires authorisation, product approval and valid cost settings', async () => {
  assert.throws(() => requireKycAccess('live', 'bvn'), e => e.status === 503);
  process.env.YOUVERIFY_PRODUCTION_AUTHORIZED = 'true';
  process.env.YOUVERIFY_APPROVED_PRODUCTS = 'bvn';
  assert.throws(() => requireKycAccess('live', 'bvn'), e => e.status === 503);
  process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = '2';
  process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '1500';
  process.env.YOUVERIFY_BVN_MAX_COST_KOBO = '1000';
  assert.throws(() => requireKycAccess('live', 'nin'), e => e.status === 503);
  const one = await fixture();
  const id = await reserveKycRequest(one, 'live', 'bvn');
  await finishKycRequest(id, 'NOT_FOUND', 404);
  await assert.rejects(reserveKycRequest(await fixture(), 'live', 'bvn'), e => e.status === 429);
  assert.equal(Number((await get('SELECT reserved_kobo FROM kyc_provider_requests WHERE id = ?', [id])).reserved_kobo), 1000);
  process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000';
  await reserveKycRequest(await fixture(), 'live', 'bvn');
  await assert.rejects(reserveKycRequest(await fixture(), 'live', 'bvn'), e => e.status === 429);
  delete process.env.YOUVERIFY_PRODUCTION_AUTHORIZED;
});

test('successful match remains idempotent and raw identities are not persisted', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'yv-match-ref', status: 'found', firstName: 'Test', lastName: 'Person', dateOfBirth: '1990-01-01', idNumber: request.body.id_number } }) }; };
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


test('provider tracking rejects unsafe, conflicting and identity-like values', () => {
  for (const value of [123, {}, '', 'a'.repeat(129), 'bad\nref', '12345678901', 'ref-12345678901']) {
    assert.deepEqual(providerReference({ data: { id: value } }), { reference: null, status: 'INVALID' });
  }
  assert.equal(providerReference({ id: 'submitted-identity', metadata: { requestId: 'local-uuid' } }).status, 'MISSING');
  assert.equal(providerReference({ entity: { id: 'ignored' } }).status, 'MISSING');
  assert.deepEqual(providerReference({ data: { id: 'yv-report:abc_123' } }), { reference: 'yv-report:abc_123', status: 'CAPTURED' });
});

test('success and chargeable errors retain only provider reference metadata', async () => {
  for (const status of [200, 404, 500]) {
    const check = await fixture();
    const ref = `provider-ref-${status}`;
    globalThis.fetch = async () => ({ ok: status === 200, status, json: async () => ({ success: true, data: { id: ref, status: 'found', firstName: 'Test', lastName: 'Person', dateOfBirth: '1990-01-01', idNumber: request.body.id_number, photo: 'PRIVATE-PHOTO' } }) });
    let publicBody;
    try { await verify(request, { json: (_status, body) => { publicBody = body; } }, { ref: check.session_ref }); } catch (error) { assert.ok(status !== 200); }
    const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
    const metadata = await get('SELECT * FROM kyc_provider_references WHERE request_id = ?', [row.id]);
    assert.equal(metadata.reference_id, ref);
    assert.equal(metadata.reference_status, 'CAPTURED');
    assert.equal(row.provider_status, status);
    assert.equal(row.state, status === 200 ? 'MATCH' : 'UNKNOWN');
    assert.equal(JSON.stringify({row, metadata, publicBody}).includes(request.body.id_number), false);
    assert.equal(JSON.stringify(metadata).includes('PRIVATE-PHOTO'), false);
    assert.equal(JSON.stringify(publicBody || {}).includes(ref), false);
  }
});

test('missing, invalid and unreadable references remain blocked beyond 24 hours', async () => {
  for (const body of [{}, { data: { id: request.body.id_number } }, null]) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => { if (body === null) throw new Error('private payload'); return body; } }; };
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502);
    const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
    assert.equal(row.state, 'UNKNOWN');
    assert.equal(row.provider_status, 200);
    const metadata = await get('SELECT * FROM kyc_provider_references WHERE request_id = ?', [row.id]);
    assert.equal(metadata.reference_id, null);
    await run('UPDATE kyc_provider_requests SET started_ms = ? WHERE id = ?', [Date.now() - 172800000, row.id]);
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
    assert.equal(calls, 1);
  }
});

test('migration is repeatable and preserves reconciliation metadata', async () => {
  const before = await all('SELECT * FROM kyc_provider_references ORDER BY request_id');
  await migrate(); await migrate();
  assert.deepEqual(await all('SELECT * FROM kyc_provider_references ORDER BY request_id'), before);
});


test('reference alone is not a valid success and cannot unblock another billable request', async () => {
  for (const body of [{ success: true, data: { id: 'ref-only' } }, { data: { id: 'ref-only', status: 'found' } }, { success: true, data: { id: 'ref-only', status: 'pending' } }]) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => body }; };
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502);
    const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
    assert.equal(row.state, 'UNKNOWN');
    assert.equal(row.provider_status, 200);
    assert.equal((await get('SELECT * FROM kyc_provider_references WHERE request_id = ?', [row.id])).reference_id, 'ref-only');
    await run('UPDATE kyc_provider_requests SET started_ms = ? WHERE id = ?', [Date.now() - 172800000, row.id]);
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
    assert.equal(calls, 1);
  }
});
