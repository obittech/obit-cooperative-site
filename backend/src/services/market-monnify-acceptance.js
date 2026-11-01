// A controlled provider acceptance fixture, restricted to one disposable service.
import crypto from 'node:crypto';

export function acceptanceAllowed(env=process.env) {
 return env.MARKET_MONNIFY_ACCEPTANCE === 'true' && env.RENDER_SERVICE_ID === 'srv-dbjfm4vb9u1s73dt9qa0' &&
  env.NODE_ENV === 'test' && env.DB_ENGINE === 'sqlite' && env.DB_PATH === '/tmp/obit-monnify-sandbox.db' &&
  !env.DATABASE_URL && env.MARKET_CHECKOUT_MODE === 'test' &&
  String(env.MARKET_MONNIFY_API_KEY || '').startsWith('MK_TEST_') &&
  env.MARKET_TRANSFER_ENABLED === 'false' && env.MEMBERSHIP_TRANSFER_ENABLED === 'false';
}

export async function startMonnifyAcceptance() {
 if (process.env.MARKET_MONNIFY_ACCEPTANCE !== 'true') return;
 if (!acceptanceAllowed()) throw Error('Monnify acceptance fixture refused this environment');
 const db=await import('../db.js');
 const m=await import('./market-commerce.js');
 const orders=await import('./market-orders.js');
 const pay=await import('./market-payments.js');
 const marker='sandbox-acceptance-v1';
 let fixture=await db.get('SELECT l.id AS listing_id, o.id AS order_id, o.buyer_id FROM market_listings l JOIN market_purchase_order_items i ON i.listing_id=l.id JOIN market_purchase_orders o ON o.id=i.order_id WHERE l.title=?',[marker]);
 if (!fixture) {
  fixture=await db.atomic(async()=>{
   const u=await db.run("INSERT INTO users (email,role) VALUES (?,'member')",[marker+'-seller@example.test']);
   const a=await db.run("INSERT INTO member_applications (status,user_id) VALUES ('ACTIVE',?)",[u.lastInsertRowid]);
   const s=await db.run("INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,'ACTIVE')",[a.lastInsertRowid,u.lastInsertRowid,marker]);
   const c=await db.get("SELECT id FROM communities WHERE slug='obit-cooperative'");
   const l=await db.run("INSERT INTO market_listings (community_id,seller_member_id,title,category,price_kobo,status) VALUES (?,?,?,'Other',100000,'ACTIVE')",[c.id,s.lastInsertRowid,marker]);
   const b=await db.run('INSERT INTO market_buyers (email,display_name) VALUES (?,?)',[marker+'-buyer@example.test','Sandbox acceptance buyer']);
   return {listing_id:Number(l.lastInsertRowid),buyer_id:Number(b.lastInsertRowid),seller_user_id:Number(u.lastInsertRowid),seller_id:Number(s.lastInsertRowid)};
  });
  await m.setInventory(fixture.seller_user_id,fixture.listing_id,{quantity:2,version:0});
  await m.createRequest(fixture.buyer_id,{items:[{id:fixture.listing_id,qty:1}],expected_total_kobo:100000,request_key:crypto.randomUUID(),address:{recipient:'Sandbox test buyer',phone:'08000000000',address:'Sandbox test address only',city:'Abuja',state:'FCT',country:'NG'}});
  const shop=(await m.buyerRequests(fixture.buyer_id))[0].shops[0];
  await m.respondToRequest(fixture.seller_user_id,shop.id,{decision:'QUOTED',delivery_kobo:0,delivery_days:3,note:'Sandbox only. No goods or delivery.'});
  const order=await orders.acceptQuote(fixture.buyer_id,shop.id,{expected_total_kobo:100000});
  fixture.order_id=order.id;
 }
 let payment=await db.get('SELECT * FROM market_payment_attempts WHERE order_id=?',[fixture.order_id]);
 if (!payment) payment=await pay.initializeCheckout(fixture.buyer_id,fixture.order_id,{expected_total_kobo:100000});
 console.log('MONNIFY_ACCEPTANCE_CHECKOUT '+JSON.stringify({order_id:fixture.order_id,reference:payment.reference,checkout_url:payment.checkout_url,amount_ngn:1000,sandbox_only:true}));
 const report=async()=>{
  const p=await db.get('SELECT id,status,stock_committed,review_reason FROM market_payment_attempts WHERE order_id=?',[fixture.order_id]);
  const stock=await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[fixture.listing_id]);
  const count=p?await db.get("SELECT COUNT(*) AS n FROM market_payment_events WHERE attempt_id=? AND kind='PAYMENT_VERIFIED'",[p.id]):null;
  console.log('MONNIFY_ACCEPTANCE_STATUS '+JSON.stringify({order_id:fixture.order_id,status:p?.status,stock_committed:Number(p?.stock_committed)===1,stock_remaining:Number(stock?.quantity),verified_events:Number(count?.n||0),review_reason:p?.review_reason||'',sandbox_only:true}));
 };
 await report();
 setInterval(()=>report().catch(()=>console.error('MONNIFY_ACCEPTANCE_STATUS_UNAVAILABLE')),15000).unref();
}
