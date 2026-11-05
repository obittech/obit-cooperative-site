import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH=':memory:';process.env.AUTH_TOKEN_SECRET='finance-tests-only';process.env.MARKET_TRANSFER_ENABLED='true';process.env.MARKET_TRANSFER_BANK_NAME='Test Bank';process.env.MARKET_TRANSFER_ACCOUNT_NAME='Test Cooperative';process.env.MARKET_TRANSFER_ACCOUNT_NUMBER='0000000000';
const {migrate,run,get,all,closeDatabase}=await import('../src/db.js');
const {meRouter}=await import('../src/routes/me.js');
const {memberFinanceRouter:router}=await import('../src/routes/member-finance.js');
const {issueToken}=await import('../src/utils/auth.js');
await migrate();after(closeDatabase);
async function call(method,path,body={},token=''){const route=router.match(method,path)||meRouter.match(method,path);assert.ok(route);const req={body,headers:{authorization:token?'Bearer '+token:''}},res={json(status,body){this.status=status;this.body=body;this.writableEnded=true;}};for(const f of route.handlers){await f(req,res,route.params);if(res.writableEnded)break;}return res.body;}
async function user(role='member'){const r=await run("INSERT INTO users (email,role,status) VALUES (?,?,'ACTIVE')",[crypto.randomUUID()+'@example.invalid',role]);const id=Number(r.lastInsertRowid);return {id,token:issueToken(await get('SELECT * FROM users WHERE id=?',[id]))};}
async function fixture(){const u=await user();const a=await run("INSERT INTO member_applications (full_legal_name,phone,status) VALUES ('Finance Test Member','08000000000','ACTIVE')");const m=await run("INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,'ACTIVE')",[a.lastInsertRowid,u.id,'TEST-'+crypto.randomUUID()]);const plan=await call('POST','/api/me/contribution-plans',{amount:100,target_amount:2000,frequency:'DAILY',purpose:'General Savings',lock_months:1},u.token);return {...u,member:Number(m.lastInsertRowid),plan:plan.id};}
const admin=await user('admin'),staff=await user('staff');
const start=(u,b)=>call('POST','/api/me/finance-requests',{kind:'DEPOSIT',plan_id:u.plan,accept_fee:true,amount:'1000',frequency:'DAILY',purpose:'contribution',idempotency_key:crypto.randomUUID(),...b},u.token);
const report=(u,r)=>call('POST','/api/me/finance-requests/report',{reference:r.reference},u.token);
const confirm=(r,ref,b={},token=admin.token)=>call('POST',`/api/admin/finance-requests/${r.id}/confirm`,{amount_kobo:Number(r.amount_kobo),bank_reference:ref,confirmed:true,...b},token);
const balance=async u=>Number((await get("SELECT balance_kobo FROM ledger_accounts WHERE member_id=? AND account_type='SAVINGS'",[u.member])).balance_kobo);
test('reported deposit stays uncredited until confirmation and credits exactly once',async()=>{const u=await fixture(),key=crypto.randomUUID();const [r,retry]=await Promise.all([start(u,{idempotency_key:key}),start(u,{idempotency_key:key})]);assert.equal(r.reference,retry.reference);assert.equal(r.status,'READY');assert.equal(await balance(u),0);await assert.rejects(confirm(r,'BANK-'+crypto.randomUUID()),e=>e.status===409);const notified=await report(u,r);const msg=new URL(notified.whatsapp_url).searchParams.get('text');for(const text of ['1,000','daily contribution','Finance Test Member','08000000000',r.reference])assert.ok(msg.includes(text));assert.equal(await balance(u),0);await assert.rejects(confirm(r,'BANK-'+crypto.randomUUID(),{amount_kobo:500}),e=>e.status===409);await assert.rejects(confirm(r,'BANK-'+crypto.randomUUID(),{confirmed:false}),e=>e.status===400);const ref='BANK-'+crypto.randomUUID();await Promise.all([confirm(r,ref),confirm(r,ref)]);assert.equal(await balance(u),100000);assert.equal(Number((await get('SELECT COUNT(*) AS n FROM ledger_accounts WHERE member_id=?',[u.member])).n),1);const rows=await all('SELECT * FROM transactions WHERE provider_reference=?',[r.reference]);assert.equal(rows.length,1);assert.equal(Number((await get('SELECT COUNT(*) AS n FROM receipts WHERE transaction_id=?',[rows[0].id])).n),1);await assert.rejects(start(u,{idempotency_key:key,amount:500}),e=>e.status===409);});
test('member isolation, authentication and reused bank credits are enforced',async()=>{const a=await fixture(),b=await fixture();const ra=await start(a,{}),rb=await start(b,{});await report(a,ra);await report(b,rb);await assert.rejects(report(b,ra),e=>e.status===404);await assert.rejects(call('GET','/api/admin/finance-requests',{},a.token),e=>e.status===403);await assert.rejects(confirm(ra,'BANK-TEST-000',{},''),e=>e.status===401);const ref='BANK-'+crypto.randomUUID();await confirm(ra,ref);await assert.rejects(confirm(rb,ref),e=>e.status===409);assert.equal(await balance(b),0);});
test('manual withdrawal reserves funds and debits once only after administrator records payment',async()=>{const u=await fixture(),dep=await start(u,{});await report(u,dep);await confirm(dep,'BANK-'+crypto.randomUUID());await run('UPDATE savings_plan_terms SET maturity_ms=? WHERE plan_id=?',[Date.now()-1,u.plan]);const input={kind:'WITHDRAWAL',amount:500,bank_name:'Recipient Bank',account_name:'Recipient Test',account_number:'1234567890',designation:'Self'};const r=await start(u,input);assert.equal(await balance(u),100000);const msg=new URL(r.whatsapp_url).searchParams.get('text');for(const text of ['500','Finance Test Member','08000000000','Recipient Test','Recipient Bank','1234567890'])assert.ok(msg.includes(text));await assert.rejects(start(u,{...input,amount:501}),e=>e.status===409);await assert.rejects(confirm(r,'PAYOUT-'+crypto.randomUUID(),{},staff.token),e=>e.status===403);const ref='PAYOUT-'+crypto.randomUUID();await Promise.all([confirm(r,ref),confirm(r,ref)]);assert.equal(await balance(u),50000);assert.equal((await get('SELECT status FROM member_finance_requests WHERE id=?',[r.id])).status,'PAID');await assert.rejects(start(u,{...input,amount:501}),e=>e.status===409);});
test('invalid amounts and recipient accounts cannot create requests',async()=>{const u=await fixture();for(const amount of ['0','-1','0.001','Infinity'])await assert.rejects(start(u,{amount}),e=>e.status===400);await assert.rejects(start(u,{kind:'WITHDRAWAL',account_number:'123',bank_name:'Bank',account_name:'Member'}),e=>e.status===400);});

