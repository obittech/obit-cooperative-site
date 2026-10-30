import crypto from 'node:crypto';
import {all,get,run,atomic} from '../db.js';
import {HttpError} from '../router.js';
import {audit} from '../utils/audit.js';
import {STATES} from './market-regions.js';
function int(v,min=1,max=Number.MAX_SAFE_INTEGER){if(!/^\d+$/.test(String(v))||!Number.isSafeInteger(Number(v))||Number(v)<min||Number(v)>max)throw new HttpError(400,'Invalid delivery reference or version');return Number(v);}
function text(v,min,max,label){if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw new HttpError(400,'Check '+label);return v.trim();}
async function staff(id){const u=await get("SELECT id FROM users WHERE id=? AND status='ACTIVE' AND role IN ('staff','admin')",[id]);if(!u)throw new HttpError(403,'Staff access required');}
export function deliveryTestAvailable(){return ['test','development'].includes(process.env.NODE_ENV)&&process.env.MARKET_DELIVERY_MODE==='test';}
function publicPickup(r){return {id:Number(r.id),code:r.code,name:r.name,address:r.address,city:r.city,state:r.state,hours:r.hours,version:Number(r.version)};}
export async function pickupLocations(state=''){
 if(state&&!STATES.includes(state))throw new HttpError(400,'Choose a valid state');
 return (await all("SELECT * FROM market_pickup_locations WHERE status='ACTIVE' AND verified_ms IS NOT NULL"+(state?' AND state=?':'')+' ORDER BY name,id LIMIT 200',state?[state]:[])).map(publicPickup);
}
export async function pickupOperations(userId){await staff(userId);return all('SELECT * FROM market_pickup_locations ORDER BY id DESC LIMIT 200');}
export async function savePickup(userId,id,body){
 await staff(userId);const name=text(body?.name,3,100,'location name'),address=text(body?.address,8,300,'pickup address'),city=text(body?.city,2,80,'town or city'),hours=text(body?.hours,5,250,'opening hours'),state=text(body?.state,2,40,'state');
 if(!STATES.includes(state))throw new HttpError(400,'Choose a valid state');const version=int(body?.version,0,2147483646);if(id!==null)id=int(id);
 return atomic(async()=>{
  if(id===null){if(version!==0)throw new HttpError(409,'A new location must use version zero');const r=await run('INSERT INTO market_pickup_locations (code,name,address,city,state,hours,updated_ms) VALUES (?,?,?,?,?,?,?)',['OBP-'+crypto.randomBytes(6).toString('hex').toUpperCase(),name,address,city,state,hours,Date.now()]);id=Number(r.lastInsertRowid);}
  else{const r=await run("UPDATE market_pickup_locations SET name=?,address=?,city=?,state=?,hours=?,status='DRAFT',verification_note='',verified_by=NULL,verified_ms=NULL,version=version+1,updated_ms=? WHERE id=? AND version=?",[name,address,city,state,hours,Date.now(),id,version]);if(r.changes!==1)throw new HttpError(409,'Location changed. Refresh before editing.');}
  await audit(userId,'MARKET_PICKUP_SAVED','market_pickup_locations',id);return {id,status:'DRAFT'};
 });
}
export async function reviewPickup(userId,id,body){
 await staff(userId);id=int(id);const version=int(body?.version,1,2147483646),status=body?.status;
 if(!['ACTIVE','PAUSED'].includes(status))throw new HttpError(400,'Choose activate or pause');
 const note=text(body?.verification_note||'',status==='ACTIVE'?10:0,600,'operations verification note');
 if(status==='ACTIVE'&&body?.confirmed!==true)throw new HttpError(400,'Confirm that the address, opening hours and collection arrangements have been checked');
 return atomic(async()=>{
  const r=await run('UPDATE market_pickup_locations SET status=?,verification_note=?,verified_by=?,verified_ms=?,version=version+1,updated_ms=? WHERE id=? AND version=?',[status,note,status==='ACTIVE'?userId:null,status==='ACTIVE'?Date.now():null,Date.now(),id,version]);
  if(r.changes!==1)throw new HttpError(409,'Location changed. Refresh and review it again.');await audit(userId,'MARKET_PICKUP_'+status,'market_pickup_locations',id);return {ok:true};
 });
}
export function deliveryInput(body){
 if(body===undefined)return {method:'DOOR'};
 if(!body||typeof body!=='object'||Array.isArray(body)||!['DOOR','PICKUP'].includes(body.method))throw new HttpError(400,'Choose home delivery or pickup');
 if(body.method==='DOOR'){if(body.pickup_id!==undefined&&body.pickup_id!==null)throw new HttpError(400,'Home delivery cannot include a pickup location');return {method:'DOOR'};}
 return {method:'PICKUP',pickup_id:int(body.pickup_id)};
}
export async function prepareDelivery(input,address){
 if(input.method==='DOOR')return {address,preference:{method:'DOOR',pickup:null}};
 // Location locks serialize quote/order creation with staff pause or edits.
 await run('UPDATE market_pickup_locations SET updated_ms=updated_ms WHERE id=?',[input.pickup_id]);
 const p=await get("SELECT * FROM market_pickup_locations WHERE id=? AND status='ACTIVE' AND verified_ms IS NOT NULL",[input.pickup_id]);
 if(!p)throw new HttpError(409,'Pickup location is no longer available. Choose another option.');
 return {address:{...address,address:p.address,city:p.city,state:p.state},preference:{method:'PICKUP',pickup:publicPickup(p)}};
}
export async function saveRequestDelivery(requestId,preference){await run('INSERT INTO market_request_delivery (request_id,method,pickup_id,snapshot_json) VALUES (?,?,?,?)',[requestId,preference.method,preference.pickup?.id||null,preference.pickup?JSON.stringify(preference.pickup):null]);}
function preference(r){if(!r)return {method:'DOOR',pickup:null,available:true};const pickup=r.snapshot_json?JSON.parse(r.snapshot_json):null;return {method:r.method,pickup,available:r.method==='DOOR'||r.current_version===undefined||r.pickup_status==='ACTIVE'&&r.pickup_verified_ms!==null&&Number(r.current_version)===pickup?.version};}
export async function requestDeliveries(ids){if(!ids.length)return new Map();const rows=await all('SELECT d.*,p.status AS pickup_status,p.version AS current_version,p.verified_ms AS pickup_verified_ms FROM market_request_delivery d LEFT JOIN market_pickup_locations p ON p.id=d.pickup_id WHERE d.request_id IN ('+ids.map(()=>'?').join(',')+')',ids);return new Map(rows.map(r=>[Number(r.request_id),preference(r)]));}
export async function orderDeliveries(ids){if(!ids.length)return new Map();const rows=await all('SELECT o.id,d.method,d.pickup_id,d.snapshot_json,p.status AS pickup_status,p.version AS current_version,p.verified_ms AS pickup_verified_ms FROM market_purchase_orders o JOIN market_request_shops s ON s.id=o.shop_id LEFT JOIN market_request_delivery d ON d.request_id=s.request_id LEFT JOIN market_pickup_locations p ON p.id=d.pickup_id WHERE o.id IN ('+ids.map(()=>'?').join(',')+')',ids);return new Map(rows.map(r=>[Number(r.id),r.method?preference(r):preference(null)]));}
export async function validateRequestPickup(requestId){
 const row=await get('SELECT * FROM market_request_delivery WHERE request_id=?',[requestId]);const d=preference(row);if(d.method==='DOOR')return d;
 await run('UPDATE market_pickup_locations SET updated_ms=updated_ms WHERE id=?',[d.pickup.id]);
 const p=await get("SELECT version FROM market_pickup_locations WHERE id=? AND status='ACTIVE' AND verified_ms IS NOT NULL",[d.pickup.id]);
 if(!p||Number(p.version)!==d.pickup.version)throw new HttpError(409,'Pickup details changed. Choose a location and request a new quote.');return d;
}
async function actorOrder(actor,id){
 id=int(id);let clause,args;
 if(actor.kind==='BUYER'){clause='buyer_id=?';args=[actor.id];}
 else if(actor.kind==='SELLER'){const m=await get("SELECT id FROM members WHERE user_id=? AND status='ACTIVE'",[actor.id]);if(!m)throw new HttpError(403,'Active seller membership required');clause='seller_member_id=?';args=[m.id];}
 else if(actor.kind==='STAFF'){await staff(actor.id);clause='1=1';args=[];}else throw new HttpError(403,'Delivery access required');
 const row=await get('SELECT * FROM market_purchase_orders WHERE id=? AND '+clause,[id,...args]);if(!row)throw new HttpError(404,'Order not found');return row;
}
async function testPaid(order){
 if(!deliveryTestAvailable())throw new HttpError(503,'Live delivery booking and dispatch are unavailable');
 const p=await get("SELECT id FROM market_payment_attempts WHERE order_id=? AND mode='test' AND status='SUCCEEDED' AND stock_committed=1",[order.id]);
 if(!p)throw new HttpError(409,'A verified sandbox payment is required for test delivery');
}
export async function shipmentSummaries(ids){
 if(!ids.length)return new Map();const rows=await all('SELECT * FROM market_shipments WHERE order_id IN ('+ids.map(()=>'?').join(',')+')',ids);if(!rows.length)return new Map();
 const events=await all('SELECT e.* FROM market_shipment_events e JOIN market_shipments s ON s.id=e.shipment_id WHERE s.order_id IN ('+ids.map(()=>'?').join(',')+') ORDER BY e.id',ids);
 return new Map(rows.map(s=>[Number(s.order_id),{id:Number(s.id),reference:s.reference,mode:s.mode,method:s.method,status:s.status,version:Number(s.version),events:events.filter(e=>Number(e.shipment_id)===Number(s.id)).map(e=>({status:e.status,note:e.note,actor:e.actor,occurred_ms:Number(e.occurred_ms)}))}]));
}
export async function startShipment(actor,id){
 if(actor.kind==='BUYER')throw new HttpError(403,'Only the seller or operations team can prepare a test shipment');
 return atomic(async()=>{
  const order=await actorOrder(actor,id);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[order.id]);await testPaid(order);
  const d=(await orderDeliveries([order.id])).get(Number(order.id));await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[order.shop_id])).request_id);
  const old=await get('SELECT id FROM market_shipments WHERE order_id=?',[order.id]);if(old)return {ok:true,replayed:true};
  const now=Date.now(),r=await run("INSERT INTO market_shipments (order_id,reference,mode,method,status,created_ms,updated_ms) VALUES (?,?,'test',?,'PREPARING',?,?)",[order.id,'TEST-SHIP-'+crypto.randomBytes(7).toString('hex').toUpperCase(),d.method,now,now]);
  await run("INSERT INTO market_shipment_events (shipment_id,command_key,payload_hash,status,note,actor,occurred_ms) VALUES (?,'created','created','PREPARING','Simulation only. No courier booking or dispatch.',?,?)",[r.lastInsertRowid,actor.kind,now]);await audit(actor.id,'MARKET_TEST_SHIPMENT_CREATED','market_shipments',r.lastInsertRowid);return {ok:true,replayed:false};
 });
}
export async function updateShipment(actor,id,body){
 const version=int(body?.version,1,2147483646),status=body?.status,note=text(body?.note||'',3,300,'tracking note'),key=text(body?.command_key,16,100,'tracking request reference');
 const hash=crypto.createHash('sha256').update(JSON.stringify({actor,status,note,version})).digest('hex');
 return atomic(async()=>{
  const order=await actorOrder(actor,id);await run('UPDATE market_purchase_orders SET status=status WHERE id=?',[order.id]);await testPaid(order);
  const s=await get('SELECT * FROM market_shipments WHERE order_id=?',[order.id]);if(!s)throw new HttpError(404,'Test shipment not found');
  const replay=await get('SELECT payload_hash FROM market_shipment_events WHERE shipment_id=? AND command_key=?',[s.id,key]);if(replay){if(replay.payload_hash!==hash)throw new HttpError(409,'Tracking reference already used for different details');return {ok:true,replayed:true};}
  if(s.method==='PICKUP')await validateRequestPickup((await get('SELECT request_id FROM market_request_shops WHERE id=?',[order.shop_id])).request_id);
  if(Number(s.version)!==version)throw new HttpError(409,'Tracking changed. Refresh before updating.');
  if(actor.kind==='BUYER'){if(status!=='DELIVERED'||!['IN_TRANSIT','READY_FOR_PICKUP'].includes(s.status))throw new HttpError(409,'Receipt can only be confirmed when test delivery is in transit or ready for pickup');}
  else{
   const next=s.method==='PICKUP'?{PREPARING:['READY_FOR_PICKUP']}:{PREPARING:['IN_TRANSIT'],IN_TRANSIT:['DELIVERY_FAILED'],DELIVERY_FAILED:['IN_TRANSIT']};
   if(!next[s.status]?.includes(status))throw new HttpError(409,'This test delivery transition is unavailable. Only the buyer can confirm receipt.');
  }
  const count=await get('SELECT COUNT(*) AS n FROM market_shipment_events WHERE shipment_id=?',[s.id]);if(Number(count.n)>=50)throw new HttpError(429,'Tracking update limit reached');
  await run('UPDATE market_shipments SET status=?,version=version+1,updated_ms=? WHERE id=?',[status,Date.now(),s.id]);
  await run('INSERT INTO market_shipment_events (shipment_id,command_key,payload_hash,status,note,actor,occurred_ms) VALUES (?,?,?,?,?,?,?)',[s.id,key,hash,status,note,actor.kind,Date.now()]);await audit(actor.kind==='BUYER'?null:actor.id,'MARKET_TEST_SHIPMENT_'+status,'market_shipments',s.id);return {ok:true,replayed:false};
 });
}
export async function readDelivery(actor,id){const o=await actorOrder(actor,id);return {fulfilment:(await orderDeliveries([o.id])).get(Number(o.id)),shipment:(await shipmentSummaries([o.id])).get(Number(o.id))||null,booking_available:false,test_available:deliveryTestAvailable()};}
