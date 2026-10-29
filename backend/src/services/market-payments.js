import {initializeMonnify,verifyMonnify,monnifyReceipt,monnifyCheckoutUrl,validMonnifySignature} from './market-monnify.js';
import crypto from 'node:crypto';
import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {integer} from './market-commerce.js';
import {checkoutConfig,effectiveOrderStatus} from './market-payment-state.js';
import {heldQuantity} from './market-stock.js';
import {audit} from '../utils/audit.js';
function enabled(){const cfg=checkoutConfig();if(!cfg.available)throw new HttpError(503,'Marketplace checkout is disabled. No payment was started.');return cfg;}
const checkoutUrl=monnifyCheckoutUrl;
function publicAttempt(row){return {provider:'monnify',reference:row.reference,status:row.status,mode:row.mode,amount_kobo:Number(row.amount_kobo),currency:row.currency,checkout_url:row.status==='READY'?checkoutUrl(row.checkout_url):null,review_reason:row.review_reason,stock_committed:Number(row.stock_committed)===1};}
async function ownOrder(buyerId,id){const row=await get('SELECT * FROM market_purchase_orders WHERE id=? AND buyer_id=?',[id,buyerId]);if(!row)throw new HttpError(404,'Order not found');return row;}
async function lockOrder(row){await run('UPDATE market_buyers SET display_name=display_name WHERE id=?',[row.buyer_id]);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[row.id]);}
async function event(id,kind,note){await run('INSERT INTO market_payment_events (attempt_id,kind,occurred_ms,note) VALUES (?,?,?,?) ON CONFLICT(attempt_id,kind) DO NOTHING',[id,kind,Date.now(),note]);}
export async function initializeCheckout(buyerId,orderId,body={}){
 const cfg=enabled(),id=integer(orderId,1,Number.MAX_SAFE_INTEGER,'order');
 const claim=await atomic(async()=>{
  const row=await ownOrder(buyerId,id);await lockOrder(row);
  const order=await ownOrder(buyerId,id),old=await get('SELECT * FROM market_payment_attempts WHERE order_id=?',[id]);
  if(old){if(body.expected_total_kobo!==Number(old.amount_kobo))throw new HttpError(409,'Review the original payment total.');if(!['SUCCEEDED','REVIEW'].includes(old.status)&&effectiveOrderStatus(order)!=='AWAITING_PAYMENT')throw new HttpError(409,'This reservation is no longer active. Check payment status before trying again.');return {old};}
  if(effectiveOrderStatus(order)!=='AWAITING_PAYMENT')throw new HttpError(409,'This reservation is no longer active. Request a new quote.');
  if(body.expected_total_kobo!==Number(order.total_kobo))throw new HttpError(409,'Review the current order total before opening checkout.');
  const buyer=await get('SELECT email FROM market_buyers WHERE id=?',[buyerId]);
  const reference='OBMP-'+crypto.randomBytes(16).toString('hex').toUpperCase();
  const result=await run("INSERT INTO market_payment_attempts (order_id,reference,mode,status,amount_kobo,currency,created_ms) VALUES (?,?,'test','INITIATING',?,'NGN',?)",[id,reference,order.total_kobo,Date.now()]);
  await run('UPDATE market_purchase_orders SET expires_ms=? WHERE id=?',[Date.now()+45*60000,id]);
  return {attemptId:Number(result.lastInsertRowid),reference,amount:Number(order.total_kobo),email:buyer.email};
 });
 if(claim.old)return {...publicAttempt(claim.old),replayed:true};
 try{
  const data=await initializeMonnify(cfg,{email:claim.email,amount:claim.amount,reference:claim.reference,orderId:id});
  const url=data.url;
  await atomic(async()=>{
   const row=await ownOrder(buyerId,id);await lockOrder(row);
   await run("UPDATE market_payment_attempts SET status='READY',checkout_url=?,provider_transaction_id=? WHERE id=? AND status='INITIATING'",[url,data.transactionReference,claim.attemptId]);
   await event(claim.attemptId,'CHECKOUT_READY','Test provider checkout created. No live payment enabled.');
  });
 }catch{
  await atomic(async()=>{await run("UPDATE market_payment_attempts SET status='UNKNOWN' WHERE id=? AND status='INITIATING'",[claim.attemptId]);await event(claim.attemptId,'CHECKOUT_UNCERTAIN','Checkout response was not confirmed. Check status before retrying.');});
  throw new HttpError(502,'Checkout could not be confirmed. Check payment status before trying again.');
 }
 return publicAttempt(await get('SELECT * FROM market_payment_attempts WHERE id=?',[claim.attemptId]));
}
const receipt=monnifyReceipt;
async function applyReceipt(attemptId,data){
 const received=receipt(data);
 return atomic(async()=>{
  const attempt=await get('SELECT * FROM market_payment_attempts WHERE id=?',[attemptId]);
  if(!attempt||received.reference!==attempt.reference)throw new HttpError(422,'Provider reference mismatch');
  const initial=await get('SELECT * FROM market_purchase_orders WHERE id=?',[attempt.order_id]);await lockOrder(initial);
  const order=await get('SELECT * FROM market_purchase_orders WHERE id=?',[initial.id]);
  const items=await all('SELECT * FROM market_purchase_order_items WHERE order_id=? ORDER BY listing_id',[order.id]);
  for(const item of items)await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[item.listing_id]);
  const current=await get('SELECT * FROM market_payment_attempts WHERE id=?',[attemptId]);
  if(current.provider_transaction_id&&current.provider_transaction_id!==received.id)throw new HttpError(422,'Provider transaction identifier changed');
  const reused=await get('SELECT id FROM market_payment_attempts WHERE provider_transaction_id=? AND id<>?',[received.id,attemptId]);
  if(reused)throw new HttpError(422,'Provider transaction already belongs to another order');
  if(current.status==='SUCCEEDED'&&received.status==='PAID'&&received.amount===Number(current.amount_kobo)&&received.total===Number(current.amount_kobo))return publicAttempt(current);
  let status=current.status,reason='',commit=false;
  if(received.total!==Number(current.amount_kobo)||(received.status==='PAID'&&received.amount!==Number(current.amount_kobo))||['PARTIALLY_PAID','OVERPAID'].includes(received.status)){status='REVIEW';reason='AMOUNT_MISMATCH';}
  else if(received.status==='PAID'){
   if(Number(current.stock_committed)===1){status='SUCCEEDED';}
   else if(order.status!=='AWAITING_PAYMENT'||Number(order.expires_ms)<=Date.now()){status='REVIEW';reason='PAYMENT_AFTER_RESERVATION';}
   else{
    for(const item of items){
     const stock=await get('SELECT i.quantity,l.status,m.status AS member_status FROM market_listings l JOIN members m ON m.id=l.seller_member_id LEFT JOIN market_inventory i ON i.listing_id=l.id WHERE l.id=?',[item.listing_id]);
     if(!stock||stock.quantity===null||stock.status!=='ACTIVE'||stock.member_status!=='ACTIVE'||Number(stock.quantity)<await heldQuantity(item.listing_id)){status='REVIEW';reason='STOCK_UNAVAILABLE';break;}
    }
    if(!reason){status='SUCCEEDED';commit=true;}
   }
  }else if(['FAILED','EXPIRED'].includes(received.status)&&!Number(current.stock_committed)){status='FAILED';}
  else if(Number(current.stock_committed)&&received.status!=='PAID'){status='REVIEW';reason='PROVIDER_STATUS_CHANGED';}
  else if(!['SUCCEEDED','REVIEW'].includes(current.status)){status=current.checkout_url?'READY':'UNKNOWN';}
  if(commit)for(const item of items)await run('UPDATE market_inventory SET quantity=quantity-?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE listing_id=?',[item.quantity,item.listing_id]);
  await run('UPDATE market_payment_attempts SET status=?,provider_transaction_id=?,stock_committed=?,verified_ms=?,review_reason=? WHERE id=?',[status,received.id,commit?1:Number(current.stock_committed),Date.now(),reason,attemptId]);
  if(status==='SUCCEEDED')await event(attemptId,'PAYMENT_VERIFIED','Test payment verified by the server. Test inventory committed once. No real money or dispatch.');
  if(status==='REVIEW')await event(attemptId,'PAYMENT_REVIEW','Provider receipt requires staff review. Do not pay again or dispatch.');
  if(status==='FAILED')await event(attemptId,'PAYMENT_FAILED','Provider reported a failed or abandoned test transaction.');
  await audit(null,'MARKET_TEST_PAYMENT_'+status,'market_payment_attempts',attemptId);
  return publicAttempt(await get('SELECT * FROM market_payment_attempts WHERE id=?',[attemptId]));
 });
}
async function verifyAttempt(row){
 const cfg=enabled();
 // A durable cooldown protects verification across browser sessions and replicas.
 await atomic(async()=>{
  const changed=await run('UPDATE market_payment_attempts SET last_verify_ms=? WHERE id=? AND last_verify_ms<?',[Date.now(),row.id,Date.now()-10000]);
  if(changed.changes!==1)throw new HttpError(429,'A status check is already running or was just completed. Wait ten seconds.');
 });
 let data;try{data=await verifyMonnify(cfg,row.reference);}catch{throw new HttpError(502,'The provider status is not confirmed. Do not pay again. Check status later.');}
 return applyReceipt(row.id,data);
}
export async function verifyCheckout(buyerId,orderId){
 enabled();const id=integer(orderId,1,Number.MAX_SAFE_INTEGER,'order');await ownOrder(buyerId,id);
 const row=await get('SELECT * FROM market_payment_attempts WHERE order_id=?',[id]);if(!row)throw new HttpError(404,'No payment attempt exists for this order');
 return verifyAttempt(row);
}
export async function reconcileCheckout(orderId){
 enabled();const id=integer(orderId,1,Number.MAX_SAFE_INTEGER,'order'),row=await get('SELECT * FROM market_payment_attempts WHERE order_id=?',[id]);if(!row)throw new HttpError(404,'Payment attempt not found');return verifyAttempt(row);
}
async function rawBytes(req){const chunks=[];let size=0;for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>1000000)throw new HttpError(413,'Payload too large');chunks.push(b);}return Buffer.concat(chunks);}
export async function handleMarketPaymentWebhook(req,res){
 const cfg=enabled(),raw=await rawBytes(req),signature=req.headers['monnify-signature'];
 if(!validMonnifySignature(raw,signature,cfg)&&!(signature===undefined&&process.env.MARKET_MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOK==='true'))throw new HttpError(401,'Invalid marketplace webhook signature');
 let payload;try{payload=JSON.parse(raw);}catch{throw new HttpError(400,'Invalid webhook JSON');}
 if(payload?.eventType!=='SUCCESSFUL_TRANSACTION')return res.json(200,{ignored:true});
 const candidate=receipt(payload.eventData,true);if(candidate.status!=='PAID')throw new HttpError(422,'Unexpected payment event status');
 const row=await get('SELECT * FROM market_payment_attempts WHERE reference=?',[candidate.reference]);if(!row)throw new HttpError(404,'Unknown marketplace payment reference');
 if(candidate.amount!==Number(row.amount_kobo)||candidate.total!==Number(row.amount_kobo))throw new HttpError(422,'Webhook amount mismatch');
 if(row.status==='SUCCEEDED'&&row.provider_transaction_id===candidate.id)return res.json(200,{ok:true,replayed:true});
 const result=await verifyAttempt(row);if(!['SUCCEEDED','REVIEW'].includes(result.status))throw new HttpError(503,'Provider confirmation is pending. Retry this notification.');res.json(200,{ok:true});
}
export async function paymentOperations(){
 const rows=await all('SELECT p.order_id,p.reference,p.mode,p.status,p.amount_kobo,p.provider_transaction_id,p.stock_committed,p.review_reason,p.verified_ms,o.reference AS order_reference FROM market_payment_attempts p JOIN market_purchase_orders o ON o.id=p.order_id ORDER BY p.id DESC LIMIT 100');
 return rows.map(r=>({...r,order_id:Number(r.order_id),amount_kobo:Number(r.amount_kobo),stock_committed:Number(r.stock_committed)===1}));
}
