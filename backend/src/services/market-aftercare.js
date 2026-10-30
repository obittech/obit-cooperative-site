import crypto from 'node:crypto';
import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {audit} from '../utils/audit.js';
import {orderDeliveries,validateRequestPickup} from './market-delivery.js';

function number(v,min=1){if(!Number.isSafeInteger(v)||v<min)throw new HttpError(400,'Enter a valid amount or version');return v;}
function text(v,min,max){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw new HttpError(400,'Enter a note or reference of the required length');return v.trim();}
async function access(actor,id){
 const o=await get('SELECT * FROM market_purchase_orders WHERE id=?',[id]);
 if(!o)throw new HttpError(404,'Order not found');
 if(actor.kind==='BUYER'){if(Number(o.buyer_id)!==Number(actor.id))throw new HttpError(404,'Order not found');}
 else if(actor.kind==='STAFF'){if(!await get("SELECT id FROM users WHERE id=? AND role IN ('staff','admin') AND status='ACTIVE'",[actor.id]))throw new HttpError(403,'Staff access required');}
 else throw new HttpError(403,'Order access required');
 return o;
}
async function lockOrder(actor,id){await access(actor,id);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[id]);return access(actor,id);}
async function paid(id,refundReview=false){const p=await get("SELECT * FROM market_bank_payments WHERE order_id=? AND (status='CONFIRMED' OR (status='REVIEW' AND bank_reference IS NOT NULL AND confirmed_ms IS NOT NULL))",[id]);if(!p||(!refundReview&&p.status!=='CONFIRMED'))throw new HttpError(409,'An actual bank credit must be confirmed first');return p;}
async function liveCase(id){return get("SELECT id FROM market_return_cases WHERE order_id=? AND status<>'REJECTED'",[id]);}
async function event(orderId,actor,kind,note){await run('INSERT INTO market_aftercare_events (order_id,kind,note,actor,occurred_ms) VALUES (?,?,?,?,?)',[orderId,kind,note,actor.kind,Date.now()]);await audit(actor.kind==='STAFF'?actor.id:null,'MARKET_'+kind,'market_purchase_orders',orderId);}
async function checkVersion(row,version){if(Number(row?.version)!==number(version))throw new HttpError(409,'This record changed. Refresh and review it again.');}

export async function aftercareSummaries(ids,staffView=false){
 if(!ids.length)return new Map();const marks=ids.map(()=>'?').join(',');
 const shipments=await all('SELECT * FROM market_manual_deliveries WHERE order_id IN ('+marks+')',ids);
 const cases=await all('SELECT * FROM market_return_cases WHERE order_id IN ('+marks+')',ids);
 const refunds=await all('SELECT r.* FROM market_manual_refunds r JOIN market_return_cases c ON c.id=r.case_id WHERE c.order_id IN ('+marks+') ORDER BY r.id',ids);
 const events=await all('SELECT * FROM market_aftercare_events WHERE order_id IN ('+marks+') ORDER BY id',ids);
 return new Map(ids.map(id=>{
  const d=shipments.find(s=>Number(s.order_id)===Number(id)),c=cases.find(s=>Number(s.order_id)===Number(id)),rs=refunds.filter(r=>Number(r.case_id)===Number(c?.id));
  return [Number(id),{delivery:d?{status:d.status,method:d.method,carrier:d.carrier,tracking_reference:d.tracking_reference,version:Number(d.version),updated_ms:Number(d.updated_ms)}:null,
   return_case:c?{id:Number(c.id),status:c.status,reason:c.reason,decision_note:c.decision_note,approved_kobo:Number(c.approved_kobo),refunded_kobo:rs.reduce((s,r)=>s+Number(r.amount_kobo),0),version:Number(c.version),refunds:rs.map(r=>({receipt_reference:r.receipt_reference,amount_kobo:Number(r.amount_kobo),recorded_ms:Number(r.recorded_ms),...(staffView?{bank_reference:r.bank_reference}: {})}))}:null,
   events:events.filter(e=>Number(e.order_id)===Number(id)).map(e=>({kind:e.kind,note:e.note,actor:e.actor,occurred_ms:Number(e.occurred_ms)}))}];
 }));
}
export async function readAftercare(actor,id){const o=await access(actor,id);const credit=await get("SELECT status FROM market_bank_payments WHERE order_id=? AND (status='CONFIRMED' OR (status='REVIEW' AND bank_reference IS NOT NULL AND confirmed_ms IS NOT NULL))",[id]);const confirmed=!!credit;return {order_id:Number(o.id),reference:o.reference,total_kobo:Number(o.total_kobo),payment_confirmed:confirmed,fulfilment_allowed:credit?.status==='CONFIRMED',...(actor.kind==='STAFF'?{address:JSON.parse(o.address_json)}:{}),...(await aftercareSummaries([o.id],actor.kind==='STAFF')).get(Number(o.id))};}

