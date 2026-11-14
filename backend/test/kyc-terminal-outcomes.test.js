import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notFoundMessage } from '../src/services/kyc-status-message.js';

test('retry wording follows the inclusive 24-hour boundary and handles missing dates safely', () => {
  const started = Date.parse('2026-11-11T11:15:00Z');
  const until = started + 86400000;
  for (const now of [started, until - 1, until]) {
    assert.match(notFoundMessage(started, now), /ends after 2026-11-12T11:15:00.000Z/);
  }
  assert.match(notFoundMessage(String(started), until + 1), /has ended/);
  assert.doesNotMatch(notFoundMessage(started, until + 1), /cannot be retried|ends after/);
  for (const invalid of [null, undefined, '', 'bad', -1, Infinity, 8640000000000000]) {
    assert.match(notFoundMessage(invalid, until), /check the previous request/);
  }
});

// Every provider response is synthetic. Never send an identity request in tests.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected provider call in test'); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'obit-terminal-kyc-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.AUTH_TOKEN_SECRET = 'synthetic-terminal-kyc-only';
process.env.YOUVERIFY_ENV = 'live';
process.env.YOUVERIFY_SECRET_KEY = 'synthetic-terminal-provider-secret';
process.env.YOUVERIFY_PRODUCTION_AUTHORIZED = 'true';
process.env.YOUVERIFY_APPROVED_PRODUCTS = 'nin,bvn';
process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = '10000';
process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000000';
process.env.YOUVERIFY_NIN_MAX_COST_KOBO = '12500';
process.env.YOUVERIFY_BVN_MAX_COST_KOBO = '7500';
const { migrate, get, run, all, DB_ENGINE, closeDatabase } = await import('../src/db.js');
const { kycRouter } = await import('../src/routes/kyc.js');
const { authorizedFixtureHandler } = await import('./helpers/application-session.js');
await migrate();
after(async () => {
  globalThis.fetch = originalFetch;
  await closeDatabase();
  fs.rmSync(temp, { recursive: true, force: true });
});
const verify = authorizedFixtureHandler(kycRouter, 'POST', '/api/kyc/session/test/verify');
const status = authorizedFixtureHandler(kycRouter, 'GET', '/api/kyc/test/status');
const start = authorizedFixtureHandler(kycRouter, 'POST', '/api/kyc/session');
const idNumber = '11111111111';
const providerId = '6491edda239381d3be87a5fb';
const report = {
  success: true,
  message: 'PRIVATE-PROVIDER-MESSAGE',
  data: {
    id: providerId, status: 'not_found', idNumber,
    firstName: 'Synthetic', lastName: 'Person', dateOfBirth: '1990-01-01',
    image: 'PRIVATE-PHOTO', address: 'PRIVATE-ADDRESS',
  },
};
const response = (body = report, http = 200) => ({ ok: http >= 200 && http < 300, status: http, json: async () => body });
const request = (type = 'nin') => ({ body: { type, id_number: idNumber } });
const res = { json: (status, body) => ({ status, body }) };
async function invoke(handler, req, params) {
  let result;
  await handler(req, { json: (status, body) => { result = { status, body }; } }, params);
  return result;
}
const call = (check, type = 'nin') => invoke(verify, request(type), { ref: check.session_ref });
const readStatus = check => invoke(status, {}, { id: check.session_ref });
const rejected = (promise, code) => assert.rejects(promise, error => error.status === code);
async function fixture(initialStatus = 'KYC_PENDING') {
  const app = await run("INSERT INTO member_applications (full_legal_name, date_of_birth, status) VALUES ('Synthetic Person', '1990-01-01', ?)", [initialStatus]);
  for (const type of ['terms', 'privacy']) await run('INSERT INTO consents (application_id, type, accepted) VALUES (?, ?, 1)', [app.lastInsertRowid, type]);
  const check = await run("INSERT INTO kyc_checks (application_id, provider, session_ref, status, raw_status_detail) VALUES (?, 'YOUVERIFY', ?, ?, ?)", [app.lastInsertRowid, `youverify_live_${crypto.randomUUID()}`, initialStatus, JSON.stringify({ environment: 'live' })]);
  return get('SELECT * FROM kyc_checks WHERE id = ?', [check.lastInsertRowid]);
}
const receipt = check => get('SELECT * FROM kyc_provider_requests WHERE check_id = ? ORDER BY started_ms DESC, id DESC LIMIT 1', [check.id]);
const audits = check => all("SELECT * FROM audit_events WHERE entity_id = ? AND action = 'KYC_NOT_FOUND'", [check.application_id]);
const age = row => run('UPDATE kyc_provider_requests SET started_ms = ? WHERE id = ?', [Date.now() - 172800000, row.id]);