test('lock, plan ownership, charge and confirmed equipment eligibility are enforced',async()=>{
 const u=await fixture(),other=await fixture();
 const plan=await call('POST','/api/me/contribution-plans',{amount:100,target_amount:2000,frequency:'DAILY',purpose:'Equipment',lock_months:3,business_type:'Tailoring & Fashion',equipment:'Sewing machine'},u.token);
 const loan=()=>call('POST','/api/me/equipment-loans',{plan_id:plan.id},u.token);
 await assert.rejects(loan(),e=>e.status===409);
 await assert.rejects(start(other,{plan_id:plan.id}),e=>e.status===400);
 const dep=await start(u,{plan_id:plan.id});await report(u,dep);await assert.rejects(loan(),e=>e.status===409);
 await confirm(dep,'BANK-'+crypto.randomUUID());
 const input={kind:'WITHDRAWAL',plan_id:plan.id,amount:100,bank_name:'Test Bank',account_name:'Test Member',account_number:'1234567890'};
 await assert.rejects(start(u,input),e=>e.status===409);
 await run('UPDATE savings_plan_terms SET maturity_ms=? WHERE plan_id=?',[Date.now()-1,plan.id]);
 await assert.rejects(start(u,{...input,accept_fee:false}),e=>e.status===400);
 const w=await start(u,input);assert.equal(Number(w.fee_kobo),1000);assert.equal(Number(w.payout_kobo),9000);
 await assert.rejects(loan(),e=>e.status===409);
 await call('POST',`/api/admin/finance-requests/${w.id}/reject`,{note:'Member cancelled withdrawal'},admin.token);
 const [a,b]=await Promise.all([loan(),loan()]);assert.equal(a.id,b.id);assert.equal(Number(a.requested_kobo),100000);
 await assert.rejects(start(u,input),e=>e.status===409);
 const msg=new URL(a.whatsapp_url).searchParams.get('text');assert.ok(msg.includes('Sewing machine'));assert.ok(msg.includes('Finance Test Member'));
});
test('all permitted lock periods and equipment choices are validated',async()=>{
 const u=await fixture();for(const months of [1,3,6,12])await call('POST','/api/me/contribution-plans',{amount:100,target_amount:2000,frequency:'DAILY',purpose:'General Savings',lock_months:months},u.token);
 for(const months of [0,2,4,'3'])await assert.rejects(call('POST','/api/me/contribution-plans',{amount:100,target_amount:2000,frequency:'DAILY',purpose:'General Savings',lock_months:months},u.token),e=>e.status===400);
 await assert.rejects(call('POST','/api/me/contribution-plans',{amount:100,target_amount:2000,frequency:'DAILY',purpose:'Equipment',lock_months:3,business_type:'Laundry',equipment:'Tractor'},u.token),e=>e.status===400);
});