export async function updateManualDelivery(actor,id,body){
 const status=body?.status,note=text(body?.note,3,300);
 return atomic(async()=>{
  const o=await lockOrder(actor,id);await paid(id);
  if(await liveCase(id))throw new HttpError(409,'Resolve the return or refund case before progressing delivery');
  const d=await get('SELECT * FROM market_manual_deliveries WHERE order_id=?',[id]);
  if(!d){
   if(actor.kind!=='STAFF'||status!=='PREPARING'||body.version!==0)throw new HttpError(409,'Staff must prepare this delivery first');
   const pref=(await orderDeliveries([o.id])).get(Number(o.id));
   await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[o.shop_id])).request_id);
   await run("INSERT INTO market_manual_deliveries (order_id,method,status,updated_ms) VALUES (?,?,'PREPARING',?)",[id,pref?.method||'DOOR',Date.now()]);
  }else{
   await checkVersion(d,body.version);
   if(actor.kind==='BUYER'){
    if(status!=='RECEIVED'||!['IN_TRANSIT','READY_FOR_PICKUP'].includes(d.status)||body.receipt_confirmed!==true)throw new HttpError(409,'Confirm receipt only after receiving your goods');
   }else{
    const next=d.method==='PICKUP'?{PREPARING:['READY_FOR_PICKUP']}:{PREPARING:['IN_TRANSIT'],IN_TRANSIT:['DELIVERY_FAILED'],DELIVERY_FAILED:['IN_TRANSIT']};
    if(!next[d.status]?.includes(status))throw new HttpError(409,'This delivery transition is unavailable. The buyer confirms receipt.');
    if(d.method==='PICKUP')await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[o.shop_id])).request_id);
   }
   const carrier=actor.kind==='STAFF'?text(body.carrier||d.carrier,status==='IN_TRANSIT'?2:0,100):d.carrier;
   const tracking=actor.kind==='STAFF'?text(body.tracking_reference||d.tracking_reference,['IN_TRANSIT','READY_FOR_PICKUP'].includes(status)?3:0,120):d.tracking_reference;
   await run('UPDATE market_manual_deliveries SET status=?,carrier=?,tracking_reference=?,version=version+1,updated_ms=? WHERE order_id=?',[status,carrier,tracking,Date.now(),id]);
  }
  await event(id,actor,'DELIVERY_'+status,note);return {ok:true};
 });
}

export async function requestReturn(buyerId,id,body){
 const reason=text(body?.reason,10,1000),actor={kind:'BUYER',id:buyerId};
 return atomic(async()=>{
  await lockOrder(actor,id);await paid(id,true);
  const old=await get('SELECT id,reason FROM market_return_cases WHERE order_id=?',[id]);
  if(old){if(old.reason!==reason)throw new HttpError(409,'A case already exists for this order. Contact support with its reference.');return {id:Number(old.id),replayed:true};}
  const r=await run("INSERT INTO market_return_cases (order_id,status,reason,created_ms,updated_ms) VALUES (?,'OPEN',?,?,?)",[id,reason,Date.now(),Date.now()]);
  await event(id,actor,'RETURN_REQUESTED',reason);return {id:Number(r.lastInsertRowid),replayed:false};
 });
}

