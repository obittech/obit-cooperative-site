// Isolated HTTP regression smoke: synthetic SQLite only, no provider dispatch.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import crypto from 'node:crypto';
const backend = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'obit-access-http-'));
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const server = spawn(process.execPath, ['--experimental-sqlite', 'src/server.js'], { cwd: backend, env: {
  ...process.env, DB_ENGINE:'sqlite', DB_PATH:join(temporary,'synthetic.db'), PORT:String(port), NODE_ENV:'test',
  AUTH_TOKEN_SECRET:crypto.randomBytes(32).toString('hex'), YOUVERIFY_ENV:'sandbox', YOUVERIFY_SECRET_KEY:'', YOUVERIFY_PRODUCTION_AUTHORIZED:'false',
  PAYSTACK_SECRET_KEY:'', PAYSTACK_LIVE_ENABLED:'false', MONNIFY_SECRET_KEY:'', ENABLE_DEV_ROUTES:'false', DB_CUTOVER_SYNC:'false', MARKET_MONNIFY_ACCEPTANCE:'false',
  MARKET_CHECKOUT_MODE:'off', MARKET_TRANSFER_ENABLED:'false', RESEND_API_KEY:'', WEBHOOK_SANDBOX_MODE:'false',
}, stdio:['ignore','pipe','pipe'] });
let logs='';server.stdout.on('data',chunk=>{logs+=chunk;});server.stderr.on('data',chunk=>{logs+=chunk;});
const base=`http://127.0.0.1:${port}`;
async function call(method,path,body,token) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};
}
try {
  let ready=false;
  for(let i=0;i<50;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Local API did not start: '+logs);
  async function register() {
    const input={username:'http'+crypto.randomBytes(7).toString('hex'),password:'Synthetic-Password-123!',password_confirmation:'Synthetic-Password-123!',full_legal_name:'Synthetic HTTP Applicant',date_of_birth:'1990-01-01',phone:`080${crypto.randomInt(10000000,99999999)}`,email:`${crypto.randomUUID()}@example.invalid`,address:'Synthetic test only',state:'FCT',lga:'Abuja Municipal',membership_type:'Individual'};
    const result=await call('POST','/api/applications/register',input);assert.equal(result.status,201);assert.equal(result.cache,'no-store');
    return {input,id:result.body.id,token:result.body.application_token};
  }
  const a=await register(),b=await register();
  assert.equal((await call('GET',`/api/applications/${a.id}`)).status,401);
  assert.equal((await call('PATCH',`/api/applications/${a.id}`,{full_legal_name:'Unauthorized'},b.token)).status,403);
  assert.equal((await call('POST',`/api/applications/${a.id}/submit`,{consents:{terms:true,privacy:true}})).status,401);
  const own=await call('GET',`/api/applications/${a.id}`,undefined,a.token);assert.equal(own.status,200);assert.equal(own.cache,'no-store');assert.equal(own.body.full_legal_name,a.input.full_legal_name);
  assert.equal((await call('POST',`/api/applications/${a.id}/submit`,{consents:{terms:true,privacy:true}},a.token)).status,200);
  const session=await call('POST','/api/kyc/session',{application_id:a.id},a.token);assert.equal(session.status,201);
  assert.equal((await call('GET',`/api/kyc/${session.body.session_ref}/status`)).status,401);
  assert.equal((await call('GET',`/api/kyc/${session.body.session_ref}/status`,undefined,b.token)).status,403);
  assert.equal((await call('POST',`/api/kyc/session/${session.body.session_ref}/verify`,{type:'nin',id_number:'11111111111'},b.token)).status,403);
  assert.equal((await call('GET',`/api/kyc/${session.body.session_ref}/status`,undefined,a.token)).status,200);
  assert.equal((await call('POST','/api/applications/resume',{application_id:a.id})).status,401);
  const resume=await call('POST','/api/applications/resume',{username:a.input.username,password:a.input.password});assert.equal(resume.status,200);
  assert.equal((await call('GET',`/api/applications/${a.id}`,undefined,resume.body.application_token)).status,200);
  console.log('PASS: synthetic local HTTP registration, consent, resume, no-store, anonymous/cross-owner application and KYC guards. No provider verification requests.');
} finally {
  server.kill('SIGTERM');await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});
  await rm(temporary,{recursive:true,force:true});
}
