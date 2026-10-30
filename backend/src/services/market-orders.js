import {aftercareSummaries} from './market-aftercare.js';
import {validateRequestPickup,orderDeliveries,shipmentSummaries,deliveryTestAvailable} from './market-delivery.js';
import {checkoutConfig,effectiveOrderStatus,committedSql} from './market-payment-state.js';
import crypto from 'node:crypto';
import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {integer,preview,sellerMember} from './market-commerce.js';
import {audit} from '../utils/audit.js';
export const HOLD_MS=15*60*1000, QUOTE_MS=7*86400000;
function dateMs(value){return value instanceof Date?value.getTime():Date.parse(String(value).replace(' ','T').replace(/(?<!Z)$/,'Z'));}
export const orderStatus=effectiveOrderStatus;
async function expire(row,now=Date.now()){
 if(orderStatus(row,now)!=='EXPIRED'||row.status!=='AWAITING_PAYMENT')return;
 await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[row.id]);
 if(await get("SELECT id FROM market_bank_payments WHERE order_id=? AND status IN ('CONFIRMED','CLAIMED','REVIEW')",[row.id]))return;
 if(await get('SELECT id FROM market_payment_attempts WHERE order_id=? AND stock_committed=1',[row.id]))return;
 const changed=await run("UPDATE market_purchase_orders SET status='EXPIRED' WHERE id=? AND status='AWAITING_PAYMENT' AND expires_ms<=?",[row.id,now]);
 if(changed.changes===1)await run("INSERT INTO market_purchase_order_events (order_id,kind,occurred_ms,note) VALUES (?,'EXPIRED',?,'Stock reservation expired. Check payment status before trying again.')",[row.id,row.expires_ms]);
}
export async function acceptQuote(buyerId,shopId,body){
 const id=integer(shopId,1,Number.MAX_SAFE_INTEGER,'quote');const expected=integer(body?.expected_total_kobo,1,400000000,'reviewed total');
 return atomic(async()=>{
  // Consistent order: buyer, quote parent, listing IDs ascending. Listing locks
  // serialize competing buyers and seller stock edits across database replicas.
  await run('UPDATE market_buyers SET display_name=display_name WHERE id=?',[buyerId]);
  const shop=await get(`SELECT s.*,r.buyer_id,r.status AS request_status,r.address_json FROM market_request_shops s JOIN market_purchase_requests r ON r.id=s.request_id WHERE s.id=? AND r.buyer_id=?`,[id,buyerId]);
  if(!shop)throw new HttpError(404,'Quote not found');
  await run('UPDATE market_purchase_requests SET status=status WHERE id=?',[shop.request_id]);
  const existing=await get('SELECT o.*,p.status AS payment_status,p.stock_committed,b.status AS bank_status FROM market_purchase_orders o LEFT JOIN market_payment_attempts p ON p.order_id=o.id LEFT JOIN market_bank_payments b ON b.order_id=o.id WHERE o.shop_id=? AND o.buyer_id=?',[id,buyerId]);
  if(existing){if(Number(existing.total_kobo)!==expected)throw new HttpError(409,'This quote already has an order with a different reviewed total');await expire(existing);return {id:Number(existing.id),reference:existing.reference,status:orderStatus(existing),replayed:true};}
  // Re-read after the parent lock: cancellation may have committed while waiting.
  const current=await get('SELECT status FROM market_purchase_requests WHERE id=?',[shop.request_id]);
  if(current.status!=='REQUESTED'||shop.status!=='QUOTED')throw new HttpError(409,'This quote is unavailable');
  const now=Date.now(),quoted=dateMs(shop.updated_at);
  if(!Number.isFinite(quoted)||quoted+QUOTE_MS<=now)throw new HttpError(409,'This quote expired. Request a new seller quote.');
  const active=await get("SELECT COUNT(*) AS n FROM market_purchase_orders WHERE buyer_id=? AND status='AWAITING_PAYMENT' AND expires_ms>? AND NOT "+committedSql('market_purchase_orders.id'),[buyerId,now]);
  const recent=await get('SELECT COUNT(*) AS n FROM market_purchase_orders WHERE buyer_id=? AND created_ms>?',[buyerId,now-3600000]);
  if(Number(active.n)>=2||Number(recent.n)>=10)throw new HttpError(429,'You can hold up to two unpaid orders at a time and create ten per hour.');
  await validateRequestPickup(shop.request_id);
  const rows=await all('SELECT listing_id,title,quantity,unit_kobo FROM market_request_items WHERE shop_id=? ORDER BY listing_id',[id]);
  if(!rows.length)throw new HttpError(409,'This quote contains no products');
  for(const item of rows)await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[item.listing_id]);
  const basket=await preview(rows.map(r=>({id:Number(r.listing_id),qty:Number(r.quantity)})));
  if(basket.lines.some(l=>!l.available||l.product.stock_quantity===null))throw new HttpError(409,'The seller must confirm sufficient stock before you can create an order.');
  const prices=new Map(basket.lines.map(l=>[l.id,Math.round(l.product.price*100)]));
  if(rows.some(r=>prices.get(Number(r.listing_id))!==Number(r.unit_kobo)))throw new HttpError(409,'Product prices changed. Request a new quote before ordering.');
  const subtotal=rows.reduce((n,r)=>n+Number(r.unit_kobo)*Number(r.quantity),0),delivery=Number(shop.delivery_kobo),total=subtotal+delivery;
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(delivery)||delivery<0||total!==expected)throw new HttpError(409,'The quote total changed. Refresh and review it again.');
  const ref='OBM-'+crypto.randomBytes(8).toString('hex').toUpperCase();
  const inserted=await run('INSERT INTO market_purchase_orders (reference,buyer_id,shop_id,seller_member_id,subtotal_kobo,delivery_kobo,total_kobo,address_json,created_ms,expires_ms) VALUES (?,?,?,?,?,?,?,?,?,?)',[ref,buyerId,id,shop.seller_member_id,subtotal,delivery,total,shop.address_json,now,now+HOLD_MS]);
  const orderId=Number(inserted.lastInsertRowid);
  for(const r of rows)await run('INSERT INTO market_purchase_order_items (order_id,listing_id,title,quantity,unit_kobo) VALUES (?,?,?,?,?)',[orderId,r.listing_id,r.title,r.quantity,r.unit_kobo]);
  await run("INSERT INTO market_purchase_order_events (order_id,kind,occurred_ms,note) VALUES (?,'CREATED',?,'Quote accepted. Unpaid order created with a 15-minute stock reservation.')",[orderId,now]);
  await audit(null,'MARKET_ORDER_CREATED','market_purchase_orders',orderId,{buyer_id:buyerId});
  return {id:orderId,reference:ref,status:'AWAITING_PAYMENT',expires_ms:now+HOLD_MS,replayed:false};
 });
}
async function orderRows(where,args,privateAddress=false){
 const rows=await all('SELECT * FROM market_purchase_orders WHERE '+where+' ORDER BY id DESC LIMIT 50',args);
 if(!rows.length)return [];
 await atomic(async()=>{for(const row of rows)await expire(row);});
 const ids=rows.map(r=>r.id),marks=ids.map(()=>'?').join(',');
 const items=await all('SELECT * FROM market_purchase_order_items WHERE order_id IN ('+marks+') ORDER BY id',ids);
 const events=await all('SELECT order_id,kind,occurred_ms,note FROM market_purchase_order_events WHERE order_id IN ('+marks+') ORDER BY occurred_ms,id',ids);
 // Re-read state to reflect a concurrent cancellation rather than the earlier snapshot.
 const states=await all('SELECT id,status,cancel_actor,cancel_reason,cancelled_ms FROM market_purchase_orders WHERE id IN ('+marks+')',ids);
 const payments=await all('SELECT order_id,reference,status,mode,amount_kobo,currency,stock_committed,review_reason FROM market_payment_attempts WHERE order_id IN ('+marks+')',ids);
 const paymentEvents=await all('SELECT p.order_id,e.kind,e.occurred_ms,e.note FROM market_payment_events e JOIN market_payment_attempts p ON p.id=e.attempt_id WHERE p.order_id IN ('+marks+')',ids);
 const bankPayments=await all('SELECT * FROM market_bank_payments WHERE order_id IN ('+marks+')',ids);
 const deliveries=await orderDeliveries(ids),shipments=await shipmentSummaries(ids),aftercare=await aftercareSummaries(ids);
 const stateMap=new Map(states.map(r=>[Number(r.id),r]));
 return rows.map(row=>{const bank=bankPayments.find(p=>Number(p.order_id)===Number(row.id));const payment=payments.find(p=>Number(p.order_id)===Number(row.id));const r={...row,...stateMap.get(Number(row.id)),payment_status:payment?.status,stock_committed:payment?.stock_committed,bank_status:bank?.status},a=JSON.parse(r.address_json);return {id:Number(r.id),reference:r.reference,shop_id:Number(r.shop_id),seller_id:Number(r.seller_member_id),status:orderStatus(r),created_ms:Number(r.created_ms),expires_ms:Number(r.expires_ms),subtotal_kobo:Number(r.subtotal_kobo),delivery_kobo:Number(r.delivery_kobo),total_kobo:Number(r.total_kobo),destination:{city:a.city,state:a.state},...(privateAddress?{address:a}:{}),bank_payment:bank?{status:bank.status,amount_kobo:Number(bank.amount_kobo),bank_name:bank.bank_name,account_name:bank.account_name,account_number:bank.account_number,confirmed_ms:bank.confirmed_ms?Number(bank.confirmed_ms):null,receipt_reference:bank.status==='CONFIRMED'?'OBMR-'+r.reference:null}:null,cancel_actor:r.cancel_actor,cancel_reason:r.cancel_reason,payment_available:checkoutConfig().available&&orderStatus(r)==='AWAITING_PAYMENT'&&(!payment||payment.status==='READY'),checkout_mode:checkoutConfig().mode,payment:payment?{reference:payment.reference,status:payment.status,mode:payment.mode,amount_kobo:Number(payment.amount_kobo),currency:payment.currency,review_reason:payment.review_reason}:null,cancellation_available:!bank&&orderStatus(r)==='AWAITING_PAYMENT'&&(!payment||payment.status==='FAILED'),dispatch_allowed:false,delivery_test_available:deliveryTestAvailable()&&orderStatus(r)==='TEST_PAID'&&deliveries.get(Number(r.id))?.available!==false,fulfilment:deliveries.get(Number(r.id))||{method:'DOOR',pickup:null},shipment:shipments.get(Number(r.id))||null,
  aftercare:aftercare.get(Number(r.id)),
  items:items.filter(i=>Number(i.order_id)===Number(r.id)).map(i=>({listing_id:Number(i.listing_id),title:i.title,quantity:Number(i.quantity),unit_kobo:Number(i.unit_kobo)})),
  events:[...events,...paymentEvents].filter(e=>Number(e.order_id)===Number(r.id)).sort((a,b)=>Number(a.occurred_ms)-Number(b.occurred_ms)).map(e=>({kind:e.kind,occurred_ms:Number(e.occurred_ms),note:e.note}))};});
}
export async function buyerOrders(buyerId){return orderRows('buyer_id=?',[buyerId],true);}
export async function sellerOrders(userId){const member=await sellerMember(userId);return orderRows('seller_member_id=?',[member.id]);}
export async function cancelOrder(actor,id,body){
 id=integer(id,1,Number.MAX_SAFE_INTEGER,'order');
 const buyerId=actor.buyerId,member=actor.userId?await sellerMember(actor.userId):null;
 if(!buyerId&&!member)throw new HttpError(403,'Order access required');
 const reason=typeof body?.reason==='string'?body.reason.trim():'';
 if(reason.length<3||reason.length>300)throw new HttpError(400,'Enter a cancellation reason from 3 to 300 characters');
 return atomic(async()=>{
  if(buyerId)await run('UPDATE market_buyers SET display_name=display_name WHERE id=?',[buyerId]);
  const clause=buyerId?'buyer_id=?':'seller_member_id=?',owner=buyerId||member.id;
  let row=await get('SELECT * FROM market_purchase_orders WHERE id=? AND '+clause,[id,owner]);
  if(!row)throw new HttpError(404,'Order not found');
  await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[id]);row=await get('SELECT * FROM market_purchase_orders WHERE id=?',[id]);
  if(await get('SELECT id FROM market_bank_payments WHERE order_id=?',[id]))throw new HttpError(409,'Contact payment support before cancelling a bank-transfer order.');
  const payment=await get('SELECT status,stock_committed FROM market_payment_attempts WHERE order_id=?',[id]);
  if(payment&&(Number(payment.stock_committed)||payment.status!=='FAILED'))throw new HttpError(409,'Check payment status before cancellation. Confirmed or uncertain payments require review.');
  await expire(row);
  const now=Date.now(),actorName=buyerId?'BUYER':'SELLER';
  const changed=await run("UPDATE market_purchase_orders SET status='CANCELLED',cancelled_ms=?,cancel_actor=?,cancel_reason=? WHERE id=? AND status='AWAITING_PAYMENT' AND expires_ms>?",[now,actorName,reason,id,now]);
  if(changed.changes===1){await run("INSERT INTO market_purchase_order_events (order_id,kind,occurred_ms,note) VALUES (?,'CANCELLED',?,?)",[id,now,actorName+': '+reason]);await audit(actor.userId||null,'MARKET_ORDER_CANCELLED','market_purchase_orders',id,{actor:actorName});}
  const current=await get('SELECT status FROM market_purchase_orders WHERE id=?',[id]);return {id,status:current.status,replayed:changed.changes===0};
 });
}
export async function operationsOrders(){
 const rows=await all("SELECT o.id,o.reference,o.status,o.total_kobo,o.address_json,o.created_ms,o.expires_ms,p.status AS payment_status,p.stock_committed,b.status AS bank_status,c.status AS return_status FROM market_purchase_orders o LEFT JOIN market_payment_attempts p ON p.order_id=o.id LEFT JOIN market_bank_payments b ON b.order_id=o.id LEFT JOIN market_return_cases c ON c.order_id=o.id ORDER BY CASE WHEN c.status IN ('OPEN','RETURN_AUTHORISED','RECEIVED','APPROVED','PARTIALLY_REFUNDED') THEN 0 ELSE 1 END,o.id DESC LIMIT 100");
 return rows.map(r=>{const a=JSON.parse(r.address_json);return {id:Number(r.id),reference:r.reference,status:orderStatus(r),return_status:r.return_status||null,total_kobo:Number(r.total_kobo),created_ms:Number(r.created_ms),expires_ms:Number(r.expires_ms),destination:{city:a.city,state:a.state}};});
}