export async function decideReturn(userId,id,body){
 const actor={kind:'STAFF',id:userId},status=body?.status,note=text(body?.note,10,1000);
 return atomic(async()=>{
  const o=await lockOrder(actor,id);const p=await paid(id,true);
  const c=await get('SELECT * FROM market_return_cases WHERE order_id=?',[id]);if(!c)throw new HttpError(404,'Return case not found');await checkVersion(c,body.version);
  const next={OPEN:['RETURN_AUTHORISED','APPROVED','REJECTED'],RETURN_AUTHORISED:['RECEIVED','REJECTED'],RECEIVED:['APPROVED','REJECTED']};
  if(!next[c.status]?.includes(status))throw new HttpError(409,'This case transition is unavailable');
  const amount=status==='APPROVED'?number(body.amount_kobo):0;
  if(amount>Number(p.amount_kobo)||amount>Number(o.total_kobo))throw new HttpError(409,'Refund approval cannot exceed the confirmed payment');
  await run('UPDATE market_return_cases SET status=?,decision_note=?,approved_kobo=?,version=version+1,updated_ms=? WHERE id=?',[status,note,amount,Date.now(),c.id]);
  await event(id,actor,'RETURN_'+status,note);return {ok:true};
 });
}

export async function recordRefund(userId,id,body){
 const actor={kind:'STAFF',id:userId},ref=text(body?.bank_reference,6,120),amount=number(body?.amount_kobo);
 if(body.bank_debit_checked!==true||body.recipient_checked!==true)throw new HttpError(400,'Verify the actual bank debit and the buyer refund recipient first');
 return atomic(async()=>{
  // Serialise bank-reference checks across different orders and API replicas.
  await run('UPDATE market_auth_guard SET touched=touched+1 WHERE id=1');
  await lockOrder(actor,id);const p=await paid(id,true),c=await get('SELECT * FROM market_return_cases WHERE order_id=?',[id]);
  if(!c)throw new HttpError(404,'Return case not found');
  const old=await get('SELECT * FROM market_manual_refunds WHERE bank_reference=?',[ref]);
  if(old){if(Number(old.case_id)!==Number(c.id)||Number(old.amount_kobo)!==amount)throw new HttpError(409,'This bank reference is already recorded for another refund');return {receipt_reference:old.receipt_reference,replayed:true};}
  await checkVersion(c,body.version);
  if(!['APPROVED','PARTIALLY_REFUNDED'].includes(c.status))throw new HttpError(409,'Approve a refund before recording payment');
  const total=Number((await get('SELECT COALESCE(SUM(amount_kobo),0) AS n FROM market_manual_refunds WHERE case_id=?',[c.id])).n)+amount;
  if(total>Number(c.approved_kobo)||total>Number(p.amount_kobo))throw new HttpError(409,'Refund exceeds the approved or confirmed amount');
  const receipt='OBRF-'+crypto.randomBytes(8).toString('hex').toUpperCase();
  await run('INSERT INTO market_manual_refunds (case_id,amount_kobo,bank_reference,receipt_reference,recorded_by,recorded_ms) VALUES (?,?,?,?,?,?)',[c.id,amount,ref,receipt,userId,Date.now()]);
  const status=total===Number(c.approved_kobo)?'REFUNDED':'PARTIALLY_REFUNDED';
  await run('UPDATE market_return_cases SET status=?,version=version+1,updated_ms=? WHERE id=?',[status,Date.now(),c.id]);
  await event(id,actor,'REFUND_RECORDED','Bank refund recorded: '+receipt+'. Amount: NGN '+(amount/100).toFixed(2)+'.');
  return {receipt_reference:receipt,status,replayed:false};
 });
}