test('aged NOT_FOUND status explains elapsed wait without dispatching or changing records', async () => {
  const check = await fixture();
  globalThis.fetch = async () => response();
  await call(check);
  await age(await receipt(check));
  const before = await receipt(check);
  const beforeCheck = await get('SELECT * FROM kyc_checks WHERE id = ?', [check.id]);
  const beforeAudit = await audits(check);
  globalThis.fetch = async () => { throw new Error('Read-only status must not dispatch'); };
  for (let i = 0; i < 3; i++) {
    const result = await readStatus(check);
    assert.equal(result.body.status, 'KYC_PENDING');
    assert.equal(result.body.outcome, 'NOT_FOUND');
    assert.match(result.body.message, /has ended/);
    assert.match(result.body.message, /Other verification limits still apply/);
  }
  assert.deepEqual(await receipt(check), before);
  assert.deepEqual(await get('SELECT * FROM kyc_checks WHERE id = ?', [check.id]), beforeCheck);
  assert.deepEqual(await audits(check), beforeAudit);
});

test('exact terminal not_found persists KYC_PENDING, safe outcome, audit and all costs for NIN/BVN', async () => {
  for (const type of ['nin', 'bvn']) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, `https://api.youverify.co/v2/api/identity/ng/${type}`);
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).id, idNumber);
      return response();
    };
    const result = await call(check, type);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'KYC_PENDING');
    assert.equal(result.body.outcome, 'NOT_FOUND');
    assert.match(result.body.message, /24-hour/);
    assert.equal(result.body.sandbox_match, undefined);
    const row = await receipt(check);
    assert.equal(row.state, 'NOT_FOUND');
    assert.equal(row.provider_status, 200);
    assert.equal(Number(row.reserved_kobo), type === 'nin' ? 12500 : 7500);
    assert.ok(Number(row.finished_ms) >= Number(row.started_ms));
    const savedCheck = await get('SELECT * FROM kyc_checks WHERE id = ?', [check.id]);
    assert.equal(savedCheck.status, 'KYC_PENDING');
    assert.equal(savedCheck.verified_at, null);
    assert.equal(savedCheck.attempt_count, 1);
    assert.ok(savedCheck.last_attempt_at);
    assert.deepEqual(JSON.parse(savedCheck.raw_status_detail), { environment: 'live', outcome: 'NOT_FOUND', id_type: type });
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [check.application_id])).status, 'KYC_PENDING');
    const history = await audits(check);
    assert.equal(history.length, 1);
    assert.equal(JSON.parse(history[0].detail_json).requestId, row.id);
    assert.equal(JSON.parse(history[0].detail_json).potentiallyBillable, true);
    const tracking = await get('SELECT * FROM kyc_provider_references WHERE request_id = ?', [row.id]);
    assert.equal(tracking.reference_id, providerId);
    assert.equal(tracking.reference_status, 'CAPTURED');
    const restored = await readStatus(check);
    assert.equal(restored.body.status, 'KYC_PENDING');
    assert.equal(restored.body.outcome, 'NOT_FOUND');
    assert.equal(restored.body.message, result.body.message);
    assert.equal(restored.body.sandbox_request, undefined);
    const publicData = JSON.stringify([result, restored]);
    assert.equal(publicData.includes(providerId), false);
    const persisted = JSON.stringify([row, savedCheck, history, tracking, result, restored]);
    for (const privateValue of [idNumber, 'PRIVATE-PROVIDER-MESSAGE', 'PRIVATE-PHOTO', 'PRIVATE-ADDRESS', process.env.YOUVERIFY_SECRET_KEY]) {
      assert.equal(persisted.includes(privateValue), false, privateValue);
    }
    // Restore the existing session and repeated clicks must not issue a charge.
    await start({ body: { application_id: check.application_id } }, res);
    await rejected(call(check, type), 409);
    assert.equal(calls, 1);
    assert.deepEqual(await receipt(check), row);
    assert.equal((await audits(check)).length, 1);
  }
});

