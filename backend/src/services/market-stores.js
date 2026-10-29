import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {integer,sellerMember} from './market-commerce.js';
import {audit} from '../utils/audit.js';
function text(value,min,max,label){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw new HttpError(400,'Check '+label);return value.trim();}
export async function sellerStore(userId){const member=await sellerMember(userId);const row=await get('SELECT name,description,status,official,version FROM market_stores WHERE seller_member_id=?',[member.id]);return row?{...row,official:Number(row.official)===1,version:Number(row.version)}:null;}
export async function submitStore(userId,body){
 const member=await sellerMember(userId),name=text(body?.name,3,80,'store name'),description=text(body?.description,0,500,'store description'),version=integer(body?.version,0,2147483646,'store version');
 return atomic(async()=>{
  await run('UPDATE members SET status=status WHERE id=?',[member.id]);
  const old=await get('SELECT version FROM market_stores WHERE seller_member_id=?',[member.id]);
  if(Number(old?.version||0)!==version)throw new HttpError(409,'Store profile changed. Refresh before submitting.');
  await run(`INSERT INTO market_stores (seller_member_id,name,description) VALUES (?,?,?) ON CONFLICT(seller_member_id) DO UPDATE SET name=excluded.name,description=excluded.description,status='PENDING',official=0,verification_note='',version=market_stores.version+1,updated_at=CURRENT_TIMESTAMP`,[member.id,name,description]);
  await audit(userId,'MARKET_STORE_SUBMITTED','members',member.id);
  return {ok:true,version:version+1};
 });
}
export async function reviewStores(){return all(`SELECT s.id,s.seller_member_id,s.name,s.description,s.status,s.official,s.version,s.verification_note,m.member_code,m.status AS member_status FROM market_stores s JOIN members m ON m.id=s.seller_member_id ORDER BY s.id DESC LIMIT 200`);}
export async function reviewStore(userId,id,body){
 id=integer(id,1,Number.MAX_SAFE_INTEGER,'store');const version=integer(body?.version,1,2147483646,'store version');
 if(!['APPROVED','REJECTED'].includes(body?.status)||typeof body?.official!=='boolean')throw new HttpError(400,'Choose a store decision');
 if(body.official&&body.status!=='APPROVED')throw new HttpError(400,'Only approved stores can be official');
 const evidence=text(body?.verification_note||'',body.official?10:0,1000,'brand authorisation evidence or review note');
 return atomic(async()=>{
  const changed=await run('UPDATE market_stores SET status=?,official=?,verification_note=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?',[body.status,body.official?1:0,evidence,id,version]);
  if(changed.changes!==1)throw new HttpError(409,'Store changed. Refresh and review again.');
  await audit(userId,'MARKET_STORE_REVIEWED','market_stores',id,{status:body.status,official:body.official});return {ok:true};
 });
}
export async function promotion(userId,id,body){
 id=integer(id,1,Number.MAX_SAFE_INTEGER,'product');const version=integer(body?.version,0,2147483646,'promotion version');
 if(typeof body?.enabled!=='boolean')throw new HttpError(400,'Choose whether to enable the promotion');
 return atomic(async()=>{
  const locked=await run('UPDATE market_listings SET updated_at=updated_at WHERE id=?',[id]);
  if(locked.changes!==1)throw new HttpError(404,'Listing not found');
  const old=await get('SELECT * FROM market_promotions WHERE listing_id=?',[id]);
  if(Number(old?.version||0)!==version)throw new HttpError(409,'Promotion changed. Refresh before editing.');
  if(!body.enabled){if(old)await run('UPDATE market_promotions SET enabled=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE listing_id=?',[id]);}
  else{
   const listing=await get('SELECT l.price_kobo,l.status,m.status AS member_status FROM market_listings l JOIN members m ON m.id=l.seller_member_id WHERE l.id=?',[id]);
   if(listing.status!=='ACTIVE'||listing.member_status!=='ACTIVE')throw new HttpError(409,'Promotions require an active approved listing and seller');
   const price=integer(body.price_kobo,2000000,300000000,'promotional price'),start=integer(body.starts_ms,0,8640000000000000,'start date'),end=integer(body.ends_ms,0,8640000000000000,'end date');
   const label=text(body.label,3,60,'promotion label');
   if(price>=Number(listing.price_kobo))throw new HttpError(400,'Promotion price must be lower than the listing price');
   if(end<=Date.now()||end<=start||end-start>90*86400000)throw new HttpError(400,'Choose a future end date within 90 days of the start');
   await run(`INSERT INTO market_promotions (listing_id,label,price_kobo,base_kobo,starts_ms,ends_ms) VALUES (?,?,?,?,?,?) ON CONFLICT(listing_id) DO UPDATE SET label=excluded.label,price_kobo=excluded.price_kobo,base_kobo=excluded.base_kobo,starts_ms=excluded.starts_ms,ends_ms=excluded.ends_ms,enabled=1,version=market_promotions.version+1,updated_at=CURRENT_TIMESTAMP`,[id,label,price,listing.price_kobo,start,end]);
  }
  await audit(userId,'MARKET_PROMOTION_UPDATED','market_listings',id,{enabled:body.enabled});return {ok:true};
 });
}
export async function promotions(){return all('SELECT listing_id,label,price_kobo,starts_ms,ends_ms,enabled,version FROM market_promotions ORDER BY id DESC LIMIT 500');}
