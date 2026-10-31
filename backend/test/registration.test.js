import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'registration-test-only';
process.env.YOUVERIFY_ENV = 'sandbox';
process.env.YOUVERIFY_SECRET_KEY = 'test-only';
process.env.NODE_ENV = 'test';
process.env.RESEND_API_KEY = 'test-only';
process.env.WEBHOOK_SANDBOX_MODE = 'true';
process.env.WEBHOOK_SANDBOX_SECRET = 'registration-webhook-test-only';
delete process.env.PAYSTACK_SECRET_KEY;
const { migrate, run, get, all, closeDatabase } = await import('../src/db.js');
const { applicationsRouter } = await import('../src/routes/applications.js');
const { kycRouter } = await import('../src/routes/kyc.js');
const { paymentsRouter } = await import('../src/routes/payments.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { authRouter } = await import('../src/routes/auth.js');
const { issueToken } = await import('../src/utils/auth.js');
const { handlePaymentWebhook } = await import('../src/routes/webhooks.js');
await migrate();
after(closeDatabase);
let n = 0;
async function call(router, method, path, body = {}, token = '') {
  const route = router.match(method, path);
  const req = { body, socket: {}, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
async function draft() {
  const app = await call(applicationsRouter, 'POST', '/api/applications', { campaign: 'LOCAL_REGISTRATION_TEST' });
  await call(applicationsRouter, 'PATCH', `/api/applications/${app.id}`, {
    full_legal_name: 'Test Person', date_of_birth: '1990-01-01', phone: '08000000000',
    email: `registration-${++n}-${crypto.randomUUID()}@example.invalid`, address: 'Synthetic local test',
    state: 'FCT', lga: 'Abuja Municipal', membership_type: 'Individual',
  });
  return app.id;
}
const submit = id => call(applicationsRouter, 'POST', `/api/applications/${id}/submit`, { consents: { terms: true, privacy: true } });

test('submission rejects absent or invalid identity fields before KYC spending', async () => {
  for (const [field, value] of [['date_of_birth', ''], ['date_of_birth', '2025-02-30'], ['date_of_birth', '2999-01-01'], ['lga', ''], ['email', 'invalid'], ['phone', 'abc'], ['full_legal_name', 'Test']]) {
    const id = await draft();
    await call(applicationsRouter, 'PATCH', `/api/applications/${id}`, { [field]: value });
    await assert.rejects(submit(id), e => e.status === 422);
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [id])).status, 'APPLICATION_STARTED');
  }
  const id = await draft();
  await assert.rejects(call(applicationsRouter, 'POST', `/api/applications/${id}/submit`, { consents: { terms: 'false', privacy: 'false' } }), e => e.status === 422);
});

test('repeat submission is idempotent and cannot reset KYC or active membership', async () => {
  const id = await draft();
  await submit(id);
  await submit(id);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM consents WHERE application_id = ?', [id])).n), 3);
  for (const status of ['KYC_PENDING', 'KYC_VERIFIED', 'PAYMENT_PENDING', 'UNDER_REVIEW', 'ACTIVE']) {
    await run('UPDATE member_applications SET status = ? WHERE id = ?', [status, id]);
    await assert.rejects(submit(id), e => e.status === 409);
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [id])).status, status);
  }
});

test('registration through KYC, signed payment, approval and portal login', async () => {
  const id = await draft();
  await assert.rejects(call(authRouter, 'POST', '/api/auth/request-portal-setup', { identifier: (await get('SELECT email FROM member_applications WHERE id = ?', [id])).email }), e => e.status === 409);
  await submit(id);
  const session = await call(kycRouter, 'POST', '/api/kyc/session', { application_id: id });
  const resumed = await call(kycRouter, 'POST', '/api/kyc/session', { application_id: id });
  assert.equal(resumed.session_ref, session.session_ref);
  assert.deepEqual(session.available_products, ['nin', 'bvn']);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM kyc_checks WHERE application_id = ?', [id])).n), 1);
  let providerCalls = 0;
  let setupCode;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.sandbox.youverify.co/')) {
      providerCalls++;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: `local-report-${crypto.randomUUID()}`, status: 'found', firstName: 'Test', lastName: 'Person', dateOfBirth: '1990-01-01' } }) };
    }
    assert.equal(String(url), 'https://api.resend.com/emails');
    setupCode = JSON.parse(options.body).html.match(/>(\d{6})</)[1];
    return { ok: true };
  };
  try {
    const verified = await call(kycRouter, 'POST', `/api/kyc/session/${session.session_ref}/verify`, { type: 'nin', id_number: '11111111111' });
    assert.equal(verified.status, 'KYC_VERIFIED');
    await call(kycRouter, 'POST', `/api/kyc/session/${session.session_ref}/verify`, { type: 'nin', id_number: '11111111111' });
    assert.equal(providerCalls, 1);
    const payment = await call(paymentsRouter, 'POST', '/api/payments/membership/initialize', { application_id: id, provider: 'paystack' });
    const raw = JSON.stringify({ reference: payment.reference, amount: Math.round(payment.amount * 100), currency: 'NGN', status: 'success' });
    const req = Readable.from([raw]);
    req.headers = { 'x-sandbox-signature': crypto.createHmac('sha256', process.env.WEBHOOK_SANDBOX_SECRET).update(raw).digest('hex') };
    await handlePaymentWebhook(req, { json() {} }, { provider: 'paystack' });
    assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [id])).status, 'UNDER_REVIEW');
    const adminRow = await run("INSERT INTO users (email,role,status) VALUES (?, 'admin', 'ACTIVE')", [`admin-${crypto.randomUUID()}@example.invalid`]);
    const admin = await get('SELECT * FROM users WHERE id = ?', [adminRow.lastInsertRowid]);
    const approved = await call(adminRouter, 'POST', `/api/admin/applications/${id}/decision`, { decision: 'APPROVE' }, issueToken(admin));
    assert.equal(approved.application.status, 'ACTIVE');
    assert.ok(approved.member.member_code);
    await assert.rejects(call(adminRouter, 'POST', `/api/admin/applications/${id}/decision`, { decision: 'APPROVE' }, issueToken(admin)), e => e.status === 409);
    const setup = await call(authRouter, 'POST', '/api/auth/request-portal-setup', { identifier: approved.application.email });
    await call(authRouter, 'POST', '/api/auth/set-password', { user_id: setup.user_id, setup_code: setupCode, password: 'Local-test-password-only!' });
    const login = await call(authRouter, 'POST', '/api/auth/login', { identifier: approved.application.email, password: 'Local-test-password-only!' });
    assert.equal(login.role, 'member');
    assert.ok(login.token);
    const codeLogin = await call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code.toLowerCase(), password: 'Local-test-password-only!' });
    assert.equal(codeLogin.role, 'member');
    assert.ok(codeLogin.token);
    await assert.rejects(call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code, password: 'Wrong-password!' }), e => e.status === 401);
    await run("UPDATE members SET status='SUSPENDED' WHERE id=?", [approved.member.id]);
    await assert.rejects(call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code, password: 'Local-test-password-only!' }), e => e.status === 401);
    await run("UPDATE members SET status='ACTIVE' WHERE id=?", [approved.member.id]);
    const receipts = await all('SELECT * FROM kyc_provider_requests WHERE application_id = ?', [id]);
    assert.equal(JSON.stringify(receipts).includes('11111111111'), false);
  } finally { globalThis.fetch = originalFetch; }
});
