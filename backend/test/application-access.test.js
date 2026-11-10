import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'synthetic-application-access-test-only';
process.env.NODE_ENV = 'test';
process.env.YOUVERIFY_ENV = 'sandbox';
process.env.YOUVERIFY_SECRET_KEY = 'not-a-live-key';
process.env.MARKET_TRANSFER_ENABLED = 'true';
process.env.MARKET_TRANSFER_BANK_NAME = 'Synthetic Bank';
process.env.MARKET_TRANSFER_ACCOUNT_NAME = 'Synthetic Account';
process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
const { migrate, run, get, closeDatabase } = await import('../src/db.js');
const { applicationsRouter } = await import('../src/routes/applications.js');
const { kycRouter } = await import('../src/routes/kyc.js');
const { paymentsRouter } = await import('../src/routes/payments.js');
const { membershipTransfersRouter } = await import('../src/routes/membership-transfers.js');
const { issueToken, hashPassword } = await import('../src/utils/auth.js');
await migrate();
after(closeDatabase);
const routers = [applicationsRouter, kycRouter, paymentsRouter, membershipTransfersRouter];
async function call(method, path, body = {}, token = '') {
  const route = routers.map(router => router.match(method, path)).find(Boolean);
  assert.ok(route, path);
  const req = { body, headers: { authorization: token ? `Bearer ${token}` : '' }, socket: { remoteAddress: 'synthetic-test' } };
  const res = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res;
}
function profile() {
  const salt = crypto.randomBytes(7).toString('hex');
  return { username: `user${salt}`, password: 'Synthetic-password-123!', password_confirmation: 'Synthetic-password-123!',
    full_legal_name: 'Synthetic Applicant', date_of_birth: '1990-01-01', phone: `080${crypto.randomInt(10000000,99999999)}`,
    email: `${salt}@example.invalid`, address: 'Synthetic address', state: 'FCT', lga: 'Abuja Municipal', membership_type: 'Individual' };
}
async function register() { const input = profile(); const response = await call('POST', '/api/applications/register', input); return { input, app: response.body, token: response.body.application_token }; }
const denied = (promise, status) => assert.rejects(promise, e => e.status === status);

test('anonymous and different applicants cannot read, edit or submit synthetic applications', async () => {
  const a = await register(), b = await register();
  const before = await get('SELECT * FROM member_applications WHERE id = ?', [a.app.id]);
  const actions = [ ['GET', `/api/applications/${a.app.id}`, {}], ['PATCH', `/api/applications/${a.app.id}`, { full_legal_name: 'Changed By Other' }],
    ['POST', `/api/applications/${a.app.id}/submit`, { consents: { terms: true, privacy: true, marketing: true } }] ];
  for (const [method, path, body] of actions) { await denied(call(method, path, body), 401); await denied(call(method, path, body, b.token), 403); }
  assert.deepEqual(await get('SELECT * FROM member_applications WHERE id = ?', [a.app.id]), before);
  assert.equal(Number((await get('SELECT COUNT(*) n FROM consents WHERE application_id = ?', [a.app.id])).n), 0);
  const own = await call('GET', `/api/applications/${a.app.id}`, {}, a.token);
  assert.equal(own.body.email, a.input.email); assert.equal(own.headers['Cache-Control'], 'no-store');
  assert.equal(own.body.password_hash, undefined); assert.equal(own.body.application_token, undefined);
  await call('PATCH', `/api/applications/${a.app.id}`, { occupation_category: 'Artisan' }, a.token);
  await call('POST', `/api/applications/${a.app.id}/submit`, { consents: { terms: true, privacy: true } }, a.token);
  assert.equal((await get('SELECT status FROM member_applications WHERE id = ?', [a.app.id])).status, 'APPLICATION_SUBMITTED');
});

test('KYC and transfer references cannot bypass ownership or trigger provider work', async () => {
  const a = await register(), b = await register();
  await call('POST', `/api/applications/${a.app.id}/submit`, { consents: { terms: true, privacy: true } }, a.token);
  const session = (await call('POST', '/api/kyc/session', { application_id: a.app.id }, a.token)).body;
  let providerCalls = 0; const original = globalThis.fetch;
  globalThis.fetch = async () => { providerCalls++; throw new Error('Provider must not be called'); };
  try {
    const actions = [ ['POST', '/api/kyc/session', { application_id: a.app.id }], ['GET', `/api/kyc/${a.app.id}/status`, {}],
      ['GET', `/api/kyc/${session.session_ref}/status`, {}], ['POST', `/api/kyc/session/${session.session_ref}/verify`, { type: 'nin', id_number: '11111111111' }],
      ['POST', `/api/kyc/session/${session.session_ref}/simulate`, { outcome: 'SUCCESS' }],
      ['POST', '/api/payments/membership/initialize', { application_id: a.app.id, provider: 'paystack' }],
      ['POST', '/api/payments/membership/bank-transfer', { application_id: a.app.id }] ];
    for (const [method,path,body] of actions) { await denied(call(method,path,body),401); await denied(call(method,path,body,b.token),403); }
    assert.equal(providerCalls, 0);
    assert.equal(Number((await get('SELECT COUNT(*) n FROM kyc_provider_requests WHERE application_id=?',[a.app.id])).n), 0);
    assert.equal((await call('GET', `/api/kyc/${session.session_ref}/status`, {}, a.token)).body.status, 'KYC_PENDING');
    await run("UPDATE member_applications SET status='KYC_VERIFIED' WHERE id=?",[a.app.id]);
    const transfer = (await call('POST', '/api/payments/membership/bank-transfer', { application_id:a.app.id }, a.token)).body;
    for (const [method,path] of [['GET',`/api/payments/membership/bank-transfer/${a.app.id}`],['POST',`/api/payments/membership/bank-transfer/${transfer.reference}/paid`]]) {
      await denied(call(method,path),401); await denied(call(method,path,{},b.token),403);
    }
    assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?',[a.app.id])).status,'READY');
    const receipt = await call('GET',`/api/payments/membership/bank-transfer/${a.app.id}`,{},a.token);
    assert.equal(receipt.headers['Cache-Control'],'no-store'); assert.ok(receipt.body.whatsapp_url.includes(encodeURIComponent(a.input.email)));
    await call('POST',`/api/payments/membership/bank-transfer/${transfer.reference}/paid`,{},a.token);
    assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?',[a.app.id])).status,'CLAIMED');
  } finally { globalThis.fetch = original; }
});

