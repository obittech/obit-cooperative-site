import test,{after} from 'node:test';import assert from 'node:assert/strict';
process.env.DB_PATH=':memory:';process.env.AUTH_TOKEN_SECRET='review-test-only';
const {migrate,run,get,closeDatabase}=await import('../src/db.js');
const {recordReview,reviewDetails,assertApplicationNotHeld}=await import('../src/services/application-review.js');
const {activateApprovedMember}=await import('../src/services/membership-approval.js');
await migrate();after(closeDatabase);
const actor=Number((await run("INSERT INTO users(email,role) VALUES('review-admin@example.invalid','admin')")).lastInsertRowid);
async function app(email='same@example.invalid',phone='12345'){return Number((await run("INSERT INTO member_applications(full_legal_name,email,phone,status) VALUES('Test Applicant',?,?,'KYC_PENDING')",[email,phone])).lastInsertRowid);}
const note='Owner requested individual administrative review';
test('conditional acceptance grants no active membership or financial identity',async()=>{const id=await app();await recordReview(id,{decision:'CONDITIONAL_ACCEPTANCE',note,acknowledge_restrictions:true},actor);assert.equal((await get('SELECT status FROM member_applications WHERE id=?',[id])).status,'KYC_PENDING');assert.equal((await reviewDetails(id)).review.decision,'CONDITIONAL_ACCEPTANCE');for(const table of ['members','ledger_accounts','referral_bonuses','membership_bank_payments','membership_payments','kyc_checks'])assert.equal(Number((await get(`SELECT COUNT(*) n FROM ${table}`)).n),0);await assert.rejects(activateApprovedMember(await get('SELECT * FROM member_applications WHERE id=?',[id]),actor),/Confirm the membership payment/);});
test('duplicate hold is reversible and blocks activation',async()=>{const kept=await app(),id=await app();await recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:kept,note,same_person_confirmed:true},actor);await assert.rejects(assertApplicationNotHeld(id),/duplicate hold/);await assert.rejects(activateApprovedMember(await get('SELECT * FROM member_applications WHERE id=?',[id]),actor),/duplicate hold/);await recordReview(id,{decision:'RELEASED',note},actor);await assertApplicationNotHeld(id);assert.equal((await get('SELECT status FROM member_applications WHERE id=?',[id])).status,'KYC_PENDING');});
test('names alone, missing acknowledgement and cycles are rejected',async()=>{const a=await app(),b=await app('other@example.invalid');await assert.rejects(recordReview(a,{decision:'CONDITIONAL_ACCEPTANCE',note},actor),/Acknowledge/);await assert.rejects(recordReview(b,{decision:'DUPLICATE_HOLD',retained_application_id:a,note,same_person_confirmed:true},actor),/Both email and phone/);const c=await app();await recordReview(c,{decision:'DUPLICATE_HOLD',retained_application_id:a,note,same_person_confirmed:true},actor);await assert.rejects(recordReview(a,{decision:'DUPLICATE_HOLD',retained_application_id:c,note,same_person_confirmed:true},actor),/duplicate hold/);});
test('payment-bearing duplicate cannot be held and history is retained',async()=>{const keep=await app(),id=await app();await run("INSERT INTO membership_bank_payments(application_id,reference,amount_kobo,bank_name,account_name,account_number,whatsapp,status,created_ms) VALUES(?,?,300000,'Test','Test','000','000','CLAIMED',1)",[id,'test-'+id]);await assert.rejects(recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor),/Payment evidence exists/);assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?',[id])).status,'CLAIMED');assert.ok((await get("SELECT COUNT(*) n FROM audit_events WHERE action LIKE 'APPLICATION_REVIEW_%'")).n>=4);});
test('held application rejects authenticated mutation but permits read-only recovery',async()=>{const keep=await app(),id=await app();await recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor);const {issueApplicationSession,applicationParam}=await import('../src/middleware/application-access.js');const token=await issueApplicationSession(id);const req={method:'POST',headers:{authorization:'Bearer '+token}};await assert.rejects(applicationParam(req,{}, {id:String(id)}),/duplicate hold/);await applicationParam({...req,method:'GET'},{},{id:String(id)});});
test('review mutations are administrator-only',async()=>{const {adminRouter}=await import('../src/routes/admin.js');const {issueToken}=await import('../src/utils/auth.js');const staff=Number((await run("INSERT INTO users(email,role) VALUES('staff-review@example.invalid','staff')")).lastInsertRowid);const route=adminRouter.match('POST','/api/admin/applications/1/review');await assert.rejects(route.handlers[0]({headers:{authorization:'Bearer '+issueToken(await get('SELECT * FROM users WHERE id=?',[staff]))}}),/Not permitted/);});
test('hold committed after access check blocks both payment handlers inside application lock',async()=>{
 const {membershipTransfersRouter}=await import('../src/routes/membership-transfers.js');const {paymentsRouter}=await import('../src/routes/payments.js');const {issueApplicationSession}=await import('../src/middleware/application-access.js');
 for(const [router,path] of [[membershipTransfersRouter,'/api/payments/membership/bank-transfer'],[paymentsRouter,'/api/payments/membership/initialize']]){
  const keep=await app(),id=await app();await run("UPDATE member_applications SET status='KYC_VERIFIED' WHERE id=?",[id]);
  const token=await issueApplicationSession(id),route=router.match('POST',path),req={method:'POST',body:{application_id:id,provider:'paystack'},headers:{authorization:'Bearer '+token}},res={json(){throw new Error('must not succeed')}};
  await route.handlers[0](req,res,route.params);
  await recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor);
  await assert.rejects(route.handlers[1](req,res,route.params),/duplicate hold/);
  assert.equal(await get('SELECT id FROM membership_payments WHERE application_id=?',[id]),undefined);assert.equal(await get('SELECT id FROM membership_bank_payments WHERE application_id=?',[id]),undefined);
 }
});
test('held record cannot reserve a new KYC charge or create session after preflight',async()=>{
 process.env.YOUVERIFY_SECRET_KEY='synthetic-test-key';const {reserveKycRequest}=await import('../src/services/kyc-cost-controls.js');const {kycRouter}=await import('../src/routes/kyc.js');const {issueApplicationSession}=await import('../src/middleware/application-access.js');
 const keep=await app(),id=await app(),route=kycRouter.match('POST','/api/kyc/session'),req={method:'POST',body:{application_id:id},headers:{authorization:'Bearer '+await issueApplicationSession(id)}};
 await route.handlers[0](req,{},route.params);await recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor);
 await assert.rejects(route.handlers[1](req,{},route.params),/duplicate hold/);
 await assert.rejects(reserveKycRequest({id:123,application_id:id},'sandbox','nin'),/duplicate hold/);
 assert.equal(Number((await get('SELECT COUNT(*) n FROM kyc_provider_requests WHERE application_id=?',[id])).n),0);
});
test('in-flight or uncertain KYC evidence prevents duplicate hold',async()=>{const keep=await app(),id=await app();await run("INSERT INTO kyc_provider_requests(id,application_id,check_id,environment,product,state,reserved_kobo,started_ms) VALUES(?,?,123,'sandbox','nin','DISPATCHED',0,1)",['test-pending-'+id,id]);await assert.rejects(recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor),/in progress or uncertain/);await assertApplicationNotHeld(id);});
test('conditional applicant signs in with existing credentials, sees limited account and saves support without financial access',async()=>{
 const {applicationsRouter}=await import('../src/routes/applications.js');const {hashPassword}=await import('../src/utils/auth.js');const {requireAuth}=await import('../src/middleware/auth.js');const id=await app('limited@example.invalid','limited-phone');
 await run('INSERT INTO registration_credentials(application_id,username,password_hash) VALUES(?,?,?) RETURNING application_id',[id,'limited.test',hashPassword('SyntheticPassword123')]);
 await recordReview(id,{decision:'CONDITIONAL_ACCEPTANCE',note,acknowledge_restrictions:true},actor);
 async function call(method,path,body={},token=''){const route=applicationsRouter.match(method,path),req={method,body,headers:{authorization:'Bearer '+token}},res={json(status,body){this.body=body;this.writableEnded=true;}};for(const h of route.handlers){await h(req,res,route.params);if(res.writableEnded)break;}return res.body;}
 const session=await call('POST','/api/applications/resume',{username:'limited.test',password:'SyntheticPassword123'});
 const account=await call('GET',`/api/applications/${id}/limited-portal`,{},session.application_token);
 assert.equal(account.access,'LIMITED_APPLICANT');assert.equal(account.financial_services_enabled,false);assert.equal(account.application.status,'KYC_PENDING');
 await assert.rejects(requireAuth('member')({headers:{authorization:'Bearer '+session.application_token}}),/Missing or invalid session token/);
 await call('POST',`/api/applications/${id}/limited-portal/support`,{message:'Please reconcile my previous payment.'},session.application_token);
 assert.equal((await reviewDetails(id)).support_request.message,'Please reconcile my previous payment.');
 const other=await app();await assert.rejects(call('GET',`/api/applications/${other}/limited-portal`,{},session.application_token),/Application access denied/);
 const keep=await app('limited@example.invalid','limited-phone');await recordReview(id,{decision:'DUPLICATE_HOLD',retained_application_id:keep,note,same_person_confirmed:true},actor);
 await assert.rejects(call('GET',`/api/applications/${id}/limited-portal`,{},session.application_token),/requires conditional/);
 assert.equal(await get('SELECT id FROM members WHERE application_id=?',[id]),undefined);
});
