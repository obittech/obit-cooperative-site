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
const { meRouter } = await import('../src/routes/me.js');
const { issueToken } = await import('../src/utils/auth.js');
const { handlePaymentWebhook } = await import('../src/routes/webhooks.js');
const { fixtureApplicationToken } = await import('./helpers/application-session.js');
await migrate();
after(closeDatabase);
let n = 0;
async function call(router, method, path, body = {}, token = '') {
  const route = router.match(method, path);
  if (!token) token = await fixtureApplicationToken(path, body, route.params);
  const req = { body, socket: {}, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
async function draft() {
  // PostgreSQL CI deliberately reruns this suite against the same database.
  // Fresh emails alone do not isolate accounts, which also match by phone.
  let phone;
  do { phone = `080${crypto.randomInt(10000000, 99999999)}`; }
  while (await get('SELECT id FROM member_applications WHERE phone = ?', [phone])
    || await get('SELECT id FROM users WHERE phone = ?', [phone]));
  const app = await call(applicationsRouter, 'POST', '/api/applications', { campaign: 'LOCAL_REGISTRATION_TEST' });
  await call(applicationsRouter, 'PATCH', `/api/applications/${app.id}`, {
    full_legal_name: 'Test Person', date_of_birth: '1990-01-01', phone,
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
    const setupUsername = `legacy${crypto.randomBytes(6).toString('hex')}`;
    await call(authRouter, 'POST', '/api/auth/set-password', { user_id: setup.user_id, setup_code: setupCode, password: 'Local-test-password-only!', username: setupUsername });
    assert.equal((await call(authRouter, 'POST', '/api/auth/login', {identifier: setupUsername, password: 'Local-test-password-only!'})).role, 'member');
    const login = await call(authRouter, 'POST', '/api/auth/login', { identifier: approved.application.email, password: 'Local-test-password-only!' });
    assert.equal(login.role, 'member');
    assert.ok(login.token);
    const codeLogin = await call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code.toLowerCase(), password: 'Local-test-password-only!' });
    assert.equal(codeLogin.role, 'member');
    assert.ok(codeLogin.token);
    assert.equal((await call(meRouter, 'GET', '/api/me/membership', {}, codeLogin.token)).member_code, approved.member.member_code);
    await assert.rejects(call(meRouter, 'GET', '/api/me/statement'), e => e.status === 401);
    await assert.rejects(call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code, password: 'Wrong-password!' }), e => e.status === 401);
    await run("UPDATE members SET status='SUSPENDED' WHERE id=?", [approved.member.id]);
    await assert.rejects(call(meRouter, 'GET', '/api/me/statement', {}, codeLogin.token), e => e.status === 403);
    await assert.rejects(call(authRouter, 'POST', '/api/auth/login', { identifier: approved.member.member_code, password: 'Local-test-password-only!' }), e => e.status === 401);
    await run("UPDATE members SET status='ACTIVE' WHERE id=?", [approved.member.id]);
    const receipts = await all('SELECT * FROM kyc_provider_requests WHERE application_id = ?', [id]);
    assert.equal(JSON.stringify(receipts).includes('11111111111'), false);
  } finally { globalThis.fetch = originalFetch; }
});

const { membershipTransfersRouter } = await import('../src/routes/membership-transfers.js');
const { verifyPassword } = await import('../src/utils/auth.js');
function loginRegistration(overrides = {}) {
  return { full_legal_name: 'Synthetic Login Member', date_of_birth: '1990-01-01', phone: `080${crypto.randomInt(10000000,99999999)}`,
    email: `login-${crypto.randomUUID()}@example.invalid`, address: 'Synthetic test address', state: 'FCT', lga: 'Abuja Municipal', membership_type: 'Individual',
    username: `user${crypto.randomBytes(7).toString('hex')}`, password: 'Synthetic-test-only-Password!', password_confirmation: 'Synthetic-test-only-Password!', ...overrides };
}
const registerLogin = body => call(applicationsRouter, 'POST', '/api/applications/register', body);