test('invalid, expired and tampered sessions fail closed; identifiers cannot recover access', async () => {
  const a = await register();
  for (const token of ['', 'app.invalid', `${a.token}extra`, `${a.token}.extra`, 'Bearer nonsense']) await denied(call('GET',`/api/applications/${a.app.id}`,{},token),401);
  const oldNow = Date.now; Date.now = () => oldNow() + 5 * 60 * 60 * 1000;
  try { await denied(call('GET',`/api/applications/${a.app.id}`,{},a.token),401); } finally { Date.now = oldNow; }
  await denied(call('POST','/api/applications/resume',{application_id:a.app.id}),401);
  await denied(call('POST','/api/applications/resume',{username:a.input.username,password:'wrong'}),401);
  const restored = await call('POST','/api/applications/resume',{username:a.input.username,password:a.input.password});
  assert.equal(Number(restored.body.application_id),Number(a.app.id)); assert.equal(restored.headers['Cache-Control'],'no-store');
  await call('GET',`/api/applications/${a.app.id}`,{},restored.body.application_token);
  const anonymous = (await call('POST','/api/applications')).body;
  await call('GET',`/api/applications/${anonymous.id}`,{},anonymous.application_token);
  await denied(call('POST','/api/applications/resume',{application_id:anonymous.id}),401);
  await denied(call('POST','/api/applications/resume',{application_id:anonymous.id,username:'unknown',password:'anything'}),401);
});

test('active owner and staff access require database ownership, roles and revocation checks', async () => {
  const a = await register(), b = await register();
  const cred = await get('SELECT password_hash FROM registration_credentials WHERE application_id=?',[a.app.id]);
  const u = await run("INSERT INTO users (email,phone,username,password_hash,role) VALUES (?,?,?,?,'member')",[a.input.email,a.input.phone,a.input.username,cred.password_hash]);
  const uid = u.lastInsertRowid;
  await run("INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,'ACTIVE')",[a.app.id,uid,`OBT-TEST-${crypto.randomUUID()}`]);
  await run("UPDATE member_applications SET status='ACTIVE',user_id=? WHERE id=?",[uid,a.app.id]);
  const user = await get('SELECT * FROM users WHERE id=?',[uid]);
  await call('GET',`/api/applications/${a.app.id}`,{},issueToken(user));
  await denied(call('GET',`/api/applications/${b.app.id}`,{},issueToken(user)),403);
  await denied(call('GET',`/api/applications/${b.app.id}`,{},issueToken({...user,role:'admin'})),403);
  await run('UPDATE users SET session_version=session_version+1 WHERE id=?',[uid]);
  await denied(call('GET',`/api/applications/${a.app.id}`,{},a.token),401);
  await denied(call('GET',`/api/applications/${a.app.id}`,{},issueToken(user)),401);
  await run('UPDATE users SET password_hash=? WHERE id=?',[hashPassword('New-synthetic-password'),uid]);
  await denied(call('POST','/api/applications/resume',{username:a.input.username,password:a.input.password}),401);
  const resumed = await call('POST','/api/applications/resume',{username:a.input.username,password:'New-synthetic-password'});
  await call('GET',`/api/applications/${a.app.id}`,{},resumed.body.application_token);
  await run("UPDATE members SET status='SUSPENDED' WHERE user_id=?",[uid]);
  await denied(call('GET',`/api/applications/${a.app.id}`,{},resumed.body.application_token),401);
  const staffRow = await run("INSERT INTO users (email,role) VALUES (?,'staff')",[`staff-${crypto.randomUUID()}@example.invalid`]);
  const staff = await get('SELECT * FROM users WHERE id=?',[staffRow.lastInsertRowid]);
  await call('GET',`/api/applications/${a.app.id}`,{},issueToken(staff));
  await run("UPDATE users SET status='SUSPENDED' WHERE id=?",[staff.id]);
  await denied(call('GET',`/api/applications/${a.app.id}`,{},issueToken(staff)),401);
});

test('credential resume throttles failures without disclosing application existence', async () => {
  const a = await register();
  for (let i=0;i<5;i++) await denied(call('POST','/api/applications/resume',{username:a.input.username,password:'wrong'}),401);
  await denied(call('POST','/api/applications/resume',{username:a.input.username,password:a.input.password}),429);
});
