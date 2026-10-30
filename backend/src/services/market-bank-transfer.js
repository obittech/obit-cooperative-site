import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {heldQuantity} from './market-stock.js';
import {validateRequestPickup} from './market-delivery.js';
import {audit} from '../utils/audit.js';
export function bankTransferConfig(){
 const bank_name=String(process.env.MARKET_TRANSFER_BANK_NAME||'').trim(),account_name=String(process.env.MARKET_TRANSFER_ACCOUNT_NAME||'').trim(),account_number=String(process.env.MARKET_TRANSFER_ACCOUNT_NUMBER||'').trim();
 return {available:process.env.MARKET_TRANSFER_ENABLED==='true'&&bank_name.length>1&&account_name.length>2&&/^\d{10}$/.test(account_number),bank_name,account_name,account_number,whatsapp:'2348030567787'};
}
async function orderFor(buyerId,id){const o=await get('SELECT * FROM market_purchase_orders WHERE id=? AND buyer_id=?',[id,buyerId]);if(!o)throw new HttpError(404,'Order not found');return o;}
function result(o,p){return {order_id:Number(o.id),reference:o.reference,amount_kobo:Number(p.amount_kobo),status:p.status,bank_name:p.bank_name,account_name:p.account_name,account_number:p.account_number,whatsapp_url:'https://wa.me/2348030567787?text='+encodeURIComponent(`Hello Obit, I have paid ₦${(Number(p.amount_kobo)/100).toLocaleString('en-NG')} for order ${o.reference}. Please verify my payment and follow up until I receive my goods.`)};}
export async function startBankTransfer(buyerId,id,body){
 return atomic(async()=>{
  const initial=await orderFor(buyerId,id);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[initial.id]);const o=await orderFor(buyerId,id);
  if(body.expected_total_kobo!==Number(o.total_kobo))throw new HttpError(409,'Refresh and review the order total.');
  const old=await get('SELECT * FROM market_bank_payments WHERE order_id=?',[o.id]);
  if(old){if(old.status==='READY'&&(o.status!=='AWAITING_PAYMENT'||Number(o.expires_ms)<=Date.now()))throw new HttpError(409,'Reservation expired. Contact support if you have transferred money.');return result(o,old);}
  const cfg=bankTransferConfig();if(!cfg.available)throw new HttpError(503,'Bank-transfer checkout is awaiting confirmation of the company receiving account.');
  const items=await all('SELECT listing_id,quantity FROM market_purchase_order_items WHERE order_id=? ORDER BY listing_id',[o.id]);
  if(!items.length)throw new HttpError(409,'This order contains no products.');
  for(const i of items)await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[i.listing_id]);
  if(o.status!=='AWAITING_PAYMENT'||Number(o.expires_ms)<=Date.now())throw new HttpError(409,'Reservation expired. Request a new quote.');
  for(const i of items){const stock=await get('SELECT quantity FROM market_inventory WHERE listing_id=?',[i.listing_id]);if(!stock||Number(stock.quantity)<await heldQuantity(i.listing_id))throw new HttpError(409,'Stock is no longer available. Request a new quote.');}
  if(await get('SELECT id FROM market_payment_attempts WHERE order_id=?',[o.id]))throw new HttpError(409,'Another payment attempt exists. Contact support before paying.');
  await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[o.shop_id])).request_id);
  await run("INSERT INTO market_bank_payments (order_id,status,amount_kobo,bank_name,account_name,account_number,created_ms) VALUES (?,'READY',?,?,?,?,?)",[o.id,o.total_kobo,cfg.bank_name,cfg.account_name,cfg.account_number,Date.now()]);
  await run('UPDATE market_purchase_orders SET expires_ms=? WHERE id=?',[Date.now()+45*60000,o.id]);
  return result(o,await get('SELECT * FROM market_bank_payments WHERE order_id=?',[o.id]));
 });
}
export async function claimBankTransfer(buyerId,id){
 return atomic(async()=>{
  const initial=await orderFor(buyerId,id);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[initial.id]);const o=await orderFor(buyerId,id),p=await get('SELECT * FROM market_bank_payments WHERE order_id=?',[o.id]);
  if(!p)throw new HttpError(409,'Open Pay Now before reporting payment.');
  if(p.status==='READY'){
   // Preserve reports received after expiry for staff review without reviving stock.
   const items=await all('SELECT listing_id FROM market_purchase_order_items WHERE order_id=? ORDER BY listing_id',[o.id]);
   for(const i of items)await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[i.listing_id]);
   const active=o.status==='AWAITING_PAYMENT'&&Number(o.expires_ms)>Date.now();
   await run('UPDATE market_bank_payments SET status=?,claimed_ms=? WHERE id=?',[active?'CLAIMED':'REVIEW',Date.now(),p.id]);
   if(active)await run('UPDATE market_purchase_orders SET expires_ms=? WHERE id=?',[Math.max(Number(o.expires_ms),Date.now()+24*3600000),o.id]);
   await audit(null,'MARKET_TRANSFER_REPORTED','market_purchase_orders',o.id);
  }
  return result(o,await get('SELECT * FROM market_bank_payments WHERE order_id=?',[o.id]));
 });
}
export async function bankPaymentOperations(){return all('SELECT b.*,o.reference AS order_reference FROM market_bank_payments b JOIN market_purchase_orders o ON o.id=b.order_id ORDER BY b.id DESC LIMIT 100');}
export async function verifyCreditForRefund(userId,id,body){
 const ref=String(body?.bank_reference||'').trim();
 if(body?.bank_credit_checked!==true||ref.length<6||ref.length>120)throw new HttpError(400,'Verify the actual bank credit and its unique reference first');
 return atomic(async()=>{
  if(!await get("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND role IN ('staff','admin')",[userId]))throw new HttpError(403,'Staff access required');
  await run('UPDATE market_auth_guard SET touched=touched+1 WHERE id=1');
  await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[id]);
  const p=await get('SELECT * FROM market_bank_payments WHERE order_id=?',[id]);
  if(!p||!['CLAIMED','REVIEW'].includes(p.status))throw new HttpError(409,'This payment is not awaiting credit review');
  if(body.amount_kobo!==Number(p.amount_kobo))throw new HttpError(409,'The actual credit must match this order amount');
  if(p.bank_reference){if(p.bank_reference!==ref)throw new HttpError(409,'This credit has another recorded reference');return {ok:true,replayed:true};}
  if(await get('SELECT id FROM market_bank_payments WHERE bank_reference=? AND id<>?',[ref,p.id]))throw new HttpError(409,'This bank credit is already assigned to another order');
  const now=Date.now();
  await run("UPDATE market_bank_payments SET status='REVIEW',bank_reference=?,confirmed_ms=?,confirmed_by=? WHERE id=?",[ref,now,userId,p.id]);
  // No stock commitment or fulfilment permission. Release any remaining hold.
  await run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[id]);
  if(!await get('SELECT id FROM market_return_cases WHERE order_id=?',[id]))await run("INSERT INTO market_return_cases (order_id,status,reason,created_ms,updated_ms) VALUES (?,'OPEN','Verified bank credit requires refund review. Goods have not been allocated.',?,?)",[id,now,now]);
  await run("INSERT INTO market_aftercare_events (order_id,kind,note,actor,occurred_ms) VALUES (?,'CREDIT_REFUND_REVIEW','Staff verified the bank credit for refund review. No goods allocated.','STAFF',?)",[id,now]);
  await audit(userId,'MARKET_CREDIT_REFUND_REVIEW','market_purchase_orders',id);return {ok:true,replayed:false};
 });
}
export async function confirmBankTransfer(userId,id,body){
 const ref=String(body.bank_reference||'').trim();
 if(body.bank_credit_checked!==true||ref.length<6||ref.length>120)throw new HttpError(400,'Check the actual bank credit and enter its unique transaction reference.');
 return atomic(async()=>{
  await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[id]);
  const o=await get('SELECT * FROM market_purchase_orders WHERE id=?',[id]),p=await get('SELECT * FROM market_bank_payments WHERE order_id=?',[id]);
  if(!o||!p)throw new HttpError(404,'Transfer checkout not found');
  if(body.amount_kobo!==Number(p.amount_kobo))throw new HttpError(409,'Bank credit amount must match the order total exactly.');
  if(p.status==='CONFIRMED'){if(p.bank_reference!==ref)throw new HttpError(409,'This order was confirmed with another bank reference.');return {status:'CONFIRMED',replayed:true};}
  if(!['CLAIMED','REVIEW'].includes(p.status))throw new HttpError(409,'The buyer has not reported payment.');
  if(await get('SELECT id FROM market_bank_payments WHERE bank_reference=? AND id<>?',[ref,p.id]))throw new HttpError(409,'This bank credit already belongs to another order.');
  if(o.status!=='AWAITING_PAYMENT'||Number(o.expires_ms)<=Date.now())throw new HttpError(409,'Reservation expired. Resolve stock and refund or fulfilment with the buyer before proceeding.');
  await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[o.shop_id])).request_id);
  const items=await all('SELECT listing_id,quantity FROM market_purchase_order_items WHERE order_id=? ORDER BY listing_id',[id]);
  for(const i of items)await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[i.listing_id]);
  if(Number(o.expires_ms)<=Date.now())throw new HttpError(409,'Reservation expired while checking stock. Contact the buyer.');
  for(const i of items){const stock=await get("SELECT inv.quantity,l.status,m.status AS member_status,c.status AS community_status FROM market_inventory inv JOIN market_listings l ON l.id=inv.listing_id JOIN members m ON m.id=l.seller_member_id JOIN communities c ON c.id=l.community_id WHERE inv.listing_id=?",[i.listing_id]);if(!stock||stock.status!=='ACTIVE'||stock.member_status!=='ACTIVE'||stock.community_status!=='ACTIVE'||Number(stock.quantity)<await heldQuantity(i.listing_id))throw new HttpError(409,'Stock unavailable. Resolve fulfilment or refund before confirmation.');}
  for(const i of items)await run('UPDATE market_inventory SET quantity=quantity-?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE listing_id=?',[i.quantity,i.listing_id]);
  await run("UPDATE market_bank_payments SET status='CONFIRMED',confirmed_ms=?,confirmed_by=?,bank_reference=? WHERE id=?",[Date.now(),userId,ref,p.id]);
  await audit(userId,'MARKET_TRANSFER_CONFIRMED','market_purchase_orders',id);
  return {status:'CONFIRMED',receipt_reference:'OBMR-'+o.reference};
 });
}