test('a terminal negative lookup is not a matching failure, including a previous failed check', async () => {
  const check = await fixture('KYC_FAILED');
  globalThis.fetch = async () => response();
  assert.equal((await call(check)).body.status, 'KYC_PENDING');
  assert.equal((await get('SELECT status FROM kyc_checks WHERE id = ?', [check.id])).status, 'KYC_PENDING');
  assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [check.application_id])).status, 'KYC_PENDING');
  assert.equal(Number((await get("SELECT COUNT(*) AS n FROM audit_events WHERE entity_id = ? AND action IN ('KYC_FAILED', 'KYC_VERIFIED')", [check.application_id])).n), 0);
});

test('unconfirmed, malformed, pending and HTTP-error not_found responses remain UNKNOWN indefinitely', async () => {
  const variants = [
    ['missing reference', { ...report, data: { status: 'not_found' } }],
    ['invalid reference', { ...report, data: { ...report.data, id: idNumber } }],
    ['missing success', { data: report.data }],
    ['false success', { ...report, success: false }],
    ['string success', { ...report, success: 'true' }],
    ['missing data', { success: true }],
    ['pending', { ...report, data: { ...report.data, status: 'pending' } }],
    ['unknown', { ...report, data: { ...report.data, status: 'unknown' } }],
    ['failed alias', { ...report, data: { ...report.data, status: 'failed' } }],
    ['uppercase alias', { ...report, data: { ...report.data, status: 'NOT_FOUND' } }],
    ['space alias', { ...report, data: { ...report.data, status: 'not found' } }],
    ['message only', { ...report, message: 'not_found', data: { id: providerId } }],
    ['unreadable', null, 200, 'parse'],
    ['timeout', null, null, 'timeout'],
    ...[201, 202, 204, 400, 401, 403, 404, 429, 500, 503].map(http => [`HTTP ${http}`, report, http]),
  ];
  for (const [label, body, http = 200, mode] of variants) {
    const check = await fixture(); let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (mode === 'timeout') throw new Error('PRIVATE-TIMEOUT-DETAIL');
      if (mode === 'parse') return { ok: true, status: http, json: async () => { throw new Error('PRIVATE-PARSE-DETAIL'); } };
      return response(body, http);
    };
    await rejected(call(check), 502);
    const row = await receipt(check);
    assert.equal(row.state, 'UNKNOWN', label);
    assert.equal(Number(row.reserved_kobo), 12500);
    assert.equal((await audits(check)).length, 0);
    await age(row);
    await rejected(call(check), 409);
    await rejected(call(check, 'bvn'), 409);
    assert.equal(calls, 1, label);
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [check.application_id])).status, 'KYC_PENDING');
    const restored = await readStatus(check);
    assert.equal(restored.body.outcome, undefined);
    assert.equal(JSON.stringify(restored).includes('PRIVATE'), false);
  }
});

test('same-product 24-hour guard spans sessions; terminal outcome permits only later explicit requests', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  await call(check);
  const first = await receipt(check);
  const secondId = (await run("INSERT INTO kyc_checks (application_id, provider, session_ref) VALUES (?, 'YOUVERIFY', ?)", [check.application_id, `youverify_live_${crypto.randomUUID()}`])).lastInsertRowid;
  const second = await get('SELECT * FROM kyc_checks WHERE id = ?', [secondId]);
  await rejected(call(second), 409);
  assert.equal(calls, 1);
  // Explicitly requesting a different approved product is allowed, never automatic.
  await call(second, 'bvn');
  assert.equal(calls, 2);
  await age(first);
  await call(check);
  assert.equal(calls, 3);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM kyc_provider_requests WHERE application_id = ?', [check.application_id])).n), 3);
  assert.equal(Number((await get('SELECT reserved_kobo FROM kyc_provider_requests WHERE id = ?', [first.id])).reserved_kobo), 12500);
});