test('registration credentials are private, username is reserved, and login works immediately after approval', async () => {
  process.env.MARKET_TRANSFER_ENABLED = 'true';
  process.env.MARKET_TRANSFER_BANK_NAME = 'Synthetic Bank';
  process.env.MARKET_TRANSFER_ACCOUNT_NAME = 'Synthetic Account';
  process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
  const input = loginRegistration();
  const a = await registerLogin({ ...input, username: input.username.toUpperCase() });
  assert.equal(a.username, input.username);
  assert.equal(a.has_login_credentials, true);
  assert.equal(JSON.stringify(a).includes(input.password), false);
  const stored = await get('SELECT * FROM registration_credentials WHERE application_id=?', [a.id]);
  assert.notEqual(stored.password_hash, input.password);
  assert.ok(verifyPassword(input.password, stored.password_hash));
  const publicApp = await call(applicationsRouter, 'GET', `/api/applications/${a.id}`);
  assert.equal(publicApp.password_hash, undefined);
  assert.equal(publicApp.password, undefined);
  await assert.rejects(call(authRouter, 'POST', '/api/auth/login', {identifier: input.username, password: input.password}), e => e.status === 401);
  await assert.rejects(registerLogin(loginRegistration({username:input.username.toUpperCase()})), e => e.status === 409);
  await run("UPDATE member_applications SET status='KYC_VERIFIED' WHERE id=?",[a.id]);
  const p = await call(membershipTransfersRouter, 'POST', '/api/payments/membership/bank-transfer', {application_id:a.id});
  await call(membershipTransfersRouter, 'POST', `/api/payments/membership/bank-transfer/${p.reference}/paid`);
  const staffRow = await run("INSERT INTO users (email,role) VALUES (?,'staff')",[`staff-${crypto.randomUUID()}@example.invalid`]);
  const token = issueToken(await get('SELECT * FROM users WHERE id=?',[staffRow.lastInsertRowid]));
  const approved = await call(membershipTransfersRouter, 'POST', `/api/admin/membership-transfers/${p.reference}/confirm-and-approve`, {amount_kobo:p.amount_kobo,bank_credit_checked:true,bank_reference:`BANK-${crypto.randomUUID()}`}, token);
  for(const identifier of [input.username.toUpperCase(), input.email, approved.member.member_code]) {
    const session = await call(authRouter,'POST','/api/auth/login',{identifier,password:input.password});
    assert.equal(session.role,'member');
    const portal = await call(meRouter,'GET','/api/me/membership',{},session.token);
    assert.equal(portal.member_code,approved.member.member_code);
  }
  const active = await call(applicationsRouter,'GET',`/api/applications/${a.id}`);
  assert.equal(active.has_login_credentials,true);
  assert.equal(active.username,input.username);
  const user = await get('SELECT * FROM users WHERE id=?',[approved.member.user_id]);
  await assert.rejects(registerLogin(loginRegistration({email:input.email})),e=>e.status===409);
  assert.equal((await get('SELECT password_hash FROM users WHERE id=?',[user.id])).password_hash,user.password_hash);
  await run("UPDATE members SET status='SUSPENDED' WHERE id=?",[approved.member.id]);
  await assert.rejects(call(authRouter,'POST','/api/auth/login',{identifier:input.username,password:input.password}),e=>e.status===403);
});

test('registration rejects weak or mismatched credentials and cannot overwrite an existing account', async () => {
  for(const patch of [{username:'1234'},{username:'ab'},{password:'short',password_confirmation:'short'},{password_confirmation:'different'}]) {
    await assert.rejects(registerLogin(loginRegistration(patch)),e=>e.status===422);
  }
  const existing = loginRegistration();
  await run("INSERT INTO users (email,phone,role,password_hash) VALUES (?,?,'member',?)",[existing.email,existing.phone,'existing-hash']);
  await assert.rejects(registerLogin(existing),e=>e.status===409);
  assert.equal((await get('SELECT password_hash FROM users WHERE email=?',[existing.email])).password_hash,'existing-hash');
});
