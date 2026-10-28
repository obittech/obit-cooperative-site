import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-yv-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.KYC_PROVIDER = 'YOUVERIFY';
process.env.YOUVERIFY_ENV = 'sandbox';
process.env.YOUVERIFY_SECRET_KEY = 'sandbox-test-secret';
const { migrate, get, run, all, closeDatabase } = await import('../src/db.js');
const { kycRouter } = await import('../src/routes/kyc.js');
const { requireKycAccess, reserveKycRequest } = await import('../src/services/kyc-cost-controls.js');
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

test('provider switching cannot bypass pending reconciliation or consent', async () => {
  const check = await fixture();
  await reserveKycRequest(check, 'sandbox', 'nin', 'YOUVERIFY');
  process.env.DOJAH_APP_ID = 'test'; process.env.DOJAH_SECRET_KEY = 'test';
  await assert.rejects(reserveKycRequest(check, 'sandbox', 'bvn', 'DOJAH'), e => e.status === 409);
  const other = await fixture();
  await run("INSERT INTO consents (application_id, type, accepted) VALUES (?, 'privacy', 0)", [other.application_id]);
  await assert.rejects(verify(request, response, { ref: other.session_ref }), e => e.status === 409);
});

test('live gates use Youverify approval and costs, independently from Dojah', () => {
  process.env.DOJAH_PRODUCTION_AUTHORIZED = 'true';
  assert.throws(() => requireKycAccess('live', 'nin', 'YOUVERIFY'), e => e.status === 503);
  process.env.YOUVERIFY_PRODUCTION_AUTHORIZED = 'true';
  process.env.YOUVERIFY_APPROVED_PRODUCTS = 'nin';
  assert.throws(() => requireKycAccess('live', 'nin', 'YOUVERIFY'), e => e.status === 503);
  process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = '5';
  process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000';
  process.env.YOUVERIFY_NIN_MAX_COST_KOBO = '1000';
  requireKycAccess('live', 'nin', 'YOUVERIFY');
  assert.throws(() => requireKycAccess('live', 'bvn', 'YOUVERIFY'), e => e.status === 503);
  delete process.env.YOUVERIFY_PRODUCTION_AUTHORIZED;
});

test('name substrings and absent, invalid or mismatched DOB never verify', () => {
  const app = { full_legal_name: 'Test Person', date_of_birth: '1990-01-01' };
  for (const entity of [{ ...report.data, firstName: 'Tes' }, { ...report.data, dateOfBirth: '' }, { ...report.data, dateOfBirth: '1990-02-30' }, { ...report.data, dateOfBirth: '1991-01-01' }]) {
    assert.equal(youverifyMatch(app, entity).matched, false);
  }
});
