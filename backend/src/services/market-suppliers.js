import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {integer} from './market-commerce.js';
import {audit} from '../utils/audit.js';
const categories=['Solar & Power','Home Appliances','Phones & Computing','Business Equipment','Other'];
async function staff(id){if(!await get("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND role IN ('staff','admin')",[id]))throw new HttpError(403,'Active staff access required');}
function text(v,max=300){if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw new HttpError(400,'A required product field is missing or too long');return v.trim();}
function url(v){let u;try{u=new URL(text(v,2000));}catch{throw new HttpError(400,'Use a valid HTTPS URL');}if(u.protocol!=='https:'||u.username||u.password)throw new HttpError(400,'Use an HTTPS source or authorised image URL');return u.href;}
export function supplierPrice(p){
 const cost=integer(p.cost_kobo,1,300000000,'confirmed supplier cost'),handling=integer(p.handling_kobo??0,0,300000000,'handling cost'),markup=integer(p.markup_bps??0,0,100000,'markup');
 const price=cost+handling+Math.ceil(cost*markup/10000);
 return integer(price,1,300000000,'selling price');
}
function normalise(p){
 const row={source_key:text(p.source_key,160),supplier:text(p.supplier,160),source_url:url(p.source_url),title:text(p.title,180),description:text(p.description,3000),category:categories.includes(p.category)?p.category:'Other',image_url:p.image_url?url(p.image_url):'',cost_kobo:p.cost_kobo??null,handling_kobo:p.handling_kobo??0,markup_bps:p.markup_bps??0,observed_retail_kobo:p.observed_retail_kobo??null,quantity:p.quantity??0,seller_member_id:p.seller_member_id??null,delivery_days:p.delivery_days??null,agreement_reference:p.agreement_reference?text(p.agreement_reference,160):'',verification_reference:p.verification_reference?text(p.verification_reference,160):'',supply_confirmed:p.supply_confirmed===true,content_authorised:p.content_authorised===true,checked_ms:p.checked_ms??0};
 if(row.cost_kobo!==null)row.selling_kobo=supplierPrice(row);
 integer(row.quantity,0,100000,'supplier stock');integer(row.checked_ms,0,Number.MAX_SAFE_INTEGER,'verification time');
 if(row.checked_ms>Date.now())throw new HttpError(400,'Verification time cannot be in the future');return row;
}
export async function importSupplierDrafts(userId,items){
 await staff(userId);if(!Array.isArray(items)||!items.length||items.length>100)throw new HttpError(400,'Import 1 to 100 products');
 const rows=items.map(normalise);if(new Set(rows.map(r=>r.source_key)).size!==rows.length)throw new HttpError(400,'Duplicate source keys in this import');
 return atomic(async()=>{for(const row of rows){
  const old=await get('SELECT listing_id FROM market_supplier_drafts WHERE source_key=?',[row.source_key]);if(old?.listing_id)throw new HttpError(409,'Published source keys are immutable. Pause the listing and import a new source key for a revised offer.');
  await run('INSERT INTO market_supplier_drafts (source_key,payload_json,created_by,updated_ms) VALUES (?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET payload_json=excluded.payload_json,updated_ms=excluded.updated_ms',[row.source_key,JSON.stringify(row),userId,Date.now()]);
 }await audit(userId,'MARKET_SUPPLIER_IMPORT','market_supplier_drafts',null,{count:rows.length});return {imported:rows.length};});
}
export async function supplierDrafts(userId){await staff(userId);return (await all('SELECT * FROM market_supplier_drafts ORDER BY id DESC LIMIT 200')).map(r=>({id:Number(r.id),listing_id:r.listing_id,valid_until_ms:Number(r.valid_until_ms),...JSON.parse(r.payload_json)}));}
export async function publishSupplierDraft(userId,id){
 await staff(userId);return atomic(async()=>{
  await run('UPDATE market_supplier_drafts SET updated_ms=updated_ms WHERE id=?',[id]);
  const d=await get('SELECT * FROM market_supplier_drafts WHERE id=?',[id]);if(!d)throw new HttpError(404,'Supplier draft not found');if(d.listing_id)return {listing_id:Number(d.listing_id),replayed:true};
  const p=normalise(JSON.parse(d.payload_json)),price=supplierPrice(p),now=Date.now();
  if(!p.supply_confirmed||!p.content_authorised||!p.image_url||!p.agreement_reference||!p.verification_reference||p.checked_ms<now-86400000||p.quantity<1)throw new HttpError(409,'Confirm supply agreement, content permission, current price and stock within 24 hours, with evidence references and an authorised image');
  integer(p.delivery_days,1,60,'delivery estimate');integer(p.seller_member_id,1,Number.MAX_SAFE_INTEGER,'responsible member seller');
  const m=await get("SELECT id FROM members WHERE id=? AND status='ACTIVE'",[p.seller_member_id]);if(!m)throw new HttpError(409,'Assign an active approved cooperative-member seller');
  const c=await get("SELECT id FROM communities WHERE slug='obit-cooperative' AND status='ACTIVE'");if(!c)throw new HttpError(409,'Marketplace community is unavailable');
  const result=await run("INSERT INTO market_listings (community_id,seller_member_id,title,description,image_url,category,price_kobo,status) VALUES (?,?,?,?,?,?,?,'DRAFT')",[c.id,m.id,p.title,p.description+'\nSupplier delivery estimate: '+p.delivery_days+' days after payment confirmation. Final delivery charge and estimate are confirmed in your quote.',p.image_url,p.category,price]);
  await run('INSERT INTO market_inventory (listing_id,quantity) VALUES (?,?)',[result.lastInsertRowid,p.quantity]);
  await run('UPDATE market_supplier_drafts SET listing_id=?,valid_until_ms=?,updated_ms=? WHERE id=?',[result.lastInsertRowid,p.checked_ms+86400000,now,id]);
  await audit(userId,'MARKET_SUPPLIER_LISTING_PREPARED','market_listings',Number(result.lastInsertRowid));return {listing_id:Number(result.lastInsertRowid),status:'DRAFT',requires_listing_review:true};
 });
}
