import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceAllowed,startMonnifyAcceptance} from '../src/services/market-monnify-acceptance.js';
const env={MARKET_MONNIFY_ACCEPTANCE:'true',RENDER_SERVICE_ID:'srv-dbjfm4vb9u1s73dt9qa0',NODE_ENV:'test',DB_ENGINE:'sqlite',DB_PATH:'/tmp/obit-monnify-sandbox.db',MARKET_CHECKOUT_MODE:'test',MARKET_MONNIFY_API_KEY:'MK_TEST_fake',MARKET_TRANSFER_ENABLED:'false',MEMBERSHIP_TRANSFER_ENABLED:'false'};
test('acceptance fixture is restricted to the designated disposable sandbox',()=>{
 assert.equal(acceptanceAllowed(env),true);
 for(const change of [{MARKET_MONNIFY_ACCEPTANCE:'false'},{RENDER_SERVICE_ID:'production-service'},{NODE_ENV:'production'},{DB_ENGINE:'postgres'},{DB_PATH:'/var/data/real.db'},{DATABASE_URL:'postgres://example'},{MARKET_CHECKOUT_MODE:'live'},{MARKET_MONNIFY_API_KEY:'MK_LIVE_fake'},{MARKET_TRANSFER_ENABLED:'true'},{MEMBERSHIP_TRANSFER_ENABLED:'true'}])assert.equal(acceptanceAllowed({...env,...change}),false);
});
test('disabled acceptance makes no database or provider call',async()=>{
 const old=process.env.MARKET_MONNIFY_ACCEPTANCE;
 delete process.env.MARKET_MONNIFY_ACCEPTANCE;
 try{assert.equal(await startMonnifyAcceptance(),undefined);}finally{if(old!==undefined)process.env.MARKET_MONNIFY_ACCEPTANCE=old;}
});
test('fixture initializes one provider checkout and reuses its order after restart',async()=>{
 process.env.DB_ENGINE='sqlite';process.env.DB_PATH=':memory:';
 const db=await import('../src/db.js');await db.migrate();
 const saved={...process.env},fetch=globalThis.fetch,log=console.log;let calls=0;
 try{
  Object.assign(process.env,env,{MARKET_MONNIFY_SECRET_KEY:'sandbox-test-only-secret',MARKET_MONNIFY_CONTRACT_CODE:'1234567890',MARKET_MONNIFY_CALLBACK_URL:'https://sandbox.example.test/market-account.html',AUTH_TOKEN_SECRET:'test-only-auth-secret'});
  delete process.env.DATABASE_URL;
  console.log=()=>{};
  globalThis.fetch=async(url,opts)=>{
   const body=url.endsWith('/auth/login')?{accessToken:'test-only-acceptance-token',expiresIn:3600}:(()=>{calls++;const req=JSON.parse(opts.body);assert.equal(req.amount,1000);return {paymentReference:req.paymentReference,transactionReference:'MNFY|ACCEPTANCE|TEST',checkoutUrl:'https://sandbox.sdk.monnify.com/checkout/MNFY|ACCEPTANCE|TEST'};})();
   return new Response(JSON.stringify({requestSuccessful:true,responseBody:body}));
  };
  await startMonnifyAcceptance();await startMonnifyAcceptance();
  assert.equal(calls,1);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM market_purchase_orders')).n),1);
  assert.equal((await db.get('SELECT status FROM market_payment_attempts')).status,'READY');
  assert.equal(Number((await db.get('SELECT quantity FROM market_inventory')).quantity),2);
 }finally{
  globalThis.fetch=fetch;console.log=log;
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
  Object.assign(process.env,saved);await db.closeDatabase();
 }
});