test('terminal not_found still consumes attempt cap, daily request limit and daily budget', async () => {
  const check = await fixture(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  await run('UPDATE kyc_checks SET attempt_count = 4 WHERE id = ?', [check.id]);
  await call(check);
  await rejected(call(check, 'bvn'), 429);
  assert.equal((await get('SELECT attempt_count FROM kyc_checks WHERE id = ?', [check.id])).attempt_count, 5);
  const usage = await get("SELECT COUNT(*) AS n, SUM(reserved_kobo) AS cost FROM kyc_provider_requests WHERE environment = 'live' AND started_ms >= ?", [Date.now() - 86400000]);
  try {
    process.env.YOUVERIFY_DAILY_BUDGET_KOBO = String(usage.cost);
    await rejected(call(await fixture()), 429);
    process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000000';
    process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = String(usage.n);
    await rejected(call(await fixture()), 429);
  } finally {
    process.env.YOUVERIFY_DAILY_REQUEST_LIMIT = '10000';
    process.env.YOUVERIFY_DAILY_BUDGET_KOBO = '10000000';
  }
  assert.equal(calls, 1);
});

async function failTerminalAudit(enabled) {
  if (DB_ENGINE === 'postgres') {
    if (enabled) {
      await run("CREATE FUNCTION test_reject_terminal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'KYC_NOT_FOUND' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$");
      await run('CREATE TRIGGER test_reject_terminal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_terminal_audit()');
    } else {
      await run('DROP TRIGGER test_reject_terminal_audit ON audit_events');
      await run('DROP FUNCTION test_reject_terminal_audit()');
    }
  } else if (enabled) {
    await run("CREATE TRIGGER test_reject_terminal_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'KYC_NOT_FOUND' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
  } else await run('DROP TRIGGER test_reject_terminal_audit');
}

test('audit failure rolls back every terminal write and retains a blocking paid request', async () => {
  const check = await fixture('KYC_FAILED'); let calls = 0;
  const originalApp = await get('SELECT * FROM member_applications WHERE id = ?', [check.application_id]);
  globalThis.fetch = async () => { calls++; return response(); };
  await failTerminalAudit(true);
  try { await assert.rejects(call(check), /synthetic audit failure/); }
  finally { await failTerminalAudit(false); }
  const row = await receipt(check);
  assert.equal(row.state, 'DISPATCHED');
  assert.equal(row.finished_ms, null);
  assert.equal(row.provider_status, 200);
  assert.equal(Number(row.reserved_kobo), 12500);
  const saved = await get('SELECT * FROM kyc_checks WHERE id = ?', [check.id]);
  assert.equal(saved.status, check.status);
  assert.equal(saved.raw_status_detail, check.raw_status_detail);
  assert.equal(saved.attempt_count, 1);
  assert.deepEqual(await get('SELECT * FROM member_applications WHERE id = ?', [check.application_id]), originalApp);
  assert.equal((await audits(check)).length, 0);
  assert.equal((await get('SELECT reference_status FROM kyc_provider_references WHERE request_id = ?', [row.id])).reference_status, 'CAPTURED');
  await rejected(call(check, 'bvn'), 409);
  assert.equal(calls, 1);
});

test('concurrent clicks while a terminal lookup is in flight dispatch and settle exactly once', async () => {
  const check = await fixture(); let calls = 0, release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async () => { calls++; entered(); await gate; return response(); };
  const attempts = Promise.allSettled(Array.from({ length: 12 }, () => call(check)));
  await started;
  release();
  const results = await attempts;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 409));
  assert.equal(calls, 1);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM kyc_provider_requests WHERE application_id = ?', [check.application_id])).n), 1);
  assert.equal((await receipt(check)).state, 'NOT_FOUND');
  assert.equal((await audits(check)).length, 1);
  assert.equal((await get('SELECT attempt_count FROM kyc_checks WHERE id = ?', [check.id])).attempt_count, 1);
});

