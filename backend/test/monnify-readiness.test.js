import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {monnifyReadiness} from '../src/services/market-monnify-readiness.js';
import {checkMonnifyAuthentication} from '../src/services/market-monnify.js';

const env = {NODE_ENV:'test', MARKET_CHECKOUT_MODE:'test', MARKET_MONNIFY_API_KEY:'MK_TEST_diagnostic_only',
 MARKET_MONNIFY_SECRET_KEY:'diagnostic-only-secret', MARKET_MONNIFY_CONTRACT_CODE:'1234567890',
 MARKET_MONNIFY_CALLBACK_URL:'https://staging.example.test/market-account.html#orders'};

test('readiness reports missing settings without returning sensitive configuration', () => {
 const empty = monnifyReadiness({});
 assert.equal(empty.sandbox_configured, false);
 assert.equal(empty.missing_or_invalid.length, 6);
 const ready = monnifyReadiness(env);
 assert.equal(ready.sandbox_configured, true);
 assert.equal(ready.live_collection_available, false);
 assert.equal(ready.provider_credentials_verified, false);
 const output = JSON.stringify(ready);
 for (const key of ['MARKET_MONNIFY_API_KEY','MARKET_MONNIFY_SECRET_KEY','MARKET_MONNIFY_CONTRACT_CODE','MARKET_MONNIFY_CALLBACK_URL']) assert.ok(!output.includes(env[key]));
});

test('production, live keys and unsafe callbacks cannot pass sandbox readiness', () => {
 for (const override of [
  {NODE_ENV:'production'}, {MARKET_CHECKOUT_MODE:'live'}, {MARKET_MONNIFY_API_KEY:'MK_LIVE_example'},
  {MARKET_MONNIFY_CALLBACK_URL:'javascript:alert(1)'},
  {MARKET_MONNIFY_CALLBACK_URL:'https://user:secret@example.test/market-account.html'},
  {MARKET_MONNIFY_CALLBACK_URL:'https://example.test/market-account.html?secret=example'},
  {MARKET_MONNIFY_CALLBACK_URL:'http://example.test/market-account.html'}
 ]) assert.equal(monnifyReadiness({...env,...override}).sandbox_configured, false);
});

test('authentication probe only logs in to sandbox and never initializes a payment', async () => {
 const saved = globalThis.fetch;
 const calls = [];
 globalThis.fetch = async (url, options) => {
  calls.push(url);
  assert.equal(options.method, 'POST');
  assert.equal(options.body, undefined);
  return new Response(JSON.stringify({requestSuccessful:true,responseBody:{accessToken:'diagnostic-token-never-return',expiresIn:3600}}));
 };
 try {
  assert.equal(await checkMonnifyAuthentication({available:true,mode:'test',apiKey:env.MARKET_MONNIFY_API_KEY,key:env.MARKET_MONNIFY_SECRET_KEY}),true);
  assert.deepEqual(calls,['https://sandbox.monnify.com/api/v1/auth/login']);
  await assert.rejects(checkMonnifyAuthentication({available:true,mode:'live'}),e=>e.status===503);
  await assert.rejects(checkMonnifyAuthentication({available:false,mode:'test'}),e=>e.status===503);
  assert.equal(calls.length,1);
 } finally {globalThis.fetch = saved;}
});

test('offline command succeeds with sandbox settings and rejects live configuration without leaking keys', () => {
 const script = new URL('../scripts/check-monnify.js',import.meta.url);
 for (const [override, status] of [[{},0],[{NODE_ENV:'production'},1]]) {
  const result = spawnSync(process.execPath,[script.pathname],{env:{...process.env,...env,...override},encoding:'utf8'});
  assert.equal(result.status,status,result.stderr);
  for (const key of ['MARKET_MONNIFY_API_KEY','MARKET_MONNIFY_SECRET_KEY','MARKET_MONNIFY_CONTRACT_CODE']) assert.ok(!result.stdout.includes(env[key]));
  assert.equal(JSON.parse(result.stdout.slice(0,result.stdout.lastIndexOf('}')+1)).provider_credentials_verified,false);
 }
});
