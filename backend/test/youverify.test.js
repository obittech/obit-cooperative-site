import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-yv-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.YOUVERIFY_ENV = 'sandbox';
process.env.YOUVERIFY_SECRET_KEY = 'sandbox-test-secret';
const { migrate, get, run, all, closeDatabase } = await import('../src/db.js');
const { kycRouter } = await import('../src/routes/kyc.js');
const { requireKycAccess, reserveKycRequest, sandboxRequestStatus } = await import('../src/services/kyc-cost-controls.js');
const { youverifyMatch } = await import('../src/services/youverify.js');
await migrate();
after(async () => { await closeDatabase(); fs.rmSync(temp, { recursive: true, force: true }); });
const verify = kycRouter.match('POST', '/api/kyc/session/test/verify').handlers[0];
const start = kycRouter.match('POST', '/api/kyc/session').handlers[0];
const request = { body: { type: 'nin', id_number: '11111111111' } };
const response = { json: (status, body) => ({ status, body }) };
async function fixture() {
  const app = await run("INSERT INTO member_applications (full_legal_name, date_of_birth, status) VALUES ('Test Person', '1990-01-01', 'APPLICATION_SUBMITTED')");
  for (const type of ['terms', 'privacy']) await run('INSERT INTO consents (application_id, type, accepted) VALUES (?, ?, 1)', [app.lastInsertRowid, type]);
  let session;
  await start({ body: { application_id: app.lastInsertRowid } }, { json: (_status, body) => { session = body; } });
  assert.equal(session.provider, 'YOUVERIFY');
  return get('SELECT * FROM kyc_checks WHERE session_ref = ?', [session.session_ref]);
}
const report = { success: true, data: { id: '6491edda239381d3be87a5fb', status: 'found', firstName: 'Test', lastName: 'Person', dateOfBirth: '1990-01-01', idNumber: '11111111111', image: 'PRIVATE' } };

test('sandbox NIN and BVN use documented POST, consent, token and report ID with no extra products', async () => {
  for (const type of ['nin', 'bvn']) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, `https://api.sandbox.youverify.co/v2/api/identity/ng/${type}`);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.token, 'sandbox-test-secret');
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['id', 'isSubjectConsent', 'metadata']);
      assert.equal(body.isSubjectConsent, true);
      assert.equal(body.id, request.body.id_number);
      assert.ok(body.metadata.requestId);
      return { ok: true, status: 200, json: async () => report };
    };
    let result;
    await verify({ body: { ...request.body, type } }, { json: (_status, body) => { result = body; } }, { ref: check.session_ref });
    assert.equal(result.status, 'KYC_VERIFIED');
    await verify(request, response, { ref: check.session_ref });
    assert.equal(calls, 1);
    const ledger = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
    assert.equal(ledger.state, 'MATCH');
    const ref = await get('SELECT * FROM kyc_provider_references WHERE request_id = ?', [ledger.id]);
    assert.equal(ref.reference_id, report.data.id);
    const persisted = JSON.stringify({ ledger, ref, checks: await all('SELECT * FROM kyc_checks'), audit: await all('SELECT * FROM audit_events') });
    assert.equal(persisted.includes(request.body.id_number), false);
    assert.equal(persisted.includes('PRIVATE'), false);
  }
});

test('pending, malformed, missing references, HTTP errors and timeouts stay unresolved and cannot retry', async () => {
  for (const variant of ['pending', 'missing', 'error', 'parse', 'timeout']) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (variant === 'timeout') throw new Error('private');
      return { ok: variant !== 'error', status: variant === 'error' ? 500 : 200, json: async () => {
        if (variant === 'parse') throw new Error('private');
        return { ...report, data: { ...report.data, ...(variant === 'pending' ? { status: 'pending' } : {}), ...(variant === 'missing' ? { id: undefined } : {}) } };
      } };
    };
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502);
    const row = await get('SELECT * FROM kyc_provider_requests WHERE check_id = ?', [check.id]);
    assert.equal(row.state, 'UNKNOWN');
    await run('UPDATE kyc_provider_requests SET started_ms = ? WHERE id = ?', [Date.now() - 172800000, row.id]);
    await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
    assert.equal(calls, 1);
  }
});

test('pending reconciliation and withdrawn consent prevent dispatch', async () => {
  const check = await fixture();
  await reserveKycRequest(check, 'sandbox', 'nin');
  await assert.rejects(reserveKycRequest(check, 'sandbox', 'bvn'), e => e.status === 409);
  const other = await fixture();
  await run("INSERT INTO consents (application_id, type, accepted) VALUES (?, 'privacy', 0)", [other.application_id]);
  await assert.rejects(verify(request, response, { ref: other.session_ref }), e => e.status === 409);
});