test('a concurrent state change cannot be overwritten by the terminal outcome', async () => {
  for (const target of ['request', 'application', 'check']) {
    const check = await fixture();
    globalThis.fetch = async (_url, options) => {
      if (target === 'request') await run("UPDATE kyc_provider_requests SET state = 'UNKNOWN' WHERE id = ?", [JSON.parse(options.body).metadata.requestId]);
      if (target === 'application') await run("UPDATE member_applications SET status = 'KYC_VERIFIED' WHERE id = ?", [check.application_id]);
      if (target === 'check') await run("UPDATE kyc_checks SET status = 'KYC_VERIFIED' WHERE id = ?", [check.id]);
      return response();
    };
    await rejected(call(check), 409);
    assert.equal((await receipt(check)).state, target === 'request' ? 'UNKNOWN' : 'DISPATCHED');
    assert.equal((await audits(check)).length, 0);
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [check.application_id])).status, target === 'application' ? 'KYC_VERIFIED' : 'KYC_PENDING');
    assert.equal((await get('SELECT status FROM kyc_checks WHERE id = ?', [check.id])).status, target === 'check' ? 'KYC_VERIFIED' : 'KYC_PENDING');
  }
});

test('found still uses the name and DOB matcher, never the negative-outcome branch', async () => {
  for (const match of [true, false]) {
    const check = await fixture();
    globalThis.fetch = async () => response({ ...report, data: { ...report.data, status: 'found', dateOfBirth: match ? '1990-01-01' : '1991-01-01' } });
    const result = await call(check);
    assert.equal(result.body.status, match ? 'KYC_VERIFIED' : 'KYC_FAILED');
    assert.equal((await receipt(check)).state, match ? 'MATCH' : 'MISMATCH');
    assert.equal((await audits(check)).length, 0);
    assert.equal(result.body.outcome, undefined);
  }
});

test('status reads use the latest matching receipt, including operator-reconciled legacy failures', async () => {
  const check = await fixture();
  globalThis.fetch = async () => response();
  await call(check);
  const row = await receipt(check);
  // A reconciled request may still have the old private-safe error detail.
  await run('UPDATE kyc_checks SET raw_status_detail = ? WHERE id = ?', [JSON.stringify({ environment: 'live', outcome: 'PROVIDER_ERROR' }), check.id]);
  assert.equal((await readStatus(check)).body.outcome, 'NOT_FOUND');
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Status must not call provider'); };
  for (const state of ['DISPATCHED', 'UNKNOWN', 'MISMATCH']) {
    const id = crypto.randomUUID();
    await run("INSERT INTO kyc_provider_requests (id, application_id, check_id, environment, product, state, reserved_kobo, started_ms) VALUES (?, ?, ?, 'live', 'bvn', ?, 7500, ?)", [id, check.application_id, check.id, state, Number(row.started_ms) + 1000]);
    assert.equal((await readStatus(check)).body.outcome, undefined, state);
    await run('DELETE FROM kyc_provider_requests WHERE id = ?', [id]);
  }
  await run("UPDATE kyc_provider_requests SET environment = 'sandbox' WHERE id = ?", [row.id]);
  assert.equal((await readStatus(check)).body.outcome, undefined);
  await run("UPDATE kyc_provider_requests SET environment = 'live' WHERE id = ?", [row.id]);
  await run("UPDATE kyc_checks SET provider = 'RETIRED_PROVIDER' WHERE id = ?", [check.id]);
  assert.equal((await readStatus(check)).body.outcome, undefined);
  await run("UPDATE kyc_checks SET provider = 'YOUVERIFY', status = 'KYC_VERIFIED' WHERE id = ?", [check.id]);
  assert.equal((await readStatus(check)).body.outcome, undefined);
  assert.equal(calls, 0);
});
