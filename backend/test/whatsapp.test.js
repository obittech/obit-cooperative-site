import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
process.env.DB_PATH=':memory:';
process.env.AUTH_TOKEN_SECRET='synthetic-whatsapp-tests-only';
process.env.WHATSAPP_ENABLED='true';process.env.WHATSAPP_APPROVAL_ENABLED='true';
process.env.WHATSAPP_APP_SECRET='synthetic-test-secret';process.env.WHATSAPP_VERIFY_TOKEN='synthetic-verify';
process.env.WHATSAPP_PHONE_NUMBER_ID='12345';process.env.WHATSAPP_WABA_ID='67890';
process.env.WHATSAPP_ACCESS_TOKEN='synthetic-test-token';process.env.WHATSAPP_GRAPH_VERSION='v99.0';
const {migrate,get,run,all,closeDatabase}=await import('../src/db.js');
const {verifyWhatsappSignature,parseConfirmation,businessReply,enqueueWhatsapp,processWhatsappQueue,businessPhone}=await import('../src/services/whatsapp.js');
const {authRouter}=await import('../src/routes/auth.js');
const {applicationsRouter}=await import('../src/routes/applications.js');
const {saveSponsor}=await import('../src/services/member-referrals.js');
const {activateApprovedMember}=await import('../src/services/membership-approval.js');
const {atomic}=await import('../src/db.js');
const {handleWhatsappWebhook}=await import('../src/routes/whatsapp.js');
await migrate();after(closeDatabase);
const actor=await run("INSERT INTO users(email,role) VALUES('synthetic-admin@example.invalid','admin')");
process.env.WHATSAPP_APPROVER_USER_ID=String(actor.lastInsertRowid);
let sent=[];
const send=async(url,opts)=>{sent.push({url,body:JSON.parse(opts.body)});return new Response('{}',{status:200});};
const id=()=>crypto.randomUUID();
function event(text,{echo=false,from=echo?businessPhone:'2348000000001',to='2348000000001',phoneId='12345',waba='67890',stamp=Math.floor(Date.now()/1000),eventId=id()}={}){
 return {object:'whatsapp_business_account',entry:[{id:waba,changes:[{field:echo?'smb_message_echoes':'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:phoneId,display_phone_number:'+2348030567787'},[echo?'message_echoes':'messages']:[{id:eventId,from,to,timestamp:String(stamp),type:'text',text:{body:text}}]}}]}]};
}
async function fixture({phone='08000000001',kyc='youverify_live_'+id(),email=id()+'@example.invalid'}={}){
 const a=await run("INSERT INTO member_applications(full_legal_name,status,email,phone) VALUES('Synthetic Applicant','PAYMENT_PENDING',?,?)",[email,phone]);
 const appId=Number(a.lastInsertRowid),ref='OBIT-MEM-'+crypto.randomBytes(16).toString('hex').toUpperCase();
 await run("INSERT INTO kyc_checks(application_id,provider,session_ref,status) VALUES(?,'YOUVERIFY',?,'KYC_VERIFIED')",[appId,kyc]);
 await run("INSERT INTO membership_bank_payments(application_id,reference,amount_kobo,bank_name,account_name,account_number,whatsapp,status,created_ms) VALUES(?,?,300000,'Test','Test','0000000000','2348030567787','CLAIMED',?)",[appId,ref,Date.now()]);
 return {appId,ref};
}
const command=(ref,bank=id(),amount='3000')=>`CONFIRM MEMBERSHIP ${ref} AMOUNT ${amount} BANK ${bank}`;
const status=async a=>(await get('SELECT status FROM member_applications WHERE id=?',[a.appId])).status;
async function processMessage(text,options={}){await enqueueWhatsapp(event(text,options));await processWhatsappQueue(send);}

test('signature rejects missing secrets, altered bytes and invalid hex',()=>{
 const raw=Buffer.from('{"value":"₦3000"}');const sig='sha256='+crypto.createHmac('sha256','secret').update(raw).digest('hex');
 assert.equal(verifyWhatsappSignature(raw,sig,'secret'),true);
 for(const [body,s,secret] of [[raw,sig,''],[Buffer.concat([raw,Buffer.from(' ')]),sig,'secret'],[raw,'sha256=abc','secret']])assert.equal(verifyWhatsappSignature(body,s,secret),false);
});
test('bare Confirmed and customer prose are not approval instructions',()=>{
 for(const t of ['Confirmed','I have paid ₦3000','CONFIRM MEMBERSHIP unknown AMOUNT 3000 BANK bank0001'])assert.equal(parseConfirmation(t),null);
 const c=parseConfirmation(command('OBIT-MEM-'+'A'.repeat(32),'bank0001','3000.25'));assert.equal(c.amountKobo,300025);
});
test('disabled webhook rejects even a correctly signed payload',async()=>{
 process.env.WHATSAPP_ENABLED='false';
 await assert.rejects(handleWhatsappWebhook({method:'POST'},{json(){throw Error('must not accept')}}),e=>e.status===503);
 process.env.WHATSAPP_ENABLED='true';
});
test('webhook validates handshake and raw-body signature before queuing',async()=>{
 const res={writeHead(s){this.status=s;},end(t){this.text=t;},json(s,b){this.status=s;this.body=b;}};
 await handleWhatsappWebhook({method:'GET',url:'/?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=challenge'},res);assert.equal(res.text,'challenge');
 await assert.rejects(handleWhatsappWebhook({method:'GET',url:'/?hub.mode=subscribe&hub.verify_token=wrong'},res),e=>e.status===403);
 const raw=Buffer.from(JSON.stringify(event('hello'))),req=Readable.from([raw]);req.method='POST';req.headers={'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex')};
 await handleWhatsappWebhook(req,res);assert.equal(res.status,200);await processWhatsappQueue(send);
 const bad=Readable.from([raw]);bad.method='POST';bad.headers={};await assert.rejects(handleWhatsappWebhook(bad,res),e=>e.status===401);
});
test('unknown accounts, spoofed business senders, history and stale events are ignored',async()=>{
 for(const opts of [{waba:'other'},{phoneId:'other'},{echo:true,from:'2348000000009'},{echo:true,stamp:1},{stamp:1}])assert.equal(await enqueueWhatsapp(event('Confirmed',opts)),0);
 const history=event('hello');history.entry[0].changes[0].field='history';assert.equal(await enqueueWhatsapp(history),0);
});
test('customer messages cannot activate membership even with exact command syntax',async()=>{
 const a=await fixture();await processMessage(command(a.ref));assert.equal(await status(a),'PAYMENT_PENDING');
});
test('outgoing Confirmed without a reference leaves membership pending',async()=>{
 const a=await fixture();await processMessage('Confirmed',{echo:true});assert.equal(await status(a),'PAYMENT_PENDING');
});
test('verified business confirmation activates once and replay cannot duplicate records',async()=>{
 const a=await fixture(),payload=event(command(a.ref),{echo:true});
 assert.equal(await enqueueWhatsapp(payload),1);assert.equal(await enqueueWhatsapp(payload),0);await processWhatsappQueue(send);
 assert.equal(await status(a),'ACTIVE');
 assert.equal(Number((await get('SELECT COUNT(*) AS n FROM members WHERE application_id=?',[a.appId])).n),1);
 const p=await get('SELECT * FROM membership_bank_payments WHERE reference=?',[a.ref]);assert.equal(p.status,'CONFIRMED');
 await processMessage(command(a.ref,p.bank_reference),{echo:true});
 assert.equal(Number((await get('SELECT COUNT(*) AS n FROM ledger_accounts WHERE member_id IN (SELECT id FROM members WHERE application_id=?)',[a.appId])).n),1);
});
test('wrong amount, wrong chat, disabled approval, sandbox KYC and blocked admin cannot activate',async()=>{
 for(const issue of ['amount','chat','disabled','kyc','actor']){
  const a=await fixture(issue==='kyc'?{kyc:'youverify_sandbox_'+id()}:{});
  if(issue==='disabled')process.env.WHATSAPP_APPROVAL_ENABLED='false';
  if(issue==='actor')process.env.WHATSAPP_APPROVER_USER_ID='999999';
  await processMessage(command(a.ref,id(),issue==='amount'?'1':'3000'),{echo:true,...(issue==='chat'?{to:'2348000000099'}:{})});
  assert.equal(await status(a),'PAYMENT_PENDING');
  assert.equal((await get('SELECT status FROM membership_bank_payments WHERE reference=?',[a.ref])).status,'CLAIMED');
  process.env.WHATSAPP_APPROVAL_ENABLED='true';process.env.WHATSAPP_APPROVER_USER_ID=String(actor.lastInsertRowid);
 }
});
test('a bank credit already allocated elsewhere cannot activate a member',async()=>{
 const a=await fixture(),ref='BANK-'+id();await run("INSERT INTO bank_credit_allocations(bank_reference,resource_type,resource_id) VALUES(?,'MARKET',123)",[ref]);
 await processMessage(command(a.ref,ref),{echo:true});assert.equal(await status(a),'PAYMENT_PENDING');
});
test('administrator/member collision rolls back payment and bank allocation',async()=>{
 const a=await fixture({email:'synthetic-admin@example.invalid'}),ref=id();
 await processMessage(command(a.ref,ref),{echo:true});assert.equal(await status(a),'PAYMENT_PENDING');
 assert.equal(await get('SELECT * FROM bank_credit_allocations WHERE bank_reference=?',[ref]),undefined);
});
test('opt-out and manual takeover hold replies, START can resume an opted-out chat',async()=>{
 const from='2348000000002';await processMessage('STOP',{from});const n=sent.length;
 await processMessage('hello',{from});assert.equal(sent.length,n);
 await processMessage('START',{from});assert.equal(sent.length,n+1);
 await processMessage('human',{from});const h=sent.length;await processMessage('obs',{from});assert.equal(sent.length,h);
});
test('a provider send with uncertain outcome is held for staff rather than resent',async()=>{
 const payload=event('hello',{from:'2348000000003'});let calls=0;
 await enqueueWhatsapp(payload);await processWhatsappQueue(async()=>{calls++;throw Error('Synthetic network failure');});
 await enqueueWhatsapp(payload);await processWhatsappQueue(send);assert.equal(calls,1);
 const e=await get('SELECT * FROM whatsapp_events WHERE event_id=?',[payload.entry[0].changes[0].value.messages[0].id]);assert.equal(e.status,'REVIEW');
});
test('business replies use the approved businesses and never promise unsupported finance actions',()=>{
 assert.match(businessReply('OBS software'),/₦25,000/);assert.match(businessReply('membership'),/obitcooperative.com/);
 assert.match(businessReply('solar'),/staff/);assert.doesNotMatch(businessReply('loan'),/guaranteed|approved/i);
});
test('welcome messages need a recent customer session and respect opt-out',async()=>{
 const a=await fixture({phone:'08000000004'});await processMessage('membership',{from:'2348000000004'});const n=sent.length;
 await processMessage(command(a.ref),{echo:true,to:'2348000000004'});assert.equal(await status(a),'ACTIVE');assert.equal(sent.length,n+1);assert.match(sent.at(-1).body.text.body,/Membership code/);
 const b=await fixture({phone:'08000000005'});const before=sent.length;
 await processMessage(command(b.ref),{echo:true,to:'2348000000005'});assert.equal(await status(b),'ACTIVE');assert.equal(sent.length,before);
});
test('STOP is saved even while a conversation is held for staff',async()=>{
 const from='2348000000006';await processMessage('human',{from});await processMessage('STOP',{from});
 assert.equal(Number((await get('SELECT opted_out FROM whatsapp_contacts WHERE phone=?',[from])).opted_out),1);
});

async function call(router, method, path, body = {}, token = '') {
 const route = router.match(method, path);
 const req = {body, socket:{}, headers:{authorization:token ? `Bearer ${token}` : ''}};
 const res = {json(status, body) { this.body = body; this.writableEnded = true; }};
 for (const handler of route.handlers) { await handler(req,res,route.params); if(res.writableEnded)break; }
 return res.body;
}
test('WhatsApp approval retains registration credentials, supports every login identifier and awards referral once',async()=>{
 const sponsor=await get("SELECT * FROM members WHERE status='ACTIVE' ORDER BY id LIMIT 1");
 const phone='080'+crypto.randomInt(10000000,99999999),to='234'+phone.slice(1);
 const username='wa'+crypto.randomBytes(8).toString('hex'),password='Synthetic-WhatsApp-Password!';
 const app=await call(applicationsRouter,'POST','/api/applications/register',{
  full_legal_name:'Synthetic WhatsApp Member',date_of_birth:'1990-01-01',phone,
  email:id()+'@example.invalid',address:'Synthetic test address',state:'FCT',lga:'Abuja Municipal',membership_type:'Individual',
  username,password,password_confirmation:password
 });
 await assert.rejects(call(authRouter,'POST','/api/auth/login',{identifier:username,password}),e=>e.status===401);
 await saveSponsor(await get('SELECT * FROM member_applications WHERE id=?',[app.id]),sponsor.member_code);
 const ref='OBIT-MEM-'+crypto.randomBytes(16).toString('hex').toUpperCase(),bank=id();
 await run("UPDATE member_applications SET status='PAYMENT_PENDING' WHERE id=?",[app.id]);
 await run("INSERT INTO kyc_checks(application_id,provider,session_ref,status) VALUES(?,'YOUVERIFY',?,'KYC_VERIFIED')",[app.id,'youverify_live_'+id()]);
 await run("INSERT INTO membership_bank_payments(application_id,reference,amount_kobo,bank_name,account_name,account_number,whatsapp,status,created_ms) VALUES(?,?,300000,'Test','Test','0000000000','2348030567787','CLAIMED',?)",[app.id,ref,Date.now()]);
 await processMessage('membership',{from:to});
 await processMessage(command(ref,bank),{echo:true,to});
 const member=await get('SELECT * FROM members WHERE application_id=?',[app.id]);assert.ok(member);
 const user=await get('SELECT * FROM users WHERE id=?',[member.user_id]);
 const credentials=await get('SELECT * FROM registration_credentials WHERE application_id=?',[app.id]);
 assert.equal(user.password_hash,credentials.password_hash);assert.equal(user.username,username);
 assert.equal(Number((await get('SELECT user_id FROM member_applications WHERE id=?',[app.id])).user_id),Number(user.id));
 for(const identifier of [username.toUpperCase(),app.email,phone,member.member_code]){
  const session=await call(authRouter,'POST','/api/auth/login',{identifier,password});assert.equal(session.role,'member');assert.ok(session.token);
 }
 assert.match(sent.at(-1).body.text.body,/chosen during registration/);
 assert.doesNotMatch(JSON.stringify(sent.at(-1)),new RegExp(password));
 await processMessage(command(ref,bank),{echo:true,to});
 assert.equal(Number((await get('SELECT COUNT(*) AS n FROM referral_bonuses WHERE application_id=?',[app.id])).n),1);
 assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE member_id=?',[member.id])).balance_kobo),0);
});
test('shared activation refuses privileged, suspended and ambiguous identities for manual and WhatsApp callers',async()=>{
 for(const issue of ['staff','suspended','ambiguous']){
  const phone='080'+crypto.randomInt(10000000,99999999),email=id()+'@example.invalid';
  const a=await fixture({phone,email});
  await run("UPDATE member_applications SET status='UNDER_REVIEW' WHERE id=?",[a.appId]);
  await run("UPDATE membership_bank_payments SET status='CONFIRMED' WHERE application_id=?",[a.appId]);
  await run('INSERT INTO users(email,phone,role,status) VALUES(?,?,?,?)',[email,phone,issue==='staff'?'staff':'member',issue==='suspended'?'SUSPENDED':'ACTIVE']);
  if(issue==='ambiguous'){
   await run('UPDATE users SET phone=NULL WHERE email=?',[email]);
   await run("INSERT INTO users(email,phone,role) VALUES(?,?,'member')",[id()+'@example.invalid',phone]);
  }
  const app=await get('SELECT * FROM member_applications WHERE id=?',[a.appId]);
  await assert.rejects(atomic(()=>activateApprovedMember(app,Number(actor.lastInsertRowid))),e=>e.status===409);
  assert.equal(await get('SELECT id FROM members WHERE application_id=?',[a.appId]),undefined);
 }
});
test('Finance replies describe current credentials and legacy member setup',()=>{
 assert.match(businessReply('finance'),/username, registered email, phone number or membership code/);
 assert.match(businessReply('membership'),/Existing members without a password/);
});