test('live gates require Youverify approval, approved product and cost controls', () => {
  assert.throws(() => requireKycAccess('live', 'nin'), e => e.status === 503);
  process.env.YOUVERIFY_PRODUCTION_AUTHORIZED = 'true';
  process.env.YOUVERIFY_APPROVED_PRODUCTS = 'nin';
  assert.throws(() => requireKycAccess('live', 'nin'), e => e.status === 503);
  process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = '5';
  process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000';
  process.env.YOUVERIFY_NIN_MAX_COST_KOBO = '1000';
  requireKycAccess('live', 'nin');
  assert.throws(() => requireKycAccess('live', 'bvn'), e => e.status === 503);
  delete process.env.YOUVERIFY_PRODUCTION_AUTHORIZED;
});

test('name substrings and absent, invalid or mismatched DOB never verify', () => {
  const app = { full_legal_name: 'Test Person', date_of_birth: '1990-01-01' };
  for (const entity of [{ ...report.data, firstName: 'Tes' }, { ...report.data, dateOfBirth: '' }, { ...report.data, dateOfBirth: '1990-02-30' }, { ...report.data, dateOfBirth: '1991-01-01' }]) {
    assert.equal(youverifyMatch(app, entity).matched, false);
  }
});

const statusHandler = kycRouter.match('GET', '/api/kyc/test/status').handlers[0];

test('sandbox status exposes only saved receipt metadata and never dispatches another call', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 401, json: async () => ({ success: false, message: 'PRIVATE-DETAIL', data: {} }) };
  };
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 502);
  let status;
  await statusHandler({}, { json: (_code, body) => { status = body; } }, { id: check.session_ref });
  assert.deepEqual(status.sandbox_request, { state: 'UNKNOWN', provider_http_status: 401, reference_status: 'MISSING' });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(status).includes('PRIVATE-DETAIL'), false);
  assert.equal(JSON.stringify(status).includes(process.env.YOUVERIFY_SECRET_KEY), false);
  assert.equal(JSON.stringify(status).includes(request.body.id_number), false);
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
  assert.equal(calls, 1);
});

test('sandbox receipt diagnostics exclude live deployments, live checks and retired providers', async () => {
  const check = await fixture();
  assert.equal(await sandboxRequestStatus(check, 'live'), null);
  assert.equal(await sandboxRequestStatus({ ...check, session_ref: 'youverify_live_test' }, 'sandbox'), null);
  assert.equal(await sandboxRequestStatus({ ...check, provider: 'RETIRED_PROVIDER' }, 'sandbox'), null);
  assert.equal(await sandboxRequestStatus(check, 'sandbox'), null);
});

async function retiredFixture() {
  const check = await fixture();
  const ref = `retired_sandbox_${crypto.randomUUID()}`;
  await run("UPDATE kyc_checks SET provider = 'RETIRED_PROVIDER', session_ref = ? WHERE id = ?", [ref, check.id]);
  return { ...check, provider: 'RETIRED_PROVIDER', session_ref: ref };
}

test('retired sessions cannot dispatch and status offers a new Youverify session', async () => {
  const check = await retiredFixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not dispatch'); };
  await assert.rejects(verify(request, response, { ref: check.session_ref }), e => e.status === 409);
  let status;
  await statusHandler({}, { json: (_code, body) => { status = body; } }, { id: check.session_ref });
  assert.equal(status.restart_required, true);
  let fresh;
  await start({ body: { application_id: check.application_id } }, { json: (_code, body) => { fresh = body; } });
  assert.equal(fresh.provider, 'YOUVERIFY');
  assert.ok(fresh.session_ref.startsWith('youverify_sandbox_'));
  assert.equal((await get('SELECT provider FROM kyc_checks WHERE id = ?', [check.id])).provider, 'RETIRED_PROVIDER');
  assert.equal(calls, 0);
});

test('retired unresolved requests block new sessions and retain their history', async () => {
  const check = await retiredFixture();
  const id = crypto.randomUUID();
  await run("INSERT INTO kyc_provider_requests (id, application_id, check_id, environment, product, state, reserved_kobo, started_ms) VALUES (?, ?, ?, 'sandbox', 'nin', 'UNKNOWN', 0, ?)", [id, check.application_id, check.id, Date.now() - 172800000]);
  await assert.rejects(start({ body: { application_id: check.application_id } }, response), e => e.status === 409);
  assert.equal((await get('SELECT state FROM kyc_provider_requests WHERE id = ?', [id])).state, 'UNKNOWN');
});

test('readiness reports Youverify configuration without secret values', async () => {
  const { systemRouter } = await import('../src/routes/system.js');
  const handler = systemRouter.match('GET', '/api/readiness').handlers[0];
  let body;
  await handler({}, { json: (_code, value) => { body = value; } });
  assert.equal(body.youverify.provider, 'YOUVERIFY');
  assert.equal(body.youverify.environment, 'sandbox');
  assert.equal(body.youverify.configured, true);
  assert.equal(body.youverify.production_authorized, false);
  assert.equal(JSON.stringify(body).includes(process.env.YOUVERIFY_SECRET_KEY), false);
});
