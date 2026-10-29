import crypto from 'node:crypto';
import { get, run, atomic } from '../db.js';
import { HttpError } from '../router.js';

// Separate key and subject: a shopper token can never authenticate as a
// cooperative member/admin, even when the two tables contain identical IDs.
function key() {
  if (!process.env.AUTH_TOKEN_SECRET) throw new Error('Authentication is not configured');
  return crypto.createHmac('sha256', process.env.AUTH_TOKEN_SECRET).update('obit-market-buyer-v1').digest();
}
function digest(value) { return crypto.createHmac('sha256', key()).update(value).digest('hex'); }
export function buyerToken(buyer) {
  const body = Buffer.from(JSON.stringify({ bid: Number(buyer.id), sv: Number(buyer.session_version),
    scope: 'market_buyer', exp: Math.floor(Date.now()/1000)+14400 })).toString('base64url');
  return body+'.'+digest(body);
}
export function readBuyerToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length!==2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
    if (!crypto.timingSafeEqual(Buffer.from(parts[1],'hex'),Buffer.from(digest(parts[0]),'hex'))) return null;
    const p=JSON.parse(Buffer.from(parts[0],'base64url').toString());
    return p.scope==='market_buyer' && Number.isSafeInteger(p.bid) && p.bid>0 && p.exp>Math.floor(Date.now()/1000) ? p : null;
  } catch { return null; }
}
export async function requireBuyer(req) {
  const header=req.headers.authorization || '';
  const p=readBuyerToken(header.startsWith('Bearer ')?header.slice(7):'');
  const buyer=p?await get('SELECT * FROM market_buyers WHERE id=?',[p.bid]):null;
  if (!buyer || buyer.status!=='ACTIVE' || Number(buyer.session_version)!==p.sv) throw new HttpError(401,'Sign in to your shopping account');
  req.buyer=buyer;
}
export async function requestBuyerCode(rawEmail, send=sendCode) {
  const email=typeof rawEmail==='string'?rawEmail.trim().toLowerCase():'';
  if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400,'Enter a valid email address');
  if (send===sendCode && !process.env.RESEND_API_KEY) throw new HttpError(503,'Shopping account email is not configured yet');
  const reference=crypto.randomUUID(), code=crypto.randomInt(100000,1000000).toString(), now=Date.now();
  await atomic(async()=>{
    // A database row serialises issuance across replicas and different emails.
    await run('UPDATE market_auth_guard SET touched=touched+1 WHERE id=1');
    const recent=await get('SELECT COUNT(*) AS n, MAX(created_ms) AS latest FROM market_login_challenges WHERE email=? AND created_ms>?',[email,now-3600000]);
    const global=await get('SELECT COUNT(*) AS n FROM market_login_challenges WHERE created_ms>?',[now-3600000]);
    if (Number(recent.n)>=5 || Number(recent.latest)>now-60000 || Number(global.n)>=200) throw new HttpError(429,'Please wait before requesting another code');
    await run('DELETE FROM market_login_challenges WHERE created_ms<?',[now-86400000]);
    await run('INSERT INTO market_login_challenges (reference,email,code_hash,expires_ms,created_ms) VALUES (?,?,?,?,?)',
      [reference,email,digest(reference+':'+code),now+600000,now]);
  });
  try { await send(email,code); }
  catch {
    await atomic(()=>run('UPDATE market_login_challenges SET consumed=1 WHERE reference=?',[reference]));
    throw new HttpError(503,'We could not send your sign-in code. Please try again later.');
  }
  return { challenge:reference, expires_in:600, message:'Check your email for a six-digit sign-in code.' };
}
export async function verifyBuyerCode(reference, code) {
  if (typeof reference!=='string' || reference.length>60 || typeof code!=='string' || !/^\d{6}$/.test(code)) throw new HttpError(401,'Invalid or expired code');
  const result=await atomic(async()=>{
    const claim=await run('UPDATE market_login_challenges SET attempts=attempts+1 WHERE reference=? AND consumed=0 AND attempts<5 AND expires_ms>?',[reference,Date.now()]);
    if (claim.changes!==1) return {error:true};
    const challenge=await get('SELECT * FROM market_login_challenges WHERE reference=?',[reference]);
    if (!crypto.timingSafeEqual(Buffer.from(challenge.code_hash,'hex'),Buffer.from(digest(reference+':'+code),'hex'))) return {error:true};
    await run('UPDATE market_login_challenges SET consumed=1 WHERE id=?',[challenge.id]);
    await run("INSERT INTO market_buyers (email) VALUES (?) ON CONFLICT(email) DO NOTHING",[challenge.email]);
    const buyer=await get('SELECT * FROM market_buyers WHERE email=?',[challenge.email]);
    if (buyer.status!=='ACTIVE') return {error:true};
    return {token:buyerToken(buyer),buyer:{id:Number(buyer.id),email:buyer.email,display_name:buyer.display_name}};
  });
  if (result.error) throw new HttpError(401,'Invalid or expired code');
  return result;
}
async function sendCode(email, code) {
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',signal:AbortSignal.timeout(10000),
    headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:process.env.RESEND_FROM_EMAIL || 'Obit Market <onboarding@resend.dev>',to:[email],
      subject:'Your Obit Market sign-in code',
      html:`<h2>Obit Market</h2><p>Your shopping account sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. Do not share this code. Ignore this email if you did not request it.</p>`})
  });
  if (!response.ok) throw new Error('Email unavailable');
}
