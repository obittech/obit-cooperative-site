import crypto from 'node:crypto';
import {HttpError} from '../router.js';
import {parseNgnToKobo} from '../utils/money.js';
const BASE='https://sandbox.monnify.com';
let cached=null,inflight=null;
async function request(path,method,authorization,body){
 const response=await fetch(BASE+path,{method,redirect:'error',signal:AbortSignal.timeout(6000),headers:{Authorization:authorization,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 if(response.status===401)cached=null;
 const text=await response.text();if(text.length>100000)throw Error('Oversized provider response');
 const json=JSON.parse(text);if(!response.ok||json?.requestSuccessful!==true||!json.responseBody||typeof json.responseBody!=='object')throw Error('Monnify response could not be confirmed');return json.responseBody;
}
async function accessToken(cfg){
 const fingerprint=crypto.createHash('sha256').update(cfg.apiKey+':'+cfg.key).digest('hex');
 if(cached?.fingerprint===fingerprint&&cached.expires>Date.now())return cached.token;
 if(inflight?.fingerprint===fingerprint)return inflight.promise;
 const promise=(async()=>{const data=await request('/api/v1/auth/login','POST','Basic '+Buffer.from(cfg.apiKey+':'+cfg.key).toString('base64'));
  if(typeof data.accessToken!=='string'||data.accessToken.length<10||!Number.isSafeInteger(data.expiresIn)||data.expiresIn<60||data.expiresIn>86400)throw Error('Invalid Monnify token response');
  cached={fingerprint,token:data.accessToken,expires:Date.now()+(data.expiresIn-30)*1000};return data.accessToken;
 })();
 inflight={fingerprint,promise};try{return await promise;}finally{if(inflight?.promise===promise)inflight=null;}
}
// Authenticates only. Does not initialize a transaction or expose the token.
export async function checkMonnifyAuthentication(cfg){
 if(!cfg.available||cfg.mode!=='test')throw new HttpError(503,'Sandbox configuration is unavailable');
 await accessToken(cfg);return true;
}
export function monnifyCheckoutUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='sandbox.sdk.monnify.com'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname.startsWith('/checkout/')&&u.pathname.length>15?u.href:null;}catch{return null;}}
export async function initializeMonnify(cfg,{email,amount,reference,orderId}){
 const token=await accessToken(cfg);
 const data=await request('/api/v1/merchant/transactions/init-transaction','POST','Bearer '+token,{amount:amount/100,customerName:'Obit Market customer',customerEmail:email,paymentReference:reference,paymentDescription:'Obit Market sandbox order '+orderId,currencyCode:'NGN',contractCode:cfg.contract,redirectUrl:cfg.callback,paymentMethods:['CARD','ACCOUNT_TRANSFER'],metadata:{market_order_id:String(orderId),environment:'test'}});
 const url=monnifyCheckoutUrl(data.checkoutUrl);
 if(data.paymentReference!==reference||!url||typeof data.transactionReference!=='string'||!/^MNFY\|[A-Za-z0-9|_-]{3,150}$/.test(data.transactionReference))throw Error('Unexpected Monnify checkout response');
 return {url,transactionReference:data.transactionReference};
}
export async function verifyMonnify(cfg,reference){return request('/api/v2/merchant/transactions/query?paymentReference='+encodeURIComponent(reference),'GET','Bearer '+await accessToken(cfg));}
function money(value,allowZero=false){
 if(!['string','number'].includes(typeof value)||!/^\d+(?:\.\d{1,2})?$/.test(String(value)))throw new HttpError(422,'Invalid Monnify amount');
 try{return parseNgnToKobo(value,{minKobo:allowZero?0:1,maxKobo:400000000});}catch{throw new HttpError(422,'Invalid Monnify amount');}
}
export function monnifyReceipt(data,notification=false){
 if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.paymentReference!=='string'||!/^OBMP-[A-F0-9]{32}$/.test(data.paymentReference))throw new HttpError(422,'Invalid marketplace payment reference');
 const currency=notification?data.currency||data.currencyCode:data.currencyCode;
 if(currency!=='NGN'||typeof data.paymentStatus!=='string'||typeof data.transactionReference!=='string'||!/^MNFY\|[A-Za-z0-9|_-]{3,150}$/.test(data.transactionReference))throw new HttpError(422,'Invalid Monnify currency, reference or status');
 const statuses=['PAID','PENDING','PARTIALLY_PAID','OVERPAID','FAILED','REVERSED','EXPIRED'];if(!statuses.includes(data.paymentStatus))throw new HttpError(422,'Unknown Monnify payment status');
 return {id:data.transactionReference,reference:data.paymentReference,amount:money(data.amountPaid,true),total:money(data.totalPayable),currency,status:data.paymentStatus};
}
export function validMonnifySignature(raw,signature,cfg){return typeof signature==='string'&&/^[a-f0-9]{128}$/i.test(signature)&&crypto.timingSafeEqual(crypto.createHmac('sha512',cfg.key).update(raw).digest(),Buffer.from(signature,'hex'));}
