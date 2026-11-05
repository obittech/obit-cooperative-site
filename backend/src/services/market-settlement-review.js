import {get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {audit} from '../utils/audit.js';
async function staff(id){if(!await get("SELECT id FROM users WHERE id=? AND role IN ('staff','admin') AND status='ACTIVE'",[id]))throw new HttpError(403,'Active staff access required');}
export async function verifySellerPayout(userId,sellerId,body){
 await staff(userId);
 const reference=String(body.evidence_reference||'').trim(),last=String(body.account_last_four||'');
 if(body.identity_checked!==true||body.payout_ownership_checked!==true||reference.length<6||reference.length>120||!/^\d{4}$/.test(last))throw new HttpError(400,'Check seller identity and matching bank ownership, then record the secure evidence reference and last four digits');
 return atomic(async()=>{
  if(!await get("SELECT id FROM members WHERE id=? AND status='ACTIVE'",[sellerId]))throw new HttpError(409,'Seller membership must be active');
  await run('INSERT INTO market_seller_payout_checks (seller_member_id,evidence_reference,account_last_four,reviewed_by,reviewed_ms) VALUES (?,?,?,?,?) ON CONFLICT(seller_member_id) DO UPDATE SET evidence_reference=excluded.evidence_reference,account_last_four=excluded.account_last_four,reviewed_by=excluded.reviewed_by,reviewed_ms=excluded.reviewed_ms',[sellerId,reference,last,userId,Date.now()]);
  await audit(userId,'MARKET_PAYOUT_OWNERSHIP_CHECKED','members',sellerId);return {ok:true};
 });
}
export async function settlementReview(userId,orderId){
 await staff(userId);
 const o=await get('SELECT * FROM market_purchase_orders WHERE id=?',[orderId]);if(!o)throw new HttpError(404,'Order not found');
 const seller=await get('SELECT status FROM members WHERE id=?',[o.seller_member_id]);
 const verification=await get('SELECT * FROM market_seller_payout_checks WHERE seller_member_id=?',[o.seller_member_id]);
 const payment=await get("SELECT id FROM market_bank_payments WHERE order_id=? AND status='CONFIRMED'",[o.id]);
 const delivery=await get("SELECT updated_ms FROM market_manual_deliveries WHERE order_id=? AND status='RECEIVED'",[o.id]);
 const problem=await get("SELECT id FROM market_return_cases WHERE order_id=? AND status<>'REJECTED'",[o.id]);
 const terms=await get('SELECT version FROM market_order_terms WHERE order_id=?',[o.id]);
 const blockers=[];
 if(seller?.status!=='ACTIVE')blockers.push('SELLER_INACTIVE');
 // Recheck ownership for every settlement and whenever the destination changes.
 if(!verification)blockers.push('PAYOUT_OWNERSHIP_UNVERIFIED');
 if(!payment)blockers.push('BANK_CREDIT_UNCONFIRMED');
 if(!delivery)blockers.push('BUYER_RECEIPT_UNCONFIRMED');
 if(problem)blockers.push('RETURN_OR_REFUND_CASE');
 if(!terms)blockers.push('LEGACY_TERMS_REVIEW_REQUIRED');
 return {order_id:Number(o.id),blockers,review_ready:blockers.length===0,payout_check:verification||null,terms_version:terms?.version||null,automated_release_available:false,note:'Review readiness does not authorise or execute a payout. Recheck the exact payout destination and delivery evidence before any manual settlement.'};
}
