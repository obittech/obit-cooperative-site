import crypto from 'node:crypto';
import { all, get, run, atomic } from '../db.js';
import { HttpError } from '../router.js';
import { audit } from '../utils/audit.js';

const CATEGORIES=['Solar & Power','Home Appliances','Phones & Computing','Business Equipment','Other'];
export const STATES=['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'];
const PROMO_ACTIVE="p.enabled=1 AND p.starts_ms<=CAST(? AS BIGINT) AND p.ends_ms>CAST(? AS BIGINT) AND p.base_kobo=l.price_kobo AND p.price_kobo<l.price_kobo";
const BASE=` FROM market_listings l JOIN members m ON m.id=l.seller_member_id
 JOIN communities c ON c.id=l.community_id LEFT JOIN market_inventory i ON i.listing_id=l.id
 LEFT JOIN market_stores s ON s.seller_member_id=l.seller_member_id AND s.status='APPROVED'
 LEFT JOIN market_promotions p ON p.listing_id=l.id`;
const ACTIVE="l.status='ACTIVE' AND m.status='ACTIVE' AND c.status='ACTIVE' AND c.slug='obit-cooperative'";
const FIELDS='l.id,l.seller_member_id,l.title,l.description,l.category,l.price_kobo,l.currency,l.image_url,l.created_at,i.quantity AS stock_quantity,s.name AS store_name,s.description AS store_description,s.official AS store_official,p.label AS promo_label,p.price_kobo AS promo_price,p.base_kobo AS promo_base,p.starts_ms,p.ends_ms,p.enabled AS promo_enabled';
function sale(row,now=Date.now()){return Number(row.promo_enabled)===1 && Number(row.starts_ms)<=now && Number(row.ends_ms)>now && Number(row.promo_base)===Number(row.price_kobo) && Number(row.promo_price)<Number(row.price_kobo);}
export function product(row,now=Date.now()) {
  return {id:Number(row.id),seller_id:Number(row.seller_member_id),seller_name:row.store_name||'Member shop '+row.seller_member_id,official_store:Number(row.store_official)===1,
    title:row.title,description:row.description,category:row.category,price:Number(sale(row,now)?row.promo_price:row.price_kobo)/100,
    promotion:sale(row,now)?{label:row.promo_label,ends_ms:Number(row.ends_ms)}:null,
    currency:row.currency,image_url:row.image_url,created_at:row.created_at,
    stock_quantity:row.stock_quantity===null||row.stock_quantity===undefined?null:Number(row.stock_quantity)};
}
export function integer(value, min, max, label) {
  if (typeof value==='boolean' || value===null || value==='' || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max) throw new HttpError(400,`Invalid ${label}`);
  return Number(value);
}
export function itemsInput(input, allowEmpty=false) {
  if (!Array.isArray(input) || input.length>(100) || (!allowEmpty&&!input.length)) throw new HttpError(400,'Choose 1 to 100 different products');
  const ids=new Set();
  return input.map(row=>{
    const id=integer(row?.id,1,Number.MAX_SAFE_INTEGER,'product'), qty=integer(row?.qty,1,99,'quantity');
    if (ids.has(id)) throw new HttpError(400,'Duplicate product');
    ids.add(id);return {id,qty};
  }).sort((a,b)=>a.id-b.id);
}
export async function catalogue(search) {
  const page=integer(search.get('page')||1,1,1000000,'page'), size=integer(search.get('page_size')||24,1,48,'page size');
  const q=(search.get('q')||'').trim();if(q.length>120)throw new HttpError(400,'Search is too long');
  const now=Date.now(), filters=[ACTIVE], args=[];
  const price=`(CASE WHEN ${PROMO_ACTIVE.replaceAll('CAST(? AS BIGINT)',String(now))} THEN p.price_kobo ELSE l.price_kobo END)`;
  for(const key of ['official','promotions'])if(search.has(key)&&!['0','1'].includes(search.get(key)))throw new HttpError(400,'Invalid shop filter');
  if(search.get('official')==='1')filters.push('s.official=1');
  if(search.get('promotions')==='1'){filters.push(PROMO_ACTIVE);args.push(now,now);}
  if(q){filters.push("LOWER(l.title||' '||COALESCE(l.description,'')||' '||l.category) LIKE ? ESCAPE '!'");args.push('%'+q.toLowerCase().replace(/[!%_]/g,'!$&')+'%');}
  if(search.get('category') && search.get('category')!=='All products'){
    if(!CATEGORIES.includes(search.get('category')))throw new HttpError(400,'Invalid category');
    filters.push("(CASE WHEN (LOWER(l.category) LIKE '%solar%' OR LOWER(l.category) LIKE '%power%' OR LOWER(l.category) LIKE '%energy%' OR LOWER(l.category) LIKE '%inverter%' OR LOWER(l.category) LIKE '%battery%') THEN 'Solar & Power' WHEN (LOWER(l.category) LIKE '%phone%' OR LOWER(l.category) LIKE '%comput%' OR LOWER(l.category) LIKE '%laptop%' OR LOWER(l.category) LIKE '%tablet%' OR LOWER(l.category) LIKE '%gadget%') THEN 'Phones & Computing' WHEN (LOWER(l.category) LIKE '%appliance%' OR LOWER(l.category) LIKE '%kitchen%' OR LOWER(l.category) LIKE '%home%' OR LOWER(l.category) LIKE '%freezer%' OR LOWER(l.category) LIKE '%fridge%' OR LOWER(l.category) LIKE '%washing%' OR LOWER(l.category) LIKE '%cooling%') THEN 'Home Appliances' WHEN (LOWER(l.category) LIKE '%business%' OR LOWER(l.category) LIKE '%equipment%' OR LOWER(l.category) LIKE '%tool%' OR LOWER(l.category) LIKE '%machine%') THEN 'Business Equipment' ELSE 'Other' END)=?");args.push(search.get('category'));
  }
  if(search.get('seller')){filters.push('l.seller_member_id=?');args.push(integer(search.get('seller'),1,Number.MAX_SAFE_INTEGER,'seller'));}
  for(const [key,operator] of [['min_kobo','>='],['max_kobo','<=']])if(search.has(key)){filters.push(price+operator+'?');args.push(integer(search.get(key),0,300000000,'price'));}
  if(search.has('ids')){
    const ids=search.get('ids')?search.get('ids').split(',').map(x=>integer(x,1,Number.MAX_SAFE_INTEGER,'saved product')):[];
    if(ids.length>100)throw new HttpError(400,'Too many saved products');
    if(ids.length){filters.push('l.id IN ('+ids.map(()=>'?').join(',')+')');args.push(...ids);}else filters.push('1=0');
  }
  const order={'newest':'l.id DESC','price-low':price+' ASC,l.id DESC','price-high':price+' DESC,l.id DESC'}[search.get('sort')||'newest'];
  if(!order)throw new HttpError(400,'Invalid sort');
  const where=' WHERE '+filters.join(' AND ');
  const total=Number((await get('SELECT COUNT(*) AS n'+BASE+where,args)).n);
  const rows=await all('SELECT '+FIELDS+BASE+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',[...args,size,(page-1)*size]);
  const shops=await all('SELECT DISTINCT l.seller_member_id,s.name,s.description,s.official'+BASE+' WHERE '+ACTIVE+' ORDER BY l.seller_member_id LIMIT 500');
  return {items:rows.map(r=>product(r,now)),total,page,page_size:size,pages:Math.ceil(total/size),shops:shops.map(r=>({id:Number(r.seller_member_id),name:r.name||'Member shop '+r.seller_member_id,description:r.description||'',official:Number(r.official)===1}))};
}
export async function preview(input) {
  const items=itemsInput(input,true);
  if(!items.length)return {items:[],lines:[],total_kobo:0,count:0};
  const rows=await all('SELECT '+FIELDS+BASE+' WHERE '+ACTIVE+' AND l.id IN ('+items.map(()=>'?').join(',')+')',items.map(i=>i.id));
  const now=Date.now();
  const byId=new Map(rows.map(r=>[Number(r.id),r]));let total=0,count=0;
  const lines=items.map(item=>{
    const row=byId.get(item.id);const available=!!row && (row.stock_quantity===null || Number(row.stock_quantity)>=item.qty);
    const priced=row?product(row,now):null;
    const subtotal=priced?Math.round(priced.price*100)*item.qty:0;
    if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(total+subtotal))throw new HttpError(400,'Total is too large');
    if(available){total+=subtotal;count+=item.qty;}
    return {...item,available,product:priced,subtotal_kobo:available?subtotal:0};
  });
  return {items,lines,total_kobo:total,count};
}
async function lockBuyer(id){await run('UPDATE market_buyers SET display_name=display_name WHERE id=?',[id]);}
export async function buyerCart(id){return preview((await all('SELECT listing_id AS id,quantity AS qty FROM market_carts WHERE buyer_id=? ORDER BY id',[id])).map(r=>({id:Number(r.id),qty:Number(r.qty)})));}
export async function changeCart(buyerId,id,qty) {
  id=integer(id,1,Number.MAX_SAFE_INTEGER,'product');qty=integer(qty,0,99,'quantity');
  await atomic(async()=>{
    await lockBuyer(buyerId);
    if(qty===0){await run('DELETE FROM market_carts WHERE buyer_id=? AND listing_id=?',[buyerId,id]);return;}
    const state=await preview([{id,qty}]);
    if(!state.lines[0].available)throw new HttpError(409,'This quantity is not currently available');
    const count=await get('SELECT COUNT(*) AS n FROM market_carts WHERE buyer_id=?',[buyerId]);
    const existing=await get('SELECT id FROM market_carts WHERE buyer_id=? AND listing_id=?',[buyerId,id]);
    if(!existing&&Number(count.n)>=100)throw new HttpError(400,'Your bag holds up to 100 different products');
    await run('INSERT INTO market_carts (buyer_id,listing_id,quantity) VALUES (?,?,?) ON CONFLICT(buyer_id,listing_id) DO UPDATE SET quantity=excluded.quantity',[buyerId,id,qty]);
  });return buyerCart(buyerId);
}
export async function mergeCart(buyerId,input) {
  const incoming=itemsInput(input,true);let skipped=[];
  await atomic(async()=>{
    await lockBuyer(buyerId);
    const existing=await all('SELECT listing_id,quantity FROM market_carts WHERE buyer_id=?',[buyerId]);
    const map=new Map(existing.map(r=>[Number(r.listing_id),Number(r.quantity)]));
    const valid=await preview(incoming);skipped=valid.lines.filter(l=>!l.available).map(l=>({id:l.id,qty:l.qty}));
    for(const line of valid.lines)if(line.available)map.set(line.id,Math.max(map.get(line.id)||0,line.qty));
    if(map.size>100)throw new HttpError(400,'Your combined bag exceeds 100 different products');
    for(const [id,qty]of map)await run('INSERT INTO market_carts (buyer_id,listing_id,quantity) VALUES (?,?,?) ON CONFLICT(buyer_id,listing_id) DO UPDATE SET quantity=excluded.quantity',[buyerId,id,qty]);
  });return {...await buyerCart(buyerId),skipped_items:skipped};
}
function text(value,min,max,label){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw new HttpError(400,`Check ${label}`);return value.trim();}
export function addressInput(input) {
  const a={recipient:text(input?.recipient,2,100,'recipient name'),phone:text(input?.phone,10,20,'phone number'),
    address:text(input?.address,8,300,'street address'),city:text(input?.city,2,100,'town or city'),state:text(input?.state,2,40,'state'),country:'NG'};
  if(!/^[+\d ()-]+$/.test(a.phone)||a.phone.replace(/\D/g,'').length<10||a.phone.replace(/\D/g,'').length>15||!STATES.includes(a.state))throw new HttpError(400,'Enter a valid Nigerian phone number and state');
  if(input.country && input.country!=='NG')throw new HttpError(400,'Delivery requests currently support Nigeria');
  return a;
}
export async function saveAddress(buyerId,input) {
  const a=addressInput(input);
  await atomic(()=>run(`INSERT INTO market_addresses (buyer_id,recipient,phone,address,city,state,country) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(buyer_id) DO UPDATE SET recipient=excluded.recipient,phone=excluded.phone,address=excluded.address,city=excluded.city,state=excluded.state,country=excluded.country,updated_at=CURRENT_TIMESTAMP`,[buyerId,a.recipient,a.phone,a.address,a.city,a.state,a.country]));
  return a;
}
export async function createRequest(buyerId, body) {
  const items=itemsInput(body?.items), address=addressInput(body?.address);
  const requestKey=text(body?.request_key,16,80,'request reference');
  const payloadHash=crypto.createHash('sha256').update(JSON.stringify({items,address,expected_total_kobo:body.expected_total_kobo})).digest('hex');
  return atomic(async()=>{
    await lockBuyer(buyerId);
    const old=await get('SELECT * FROM market_purchase_requests WHERE buyer_id=? AND request_key=?',[buyerId,requestKey]);
    if(old){if(old.payload_hash!==payloadHash)throw new HttpError(409,'This request reference was already used for different details');return {id:Number(old.id),reference:old.reference,replayed:true};}
    const count=await get("SELECT COUNT(*) AS n FROM market_purchase_requests WHERE buyer_id=? AND created_at>datetime('now','-1 hour')",[buyerId]);
    if(Number(count.n)>=10)throw new HttpError(429,'Please wait before submitting more requests');
    const basket=await preview(items);
    if(basket.lines.some(l=>!l.available))throw new HttpError(409,'Some products or quantities are unavailable. Refresh your bag.');
    if(basket.total_kobo>300000000)throw new HttpError(400,'The current request limit is ₦3,000,000');
    // The displayed estimate is acknowledged by the buyer; prices are never
    // accepted from the browser as the amount to charge.
    if(body.expected_total_kobo!==basket.total_kobo)throw new HttpError(409,'Prices changed. Refresh your bag and review the updated total.');
    const reference='OBQ-'+crypto.randomBytes(8).toString('hex').toUpperCase();
    const insert=await run('INSERT INTO market_purchase_requests (reference,buyer_id,request_key,payload_hash,address_json,subtotal_kobo) VALUES (?,?,?,?,?,?)',[reference,buyerId,requestKey,payloadHash,JSON.stringify(address),basket.total_kobo]);
    const id=Number(insert.lastInsertRowid), shops=new Map();
    for(const line of basket.lines){
      const seller=line.product.seller_id;
      if(!shops.has(seller)){
        const shop=await run('INSERT INTO market_request_shops (request_id,seller_member_id) VALUES (?,?)',[id,seller]);shops.set(seller,Number(shop.lastInsertRowid));
      }
      await run('INSERT INTO market_request_items (shop_id,listing_id,title,quantity,unit_kobo) VALUES (?,?,?,?,?)',[shops.get(seller),line.id,line.product.title,line.qty,Math.round(line.product.price*100)]);
    }
    await audit(null,'MARKET_QUOTE_REQUESTED','market_purchase_requests',id,{buyer_id:buyerId});
    return {id,reference,replayed:false};
  });
}
export async function buyerRequests(buyerId) {
  const requests=await all('SELECT id,reference,status,subtotal_kobo,address_json,created_at FROM market_purchase_requests WHERE buyer_id=? ORDER BY id DESC LIMIT 50',[buyerId]);
  // Three bounded queries, rather than one round trip for every item/shop.
  if(!requests.length)return [];
  const ids=requests.map(r=>Number(r.id)), marks=ids.map(()=>'?').join(',');
  const shops=await all('SELECT * FROM market_request_shops WHERE request_id IN ('+marks+') ORDER BY id',ids);
  const rows=await all('SELECT i.* FROM market_request_items i JOIN market_request_shops s ON s.id=i.shop_id WHERE s.request_id IN ('+marks+') ORDER BY i.id',ids);
  return requests.map(r=>({...r,id:Number(r.id),subtotal_kobo:Number(r.subtotal_kobo),address:JSON.parse(r.address_json),address_json:undefined,
    shops:shops.filter(s=>Number(s.request_id)===Number(r.id)).map(s=>({...s,id:Number(s.id),seller_member_id:Number(s.seller_member_id),delivery_kobo:s.delivery_kobo===null?null:Number(s.delivery_kobo),
      items:rows.filter(i=>Number(i.shop_id)===Number(s.id)).map(i=>({...i,unit_kobo:Number(i.unit_kobo)}))}))}));
}
export async function cancelRequest(buyerId,id) {
  id=integer(id,1,Number.MAX_SAFE_INTEGER,'request');
  return atomic(async()=>{
    const updated=await run("UPDATE market_purchase_requests SET status='CANCELLED' WHERE id=? AND buyer_id=? AND status='REQUESTED'",[id,buyerId]);
    if(updated.changes!==1)throw new HttpError(409,'Request is unavailable or already cancelled');
    await run("UPDATE market_request_shops SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE request_id=?",[id]);
    await audit(null,'MARKET_QUOTE_CANCELLED','market_purchase_requests',id,{buyer_id:buyerId});return {ok:true};
  });
}
export async function sellerMember(userId) {
  const m=await get("SELECT * FROM members WHERE user_id=? AND status='ACTIVE'",[userId]);
  if(!m)throw new HttpError(403,'Active cooperative membership is required to sell');return m;
}
export async function setInventory(userId, listingId,body) {
  const member=await sellerMember(userId), id=integer(listingId,1,Number.MAX_SAFE_INTEGER,'product');
  const qty=integer(body?.quantity,0,1000000,'stock quantity'), version=integer(body?.version,0,2147483646,'stock version');
  await atomic(async()=>{
    // Lock the owning listing before initial stock creation or any update.
    const own=await run('UPDATE market_listings SET updated_at=updated_at WHERE id=? AND seller_member_id=?',[id,member.id]);
    if(own.changes!==1)throw new HttpError(404,'Listing not found');
    const old=await get('SELECT version FROM market_inventory WHERE listing_id=?',[id]);
    if(Number(old?.version||0)!==version)throw new HttpError(409,'Stock changed in another session. Refresh before editing.');
    if(old)await run('UPDATE market_inventory SET quantity=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE listing_id=?',[qty,id]);
    else await run('INSERT INTO market_inventory (listing_id,quantity) VALUES (?,?)',[id,qty]);
    await audit(userId,'MARKET_STOCK_UPDATED','market_listings',id,{quantity:qty});
  });return {id,quantity:qty,version:version+1};
}
export async function sellerRequests(userId) {
  const m=await sellerMember(userId);
  const shops=await all(`SELECT s.id,s.status,s.delivery_kobo,s.delivery_days,s.seller_note,s.request_id,r.reference,r.created_at,r.address_json
    FROM market_request_shops s JOIN market_purchase_requests r ON r.id=s.request_id
    WHERE s.seller_member_id=? ORDER BY s.id DESC LIMIT 50`,[m.id]);
  if(!shops.length)return [];
  const ids=shops.map(s=>Number(s.id));
  const rows=await all('SELECT * FROM market_request_items WHERE shop_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY id',ids);
  return shops.map(s=>{const a=JSON.parse(s.address_json);return {...s,id:Number(s.id),address_json:undefined,
    // Exact address/phone are not shared before a paid fulfillment workflow.
    destination:{city:a.city,state:a.state},delivery_kobo:s.delivery_kobo===null?null:Number(s.delivery_kobo),
    items:rows.filter(i=>Number(i.shop_id)===Number(s.id)).map(i=>({...i,unit_kobo:Number(i.unit_kobo)}))};});
}
export async function respondToRequest(userId,shopId,body) {
  const m=await sellerMember(userId),id=integer(shopId,1,Number.MAX_SAFE_INTEGER,'request');
  if(!['QUOTED','DECLINED'].includes(body?.decision))throw new HttpError(400,'Choose quote or decline');
  const note=typeof body.note==='string'?body.note.trim():'';
  if(note.length>500)throw new HttpError(400,'Note is too long');
  const delivery=body.decision==='QUOTED'?integer(body.delivery_kobo,0,100000000,'delivery fee'):null;
  const days=body.decision==='QUOTED'?integer(body.delivery_days,1,90,'delivery days'):null;
  return atomic(async()=>{
    const shop=await get('SELECT request_id FROM market_request_shops WHERE id=? AND seller_member_id=?',[id,m.id]);
    if(!shop)throw new HttpError(404,'Request not found');
    // Parent first in every transition: cancellation cannot race a quote.
    const parent=await run("UPDATE market_purchase_requests SET status=status WHERE id=? AND status='REQUESTED'",[shop.request_id]);
    if(parent.changes!==1)throw new HttpError(409,'This request was cancelled');
    const changed=await run("UPDATE market_request_shops SET status=?,delivery_kobo=?,delivery_days=?,seller_note=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND seller_member_id=? AND status='REQUESTED'",[body.decision,delivery,days,note,id,m.id]);
    if(changed.changes!==1)throw new HttpError(409,'This request has already been answered');
    await audit(userId,'MARKET_QUOTE_'+body.decision,'market_request_shops',id);return {ok:true};
  });
}

export async function operationsRequests() {
  const rows=await all(`SELECT r.id,r.reference,r.status,r.subtotal_kobo,r.created_at,r.address_json,
    COUNT(s.id) AS seller_count,SUM(CASE WHEN s.status='REQUESTED' THEN 1 ELSE 0 END) AS waiting_count
    FROM market_purchase_requests r LEFT JOIN market_request_shops s ON s.request_id=r.id
    GROUP BY r.id ORDER BY r.id DESC LIMIT 100`);
  return rows.map(r=>{const a=JSON.parse(r.address_json);return {id:Number(r.id),reference:r.reference,status:r.status,
    subtotal_kobo:Number(r.subtotal_kobo),created_at:r.created_at,destination:{city:a.city,state:a.state},
    seller_count:Number(r.seller_count),waiting_count:Number(r.waiting_count)};});
}
