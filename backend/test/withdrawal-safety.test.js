import test, { after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_ENGINE ||= 'sqlite';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'withdrawal-local-tests';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_mock_only';
const { migrate, run, get, all, closeDatabase } = await import('../src/db.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { issueToken } = await import('../src/utils/auth.js');
await migrate();
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await closeDatabase(); });
const u = await run("INSERT INTO users (email,role,status) VALUES ('withdrawal@example.invalid','admin','ACTIVE')");
const token = issueToken(await get('SELECT * FROM users WHERE id = ?', [u.lastInsertRowid]));
async function call(id, action = 'initiate-payout', body = {}, auth = token) {
  const route = adminRouter.match('POST', `/api/admin/withdrawals/${id}/${action}`);
  const req = { body, headers: { authorization: auth ? `Bearer ${auth}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
let seq = 0;
async function seed() {
  const a = await run("INSERT INTO member_applications (status) VALUES ('ACTIVE')");
  const m = await run('INSERT INTO members (application_id,member_code) VALUES (?,?)', [a.lastInsertRowid, `WD-${++seq}`]);
  const l = await run('INSERT INTO ledger_accounts (member_id,balance,balance_kobo) VALUES (?,1000,100000)', [m.lastInsertRowid]);
  const b = await run("INSERT INTO member_bank_accounts (member_id,bank_code,bank_name,account_number,account_name,recipient_code,verified_at) VALUES (?,'001','Mock','0000000000','Test','RCP_mock',datetime('now'))", [m.lastInsertRowid]);
  const w = await run("INSERT INTO withdrawal_requests (member_id,ledger_account_id,amount,amount_kobo,bank_account_id,status) VALUES (?,?,600,60000,?,'APPROVED')", [m.lastInsertRowid,l.lastInsertRowid,b.lastInsertRowid]);
  return { id: w.lastInsertRowid, account: l.lastInsertRowid };
}
const response = data => ({ ok: true, json: async () => ({ status: true, data }) });

test('durable claim survives concurrent initiation and ordinary retries', async () => {
  const { id } = await seed(); let calls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.paystack.co/transfer'); calls++;
    const body = JSON.parse(options.body);
    const persisted = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [id]);
    assert.equal(persisted.transfer_reference, body.reference);
    assert.equal(persisted.provider_status, 'initiating');
    assert.equal(body.amount,60000);assert.equal(body.recipient,'RCP_mock');assert.equal(body.currency,'NGN');
    await new Promise(resolve => setTimeout(resolve, 20));
    return response({ status: 'otp' });
  };
  const results = await Promise.all(Array.from({length: 10}, () => call(id)));
  assert.equal(calls, 1); assert.equal(new Set(results.map(r => r.reference)).size, 1);
  assert.equal((await call(id)).idempotent, true); assert.equal(calls, 1);
});

test('timeouts, malformed responses and explicit rejection retain reference and block resubmission', async () => {
  for (const failure of [() => { throw new Error('timeout'); }, () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }), () => ({ ok: false, json: async () => ({ status: false, message:'<script>alert(1)</script>' }) })]) {
    const { id } = await seed(); let calls = 0;
    globalThis.fetch = async () => { calls++; return failure(); };
    await assert.rejects(call(id), e => e.status === 502 && !e.message.includes('<script>'));
    const persisted = await get('SELECT * FROM withdrawal_requests WHERE id = ?', [id]);
    assert.equal(persisted.provider_status, 'unknown'); assert.ok(persisted.transfer_reference);
    assert.equal((await call(id)).reference, persisted.transfer_reference); assert.equal(calls, 1);
  }
});

test('a process interruption after claim and legacy references never trigger replacement transfers', async () => {
  for (const status of ['initiating', 'pending', 'failed', 'unknown', 'otp']) {
    const { id } = await seed();
    await run('UPDATE withdrawal_requests SET transfer_reference = ?, provider_status = ? WHERE id = ?', [`legacy-${id}`,status,id]);
    globalThis.fetch = async () => assert.fail('No provider call allowed');
    assert.equal((await call(id)).reference, `legacy-${id}`);
  }
});

test('in-flight claims reserve available balance across different requests', async () => {
  const { id } = await seed();
  const second = await run("INSERT INTO withdrawal_requests (member_id,ledger_account_id,amount,amount_kobo,bank_account_id,status) SELECT member_id,ledger_account_id,amount,amount_kobo,bank_account_id,status FROM withdrawal_requests WHERE id=?", [id]);
  let calls = 0; globalThis.fetch = async () => { calls++; return response({status:'pending'}); };
  const outcomes = await Promise.allSettled([call(id),call(second.lastInsertRowid)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length, 1);
  assert.equal(outcomes.find(r=>r.status==='rejected').reason.status, 409); assert.equal(calls,1);
});

test('successful reconciliation debits once under concurrency, and rejects mismatched verification', async () => {
  const { id, account } = await seed();
  globalThis.fetch = async () => response({status:'pending'});
  const { reference } = await call(id);
  for (const override of [{reference:'wrong'}, {amount:1}, {currency:'USD'}]) {
    globalThis.fetch = async () => response({status:'success', reference, amount:60000, currency:'NGN',...override});
    await assert.rejects(call(id,'reconcile-payout'), e=>e.status===409);
  }
  assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?',[account])).balance_kobo),100000);
  globalThis.fetch = async () => response({status:'success', reference, amount:60000, currency:'NGN'});
  await Promise.all(Array.from({length: 8},()=>call(id,'reconcile-payout')));
  assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?',[account])).balance_kobo),40000);
  assert.equal((await all('SELECT * FROM transactions WHERE provider_reference=?',[reference])).length,1);
  globalThis.fetch = async () => assert.fail('Paid withdrawal cannot make provider call');
  assert.equal((await call(id)).idempotent,true);
  assert.equal((await call(id,'reconcile-payout')).idempotent,true);
});

test('OTP completion continues using the original transfer', async () => {
  const { id } = await seed();
  globalThis.fetch = async () => response({status:'otp'});
  const {reference}=await call(id);let finalized=0;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/finalize_transfer')){finalized++;assert.deepEqual(JSON.parse(options.body),{transfer_code:'TRF_mock',otp:'123456'});return response({status:'pending'});}
    assert.ok(url.endsWith(encodeURIComponent(reference)));return response({transfer_code:'TRF_mock',status:'otp'});
  };
  assert.equal((await call(id,'finalize-payout',{otp:'123456'})).reference,reference);assert.equal(finalized,1);
});

test('configuration and authorization failures do not claim a withdrawal',async()=>{
  const {id}=await seed();globalThis.fetch=async()=>assert.fail('No provider call allowed');
  await assert.rejects(call(id,'initiate-payout',{},''),e=>e.status===401);
  const key=process.env.PAYSTACK_SECRET_KEY;delete process.env.PAYSTACK_SECRET_KEY;
  try{await assert.rejects(call(id),e=>e.status===503);}finally{process.env.PAYSTACK_SECRET_KEY=key;}
  assert.equal((await get('SELECT transfer_reference FROM withdrawal_requests WHERE id=?',[id])).transfer_reference,null);
});

test('a delayed pending reconciliation cannot regress a completed payout',async()=>{
  const {id,account}=await seed();globalThis.fetch=async()=>response({status:'pending'});
  const {reference}=await call(id);
  let announce,release;const started=new Promise(resolve=>{announce=resolve;});
  const delayed=new Promise(resolve=>{release=resolve;});let requests=0;
  globalThis.fetch=async()=>{
    requests++;
    if(requests===1){announce();await delayed;return response({status:'pending',reference,amount:60000,currency:'NGN'});}
    return response({status:'success',reference,amount:60000,currency:'NGN'});
  };
  const stale=call(id,'reconcile-payout');await started;
  assert.equal((await call(id,'reconcile-payout')).status,'PAID');
  release();const result=await stale;
  assert.equal(result.status,'PAID');assert.equal(result.provider_status,'success');assert.equal(result.idempotent,true);
  assert.equal((await get('SELECT provider_status FROM withdrawal_requests WHERE id=?',[id])).provider_status,'success');
  assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE id=?',[account])).balance_kobo),40000);
});
