import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_ENGINE ||= 'sqlite';
process.env.DB_PATH=':memory:';
process.env.AUTH_TOKEN_SECRET='market-test-only-secret';
const db=await import('../src/db.js');
await db.migrate();
after(db.closeDatabase);
const auth=await import('../src/services/market-buyer-auth.js');
const m=await import('../src/services/market-commerce.js');
const {marketCommerceRouter}=await import('../src/routes/market-commerce.js');
const {requireAuth}=await import('../src/middleware/auth.js');
const {issueToken}=await import('../src/utils/auth.js');
const tag='commerce-'+crypto.randomUUID();
let seq=0;
async function buyer(){const r=await db.run('INSERT INTO market_buyers (email) VALUES (?)',[`${tag}-${++seq}@example.test`]);return db.get('SELECT * FROM market_buyers WHERE id=?',[r.lastInsertRowid]);}
async function seller(){const u=await db.run("INSERT INTO users (email,role) VALUES (?,'member')",[`${tag}-${++seq}@example.test`]);const a=await db.run("INSERT INTO member_applications (status,user_id) VALUES ('ACTIVE',?)",[u.lastInsertRowid]);const r=await db.run("INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,'ACTIVE')",[a.lastInsertRowid,u.lastInsertRowid,`${tag}-${++seq}`]);return {uid:Number(u.lastInsertRowid),id:Number(r.lastInsertRowid)};}
async function listing(s,price=2000000,qty=10){const c=await db.get("SELECT id FROM communities WHERE slug='obit-cooperative'");const r=await db.run("INSERT INTO market_listings (community_id,seller_member_id,title,category,price_kobo,status) VALUES (?,?,?,'Other',?,'ACTIVE')",[c.id,s.id,`${tag} Product ${++seq}`,price]);const id=Number(r.lastInsertRowid);if(qty!==null)await m.setInventory(s.uid,id,{quantity:qty,version:0});return id;}
const address={recipient:'Test Buyer',phone:'08012345678',address:'10 Test Street',city:'Abuja',state:'FCT',country:'NG'};
function request(items,total){return {items,address,expected_total_kobo:total,request_key:crypto.randomUUID()};}
async function endpoint(method,path,token,body={}){const match=marketCommerceRouter.match(method,path);const req={url:path,headers:{authorization:'Bearer '+token},body};const res={json(status,data){this.status=status;this.data=data;},setHeader(){}};try{for(const h of match.handlers)await h(req,res,match.params);}catch(e){res.status=e.status||500;res.data={error:e.message};}return res;}

test('buyer email codes are one-time, durable, and create no cooperative membership',async()=>{
 let code;const email=`${tag}-otp@example.test`;
 const issued=await auth.requestBuyerCode(email,async(_e,c)=>{code=c;});
 const first=await auth.verifyBuyerCode(issued.challenge,code);
 assert.equal(first.buyer.email,email);
 assert.equal(await db.get('SELECT id FROM users WHERE email=?',[email]),undefined);
 await assert.rejects(auth.verifyBuyerCode(issued.challenge,code),e=>e.status===401);
 await assert.rejects(auth.requestBuyerCode(email,async()=>{}),e=>e.status===429);
 const stored=await db.get('SELECT code_hash FROM market_login_challenges WHERE reference=?',[issued.challenge]);
 assert.notEqual(stored.code_hash,code);
 await db.migrate();assert.equal((await db.get('SELECT email FROM market_buyers WHERE id=?',[first.buyer.id])).email,email);
});
test('five wrong codes stay blocked and expired codes cannot authenticate',async()=>{
 let code;const c=await auth.requestBuyerCode(`${tag}-wrong@example.test`,async(_e,x)=>{code=x;});
 for(let i=0;i<5;i++)await assert.rejects(auth.verifyBuyerCode(c.challenge,'000000'),e=>e.status===401);
 await assert.rejects(auth.verifyBuyerCode(c.challenge,code),e=>e.status===401);
 assert.equal(Number((await db.get('SELECT attempts FROM market_login_challenges WHERE reference=?',[c.challenge])).attempts),5);
 const expired=await auth.requestBuyerCode(`${tag}-expired@example.test`,async(_e,x)=>{code=x;});
 await db.run('UPDATE market_login_challenges SET expires_ms=0 WHERE reference=?',[expired.challenge]);
 await assert.rejects(auth.verifyBuyerCode(expired.challenge,code),e=>e.status===401);
});
test('failed email delivery never leaves a usable sign-in challenge',async()=>{
 const email=`${tag}-mail-fail@example.test`;
 await assert.rejects(auth.requestBuyerCode(email,async()=>{throw Error('provider failure');}),e=>e.status===503);
 assert.equal(Number((await db.get('SELECT consumed FROM market_login_challenges WHERE email=?',[email])).consumed),1);
});
test('buyer tokens cannot become core member/admin tokens; logout revokes shopping sessions',async()=>{
 const b=await buyer();const token=auth.buyerToken(b);
 await assert.rejects(requireAuth()({headers:{authorization:'Bearer '+token}}),e=>e.status===401);
 const user=await db.run("INSERT INTO users (email,role) VALUES (?,'admin')",[`${tag}-admin@example.test`]);
 const core=await db.get('SELECT * FROM users WHERE id=?',[user.lastInsertRowid]);
 assert.equal(auth.readBuyerToken(issueToken(core)),null);
 assert.equal((await endpoint('GET','/api/market/buyer/me',token)).status,200);
 await endpoint('POST','/api/market/buyer/logout',token);
 assert.equal((await endpoint('GET','/api/market/buyer/me',token)).status,401);
 assert.equal(auth.readBuyerToken('invalid.token'),null);
});
test('cart updates survive separate sessions without losing other products and merges are idempotent',async()=>{
 const s=await seller(),a=await listing(s),b=await listing(s),customer=await buyer();
 await Promise.all([m.changeCart(customer.id,a,2),m.changeCart(customer.id,b,3)]);
 const saved=await m.buyerCart(customer.id);assert.equal(saved.items.length,2);assert.equal(saved.count,5);
 await m.mergeCart(customer.id,[{id:a,qty:2}]);await m.mergeCart(customer.id,[{id:a,qty:2}]);
 assert.equal((await m.buyerCart(customer.id)).count,5);
 await m.changeCart(customer.id,a,0);assert.equal((await m.buyerCart(customer.id)).count,3);
 await assert.rejects(m.changeCart(customer.id,b,99),e=>e.status===409);
});
test('cart totals use current prices; unavailable products are retained but excluded',async()=>{
 const s=await seller(),id=await listing(s),b=await buyer();await m.changeCart(b.id,id,2);
 await db.run('UPDATE market_listings SET price_kobo=2000025 WHERE id=?',[id]);
 assert.equal((await m.buyerCart(b.id)).total_kobo,4000050);
 await m.setInventory(s.uid,id,{quantity:1,version:1});
 const cart=await m.buyerCart(b.id);assert.equal(cart.lines[0].available,false);assert.equal(cart.total_kobo,0);assert.equal(cart.items.length,1);
});
test('buyer addresses and carts are isolated and wrong roles cannot access seller controls',async()=>{
 const a=await buyer(),b=await buyer();await m.saveAddress(a.id,address);
 const profile=await endpoint('GET','/api/market/buyer/me',auth.buyerToken(b));assert.equal(profile.data.address,null);
 assert.equal((await endpoint('GET','/api/market/seller/requests',auth.buyerToken(a))).status,401);
 await assert.rejects(m.saveAddress(a.id,{...address,state:'Invalid'}),e=>e.status===400);
});
test('catalogue paginates beyond 100 and enforces filters without SQL interpolation',async()=>{
 const s=await seller();for(let n=0;n<105;n++)await listing(s,2000000+n,null);
 const first=await m.catalogue(new URLSearchParams({seller:String(s.id),page_size:'48',sort:'price-low'}));
 const third=await m.catalogue(new URLSearchParams({seller:String(s.id),page_size:'48',page:'3',sort:'price-low'}));
 assert.equal(first.total,105);assert.equal(first.items.length,48);assert.equal(third.items.length,9);
 assert.ok(third.items[0].price>first.items[0].price);
 assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id),q:"' OR 1=1 --"}))).total,0);
 assert.equal((await m.catalogue(new URLSearchParams({ids:''}))).total,0);
 for(const q of ['%','_','!'])assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id),q}))).total,0);
 await assert.rejects(m.catalogue(new URLSearchParams({sort:'DROP TABLE users'})),e=>e.status===400);
});
test('quote requests split sellers, snapshot prices and deduplicate concurrent submissions',async()=>{
 const a=await seller(),b=await seller(),p=await listing(a),q=await listing(b,3000000),customer=await buyer();
 const body=request([{id:p,qty:2},{id:q,qty:1}],7000000);
 const results=await Promise.all([m.createRequest(customer.id,body),m.createRequest(customer.id,body)]);
 assert.equal(results[0].id,results[1].id);
 const rows=await m.buyerRequests(customer.id);assert.equal(rows.length,1);assert.equal(rows[0].shops.length,2);
 assert.equal(rows[0].subtotal_kobo,7000000);assert.equal(rows[0].status,'REQUESTED');
 await db.run('UPDATE market_listings SET price_kobo=9999999 WHERE id=?',[p]);
 assert.equal((await m.buyerRequests(customer.id))[0].shops[0].items[0].unit_kobo,2000000);
 await assert.rejects(m.createRequest(customer.id,{...body,address:{...address,city:'Lagos'}}),e=>e.status===409);
 assert.equal((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[p])).quantity,10);
});
test('stale price, inactive seller, unknown product, duplicate lines and stock errors reject requests',async()=>{
 const s=await seller(),p=await listing(s,2000000,1),b=await buyer();
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:1}],1)),e=>e.status===409);
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:2}],4000000)),e=>e.status===409);
 await assert.rejects(m.createRequest(b.id,request([{id:99999999,qty:1}],2000000)),e=>e.status===409);
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:1},{id:p,qty:1}],4000000)),e=>e.status===400);
 await db.run("UPDATE members SET status='SUSPENDED' WHERE id=?",[s.id]);
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:1}],2000000)),e=>e.status===409);
 assert.equal((await m.buyerRequests(b.id)).length,0);
});
test('stock ownership and optimistic versions prevent unauthorised or lost changes',async()=>{
 const s=await seller(),other=await seller(),p=await listing(s);
 await assert.rejects(m.setInventory(other.uid,p,{quantity:1,version:1}),e=>e.status===404);
 const results=await Promise.allSettled([m.setInventory(s.uid,p,{quantity:2,version:1}),m.setInventory(s.uid,p,{quantity:3,version:1})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
});
test('seller quotes reveal only their items and town, and cannot quote cancelled requests',async()=>{
 const a=await seller(),b=await seller(),p=await listing(a),q=await listing(b),customer=await buyer(),other=await buyer();
 const created=await m.createRequest(customer.id,request([{id:p,qty:1},{id:q,qty:1}],4000000));
 const inbox=await m.sellerRequests(a.uid);assert.equal(inbox.length,1);assert.equal(inbox[0].items.length,1);
 assert.equal(inbox[0].address_json,undefined);assert.deepEqual(inbox[0].destination,{city:'Abuja',state:'FCT'});
 await assert.rejects(m.respondToRequest(b.uid,inbox[0].id,{decision:'QUOTED',delivery_kobo:100000,delivery_days:3}),e=>e.status===404);
 await m.respondToRequest(a.uid,inbox[0].id,{decision:'QUOTED',delivery_kobo:100000,delivery_days:3,note:'Delivery estimate'});
 assert.equal((await m.buyerRequests(customer.id))[0].shops[0].status,'QUOTED');
 await assert.rejects(m.cancelRequest(other.id,created.id),e=>e.status===409);
 await m.cancelRequest(customer.id,created.id);
 const bInbox=await m.sellerRequests(b.uid);
 await assert.rejects(m.respondToRequest(b.uid,bInbox[0].id,{decision:'DECLINED'}),e=>e.status===409);
 assert.ok((await m.buyerRequests(customer.id))[0].shops.every(s=>s.status==='CANCELLED'));
});

test('oversized requests and malformed addresses do not create partial records',async()=>{
 const s=await seller(),p=await listing(s,300000000,2),b=await buyer();
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:2}],600000000)),e=>e.status===400);
 await assert.rejects(m.saveAddress(b.id,{...address,phone:'----------'}),e=>e.status===400);
 assert.equal((await m.buyerRequests(b.id)).length,0);
 assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM market_request_shops s JOIN market_purchase_requests r ON r.id=s.request_id WHERE r.buyer_id=?',[b.id])).n),0);
});

test('operations overview requires staff privileges and excludes full delivery details',async()=>{
 const b=await buyer(), token=auth.buyerToken(b);
 assert.equal((await endpoint('GET','/api/admin/market/requests',token)).status,401);
 const s=await seller();const user=await db.get('SELECT * FROM users WHERE id=?',[s.uid]);
 assert.equal((await endpoint('GET','/api/admin/market/requests',issueToken(user))).status,403);
 const admin=await db.run("INSERT INTO users (email,role) VALUES (?,'admin')",[`${tag}-ops@example.test`]);
 const u=await db.get('SELECT * FROM users WHERE id=?',[admin.lastInsertRowid]);
 const result=await endpoint('GET','/api/admin/market/requests',issueToken(u));
 assert.equal(result.status,200);assert.ok(result.data.length>0);
 assert.ok(result.data.every(r=>!r.address_json&&!r.address&&!r.phone&&!r.email));
});

const stores=await import('../src/services/market-stores.js');
async function staff(){const r=await db.run("INSERT INTO users (email,role) VALUES (?,'admin')",[`${tag}-${++seq}@example.test`]);return db.get('SELECT * FROM users WHERE id=?',[r.lastInsertRowid]);}
test('store identities need review, private evidence never reaches buyers, edits revoke the badge',async()=>{
 const s=await seller(),p=await listing(s),admin=await staff();
 await stores.submitStore(s.uid,{name:'Test Shop',description:'Real description',version:0,official:true});
 let cat=await m.catalogue(new URLSearchParams({seller:String(s.id)}));assert.equal(cat.items[0].seller_name,'Member shop '+s.id);assert.equal(cat.items[0].official_store,false);
 const row=await db.get('SELECT * FROM market_stores WHERE seller_member_id=?',[s.id]);
 await assert.rejects(stores.reviewStore(admin.id,row.id,{version:1,status:'APPROVED',official:true}),e=>e.status===400);
 await stores.reviewStore(admin.id,row.id,{version:1,status:'APPROVED',official:true,verification_note:'PRIVATE-authorisation-test-reference'});
 cat=await m.catalogue(new URLSearchParams({seller:String(s.id),official:'1'}));assert.equal(cat.total,1);assert.equal(cat.items[0].seller_name,'Test Shop');assert.equal(cat.shops.find(x=>x.id===s.id).official,true);assert.ok(!JSON.stringify(cat).includes('PRIVATE-authorisation'));
 await assert.rejects(stores.submitStore(s.uid,{name:'Stale shop',description:'',version:1}),e=>e.status===409);
 await stores.submitStore(s.uid,{name:'Different brand',description:'',version:2});
 assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id),official:'1'}))).total,0);
 await assert.rejects(stores.reviewStore(admin.id,row.id,{version:2,status:'APPROVED',official:false}),e=>e.status===409);
 assert.equal((await m.preview([{id:p,qty:1}])).lines[0].product.seller_name,'Member shop '+s.id);
});
test('promotion prices agree across search, sort, bag and quote snapshots, then expire safely',async()=>{
 const s=await seller(),p=await listing(s,4000000),other=await listing(s,3500000),admin=await staff(),b=await buyer();
 const input={version:0,enabled:true,label:'Test offer',price_kobo:3000000,starts_ms:Date.now()-1000,ends_ms:Date.now()+3600000};
 await stores.promotion(admin.id,p,input);
 const cat=await m.catalogue(new URLSearchParams({seller:String(s.id),promotions:'1',max_kobo:'3100000',sort:'price-low'}));assert.equal(cat.total,1);assert.equal(cat.items[0].id,p);assert.equal(cat.items[0].price,30000);assert.equal(cat.items[0].promotion.label,'Test offer');
 const sorted=await m.catalogue(new URLSearchParams({seller:String(s.id),sort:'price-low'}));assert.deepEqual(sorted.items.map(x=>x.id),[p,other]);
 assert.equal((await m.preview([{id:p,qty:2}])).total_kobo,6000000);
 await m.createRequest(b.id,request([{id:p,qty:1}],3000000));assert.equal((await m.buyerRequests(b.id))[0].shops[0].items[0].unit_kobo,3000000);
 await assert.rejects(stores.promotion(admin.id,p,input),e=>e.status===409);
 await db.run('UPDATE market_promotions SET ends_ms=0 WHERE listing_id=?',[p]);
 assert.equal((await m.preview([{id:p,qty:1}])).total_kobo,4000000);
 await assert.rejects(m.createRequest(b.id,request([{id:p,qty:1}],3000000)),e=>e.status===409);
 assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id),promotions:'1'}))).total,0);
 await stores.promotion(admin.id,p,{...input,version:1});await db.run('UPDATE market_listings SET price_kobo=4500000 WHERE id=?',[p]);
 assert.equal((await m.preview([{id:p,qty:1}])).total_kobo,4500000);
 await stores.promotion(admin.id,p,{enabled:false,version:2});assert.equal(Number((await db.get('SELECT enabled FROM market_promotions WHERE listing_id=?',[p])).enabled),0);
});
test('promotion boundaries, scheduled starts, role guards and inactive sellers are enforced',async()=>{
 const s=await seller(),p=await listing(s,4000000),admin=await staff(),b=await buyer(),memberToken=issueToken(await db.get('SELECT * FROM users WHERE id=?',[s.uid]));
 const body={version:0,enabled:true,label:'Valid offer',price_kobo:3000000,starts_ms:Date.now()+3600000,ends_ms:Date.now()+7200000};
 for(const change of [{price_kobo:4000000},{price_kobo:1999999},{ends_ms:0},{ends_ms:Date.now()+100*86400000}])await assert.rejects(stores.promotion(admin.id,p,{...body,...change}),e=>e.status===400);
 assert.equal((await endpoint('POST',`/api/admin/market/listings/${p}/promotion`,memberToken,body)).status,403);
 assert.equal((await endpoint('GET','/api/admin/market/stores',auth.buyerToken(b))).status,401);
 assert.equal((await endpoint('POST',`/api/admin/market/listings/${p}/promotion`,issueToken(admin),body)).status,200);
 assert.equal((await m.preview([{id:p,qty:1}])).total_kobo,4000000);
 await db.run("UPDATE members SET status='SUSPENDED' WHERE id=?",[s.id]);
 assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id)}))).total,0);
 await assert.rejects(stores.submitStore(s.uid,{name:'Suspended Shop',description:'',version:0}),e=>e.status===403);
 await assert.rejects(stores.promotion(admin.id,p,{...body,version:1}),e=>e.status===409);
 await db.migrate();
});

const orders=await import('../src/services/market-orders.js');
async function quoted(s,customer,items,total,delivery=100000){
 await m.createRequest(customer.id,request(items,total));
 const latest=(await m.buyerRequests(customer.id))[0],shop=latest.shops.find(r=>r.seller_member_id===s.id);
 await m.respondToRequest(s.uid,shop.id,{decision:'QUOTED',delivery_kobo:delivery,delivery_days:3,note:'Test confirmed stock'});
 return {id:shop.id,total:shop.items.reduce((n,r)=>n+Number(r.unit_kobo)*Number(r.quantity),0)+delivery,request:latest.id};
}
test('acceptance snapshots a quote once, reserves stock and keeps payment and dispatch closed',async()=>{
 const s=await seller(),b=await buyer(),id=await listing(s,2000000,3),quote=await quoted(s,b,[{id,qty:2}],4000000);
 const result=await Promise.all([orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total,status:'PAID'}),orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total})]);
 assert.equal(result[0].id,result[1].id);assert.equal(result.filter(x=>x.replayed).length,1);
 const rows=await orders.buyerOrders(b.id);assert.equal(rows.length,1);assert.equal(rows[0].status,'AWAITING_PAYMENT');assert.equal(rows[0].total_kobo,4100000);assert.equal(rows[0].items[0].unit_kobo,2000000);assert.equal(rows[0].payment_available,false);assert.equal(rows[0].dispatch_allowed,false);assert.equal(rows[0].expires_ms-rows[0].created_ms,900000);assert.equal(rows[0].events.length,1);
 assert.equal((await m.preview([{id,qty:2}])).lines[0].available,false);assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id)}))).items[0].stock_quantity,1);
 await assert.rejects(m.setInventory(s.uid,id,{quantity:1,version:1}),e=>e.status===409);
 await assert.rejects(m.cancelRequest(b.id,quote.request),e=>e.status===409);
 assert.equal((await m.buyerRequests(b.id))[0].status,'REQUESTED');assert.equal((await m.buyerRequests(b.id))[0].shops[0].order.id,rows[0].id);
 await db.run('UPDATE market_listings SET price_kobo=2200000 WHERE id=?',[id]);assert.equal((await orders.buyerOrders(b.id))[0].total_kobo,4100000);
});
test('competing buyers cannot reserve the same last unit across concurrent acceptance',async()=>{
 const s=await seller(),p=await listing(s,2000000,1),a=await buyer(),b=await buyer();
 const qa=await quoted(s,a,[{id:p,qty:1}],2000000),qb=await quoted(s,b,[{id:p,qty:1}],2000000);
 const results=await Promise.allSettled([orders.acceptQuote(a.id,qa.id,{expected_total_kobo:qa.total}),orders.acceptQuote(b.id,qb.id,{expected_total_kobo:qb.total})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 assert.equal((await m.preview([{id:p,qty:1}])).lines[0].available,false);
 const winner=results[0].status==='fulfilled'?a:b,won=results.find(r=>r.status==='fulfilled').value;
 await orders.cancelOrder({buyerId:winner.id},won.id,{reason:'Changed my mind'});
 const loser=winner===a?b:a,q=loser===a?qa:qb;assert.equal((await orders.acceptQuote(loser.id,q.id,{expected_total_kobo:q.total})).status,'AWAITING_PAYMENT');
});
test('cancellation is owned, idempotent, audited once and releases all reserved products',async()=>{
 const s=await seller(),otherSeller=await seller(),p=await listing(s),q=await listing(s),b=await buyer(),other=await buyer(),quote=await quoted(s,b,[{id:p,qty:2},{id:q,qty:3}],10000000);
 const created=await orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total});
 await assert.rejects(orders.cancelOrder({buyerId:other.id},created.id,{reason:'Not my order'}),e=>e.status===404);
 await assert.rejects(orders.cancelOrder({userId:otherSeller.uid},created.id,{reason:'Not my order'}),e=>e.status===404);
 await assert.rejects(orders.cancelOrder({buyerId:b.id},created.id,{reason:''}),e=>e.status===400);
 const cancelled=await orders.cancelOrder({userId:s.uid},created.id,{reason:'Unable to supply'});assert.equal(cancelled.status,'CANCELLED');
 const repeat=await orders.cancelOrder({buyerId:b.id},created.id,{reason:'Retry cancel'});assert.equal(repeat.replayed,true);
 const row=(await orders.buyerOrders(b.id))[0];assert.equal(row.cancel_actor,'SELLER');assert.equal(row.cancel_reason,'Unable to supply');assert.equal(row.events.filter(e=>e.kind==='CANCELLED').length,1);
 assert.equal((await m.catalogue(new URLSearchParams({seller:String(s.id)}))).items.find(i=>i.id===p).stock_quantity,10);
 assert.equal((await orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total})).status,'CANCELLED');
});
test('expiry releases stock without a worker and records one terminal event on refresh',async()=>{
 const s=await seller(),b=await buyer(),p=await listing(s,2000000,1),quote=await quoted(s,b,[{id:p,qty:1}],2000000),created=await orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total});
 await db.run('UPDATE market_purchase_orders SET expires_ms=? WHERE id=?',[Date.now()-1000,created.id]);
 assert.equal((await m.preview([{id:p,qty:1}])).lines[0].available,true);
 const row=(await orders.buyerOrders(b.id))[0];assert.equal(row.status,'EXPIRED');assert.equal(row.events.filter(e=>e.kind==='EXPIRED').length,1);
 await orders.buyerOrders(b.id);await orders.cancelOrder({buyerId:b.id},created.id,{reason:'Too late now'});
 assert.equal((await orders.buyerOrders(b.id))[0].events.length,2);assert.equal((await orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total})).status,'EXPIRED');
});
test('unconfirmed stock, stale prices, stale quotes and wrong totals cannot reserve any stock',async()=>{
 const s=await seller(),b=await buyer(),p=await listing(s,2000000,null),q=await listing(s),quote=await quoted(s,b,[{id:p,qty:1},{id:q,qty:1}],4000000);
 await assert.rejects(orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total}),e=>e.status===409);
 await m.setInventory(s.uid,p,{quantity:3,version:0});
 await assert.rejects(orders.acceptQuote(b.id,quote.id,{expected_total_kobo:1}),e=>e.status===409);
 await db.run('UPDATE market_listings SET price_kobo=2100000 WHERE id=?',[q]);await assert.rejects(orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total}),e=>e.status===409);
 await db.run('UPDATE market_listings SET price_kobo=2000000 WHERE id=?',[q]);await db.run("UPDATE market_request_shops SET updated_at=datetime('now','-8 days') WHERE id=?",[quote.id]);
 await assert.rejects(orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total}),e=>e.status===409);
 assert.equal((await orders.buyerOrders(b.id)).length,0);assert.equal((await m.preview([{id:p,qty:3},{id:q,qty:10}])).count,13);
});
test('order access separates buyers, sellers and staff without exposing delivery contact details',async()=>{
 const s=await seller(),otherSeller=await seller(),b=await buyer(),other=await buyer(),p=await listing(s),quote=await quoted(s,b,[{id:p,qty:1}],2000000);
 const token=auth.buyerToken(b),wrong=auth.buyerToken(other);
 assert.equal((await endpoint('POST',`/api/market/quotes/${quote.id}/accept`,wrong,{expected_total_kobo:quote.total})).status,404);
 const accepted=await endpoint('POST',`/api/market/quotes/${quote.id}/accept`,token,{expected_total_kobo:quote.total});assert.equal(accepted.status,201);
 assert.equal((await endpoint('GET','/api/market/orders',wrong)).data.length,0);
 const sellerToken=issueToken(await db.get('SELECT * FROM users WHERE id=?',[s.uid]));
 const own=(await endpoint('GET','/api/market/seller/orders',sellerToken)).data;assert.equal(own.length,1);assert.equal(own[0].address,undefined);assert.ok(!JSON.stringify(own).includes(address.phone));assert.ok(!JSON.stringify(own).includes(address.address));
 assert.equal((await orders.sellerOrders(otherSeller.uid)).length,0);
 assert.equal((await endpoint('GET','/api/admin/market/orders',sellerToken)).status,403);
 const admin=await staff(),overview=(await endpoint('GET','/api/admin/market/orders',issueToken(admin))).data;assert.ok(!JSON.stringify(overview).includes(address.phone));
 assert.equal((await endpoint('GET','/api/market/seller/orders',token)).status,401);
});
test('active order caps limit stock holds and expired orders do not consume the active allowance',async()=>{
 const s=await seller(),b=await buyer(),p=await listing(s),quotes=[];
 for(let n=0;n<3;n++)quotes.push(await quoted(s,b,[{id:p,qty:1}],2000000));
 for(const q of quotes.slice(0,2))await orders.acceptQuote(b.id,q.id,{expected_total_kobo:q.total});
 await assert.rejects(orders.acceptQuote(b.id,quotes[2].id,{expected_total_kobo:quotes[2].total}),e=>e.status===429);
 await db.run('UPDATE market_purchase_orders SET expires_ms=? WHERE buyer_id=?',[Date.now()-1000,b.id]);
 assert.equal((await orders.acceptQuote(b.id,quotes[2].id,{expected_total_kobo:quotes[2].total})).status,'AWAITING_PAYMENT');
 await db.migrate();
});
test('quote cancellation racing acceptance cannot leave a cancelled request with a new order',async()=>{
 const s=await seller(),b=await buyer(),p=await listing(s),quote=await quoted(s,b,[{id:p,qty:1}],2000000);
 const results=await Promise.allSettled([orders.acceptQuote(b.id,quote.id,{expected_total_kobo:quote.total}),m.cancelRequest(b.id,quote.request)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const parent=await db.get('SELECT status FROM market_purchase_requests WHERE id=?',[quote.request]),created=await orders.buyerOrders(b.id);
 if(parent.status==='CANCELLED')assert.equal(created.length,0);else{assert.equal(parent.status,'REQUESTED');assert.equal(created.length,1);}
});

const pay=await import('../src/services/market-payments.js');
const {checkoutConfig}=await import('../src/services/market-payment-state.js');
const {Readable}=await import('node:stream');
const originalFetch=globalThis.fetch;
async function paymentFixture(){const s=await seller(),b=await buyer(),p=await listing(s,2000000,3),q=await quoted(s,b,[{id:p,qty:1}],2000000);const o=await orders.acceptQuote(b.id,q.id,{expected_total_kobo:q.total});return {s,b,p,q,o};}
function testCheckout(){process.env.NODE_ENV='test';process.env.MARKET_CHECKOUT_MODE='test';process.env.MARKET_MONNIFY_API_KEY='MK_TEST_'+crypto.randomUUID();process.env.MARKET_MONNIFY_SECRET_KEY='unit-only-secret-key';process.env.MARKET_MONNIFY_CONTRACT_CODE='1234567890';process.env.MARKET_MONNIFY_CALLBACK_URL='https://staging.example.test/market-account.html#orders';}
function resetCheckout(){for(const key of ['MARKET_CHECKOUT_MODE','MARKET_MONNIFY_API_KEY','MARKET_MONNIFY_SECRET_KEY','MARKET_MONNIFY_CONTRACT_CODE','MARKET_MONNIFY_CALLBACK_URL','MARKET_MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOK','NODE_ENV'])delete process.env[key];globalThis.fetch=originalFetch;}
function mockMonnify(handler){globalThis.fetch=async(url,options)=>{
 assert.ok(url.startsWith('https://sandbox.monnify.com/'));let data;
 if(url.endsWith('/auth/login')){assert.ok(options.headers.Authorization.startsWith('Basic '));data={accessToken:'isolated-unit-test-token',expiresIn:3600};}
 else{assert.equal(options.headers.Authorization,'Bearer isolated-unit-test-token');data=await handler(url,options);}
 return new Response(JSON.stringify({requestSuccessful:true,responseCode:'0',responseBody:data}),{status:200,headers:{'Content-Type':'application/json'}});
};}
async function resetVerify(id){await db.run('UPDATE market_payment_attempts SET last_verify_ms=0 WHERE order_id=?',[id]);}
async function paymentRow(id){return db.get('SELECT * FROM market_payment_attempts WHERE order_id=?',[id]);}
function receiptFor(row,extra={}){return {transactionReference:row.provider_transaction_id||'MNFY|UNIT|'+row.id,paymentReference:row.reference,amountPaid:Number(row.amount_kobo)/100,totalPayable:Number(row.amount_kobo)/100,currencyCode:'NGN',paymentStatus:'PAID',...extra};}
async function initialiseFixture(f){mockMonnify((_u,o)=>{const b=JSON.parse(o.body),reference='MNFY|UNIT|'+f.o.id;return {paymentReference:b.paymentReference,transactionReference:reference,checkoutUrl:'https://sandbox.sdk.monnify.com/checkout/'+reference};});return pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total});}
async function webhook(data,signature='signed'){
 const raw=JSON.stringify({eventType:'SUCCESSFUL_TRANSACTION',eventData:{...data,currency:data.currencyCode}}),req=Readable.from([Buffer.from(raw)]);req.headers={};
 if(signature==='signed')req.headers['monnify-signature']=crypto.createHmac('sha512',process.env.MARKET_MONNIFY_SECRET_KEY).update(raw).digest('hex');else if(signature!==null)req.headers['monnify-signature']=signature;
 const res={json(status,result){this.status=status;this.data=result;}};await pay.handleMarketPaymentWebhook(req,res);return res;
}
test('Monnify checkout requires explicit sandbox settings and is unavailable in production',async()=>{
 const f=await paymentFixture();let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Must not dispatch');};
 try{
  assert.equal(checkoutConfig().available,false);await assert.rejects(pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===503);
  testCheckout();process.env.NODE_ENV='production';assert.equal(checkoutConfig().available,false);await assert.rejects(pay.verifyCheckout(f.b.id,f.o.id),e=>e.status===503);
  process.env.NODE_ENV='test';process.env.MARKET_MONNIFY_API_KEY='MK_LIVE_do-not-use';assert.equal(checkoutConfig().available,false);
  process.env.MARKET_MONNIFY_API_KEY='MK_TEST_unit';process.env.MARKET_MONNIFY_CALLBACK_URL='javascript:alert(1)';assert.equal(checkoutConfig().available,false);assert.equal(calls,0);
 }finally{resetCheckout();}
});
test('Monnify initialization is owned, server-priced and dispatched once with a 45-minute checkout hold',async()=>{
 const f=await paymentFixture(),other=await buyer();testCheckout();let calls=0;
 try{
  mockMonnify((_u,o)=>{calls++;const b=JSON.parse(o.body);assert.equal(b.amount,f.q.total/100);assert.equal(b.customerEmail,f.b.email);assert.equal(b.contractCode,'1234567890');assert.deepEqual(b.paymentMethods,['CARD','ACCOUNT_TRANSFER']);assert.ok(!JSON.stringify(b).includes(address.phone));return {paymentReference:b.paymentReference,transactionReference:'MNFY|UNIT|'+f.o.id,checkoutUrl:'https://sandbox.sdk.monnify.com/checkout/MNFY|UNIT|'+f.o.id};});
  await assert.rejects(pay.initializeCheckout(other.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===404);await assert.rejects(pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:1}),e=>e.status===409);
  const both=await Promise.all([pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total}),pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total})]);assert.equal(calls,1);assert.equal(both[0].reference,both[1].reference);
  assert.ok((await pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total})).checkout_url.startsWith('https://sandbox.sdk.monnify.com/checkout/'));assert.equal(calls,1);
  const o=(await orders.buyerOrders(f.b.id))[0];assert.ok(o.expires_ms>=o.created_ms+45*60000);await assert.rejects(orders.cancelOrder({buyerId:f.b.id},f.o.id,{reason:'Uncertain checkout'}),e=>e.status===409);
  await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);await assert.rejects(pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===409);
 }finally{resetCheckout();}
});
test('uncertain or unsafe Monnify checkout never dispatches a second initialization',async()=>{
 const f=await paymentFixture();testCheckout();let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;throw Error('timeout');};await assert.rejects(pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===502);
  const retry=await pay.initializeCheckout(f.b.id,f.o.id,{expected_total_kobo:f.q.total});assert.equal(retry.status,'UNKNOWN');assert.equal(retry.checkout_url,null);assert.equal(calls,1);
  const g=await paymentFixture();mockMonnify((_u,o)=>({paymentReference:JSON.parse(o.body).paymentReference,transactionReference:'MNFY|UNIT|'+g.o.id,checkoutUrl:'https://sandbox.sdk.monnify.com.attacker.test/steal'}));await assert.rejects(pay.initializeCheckout(g.b.id,g.o.id,{expected_total_kobo:g.q.total}),e=>e.status===502);assert.equal((await paymentRow(g.o.id)).status,'UNKNOWN');
 }finally{resetCheckout();}
});
test('Monnify server verification commits isolated inventory once and paid test orders cannot expire',async()=>{
 const f=await paymentFixture();testCheckout();
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id);mockMonnify((url)=>{assert.ok(url.includes('/api/v2/merchant/transactions/query?paymentReference='+row.reference));return receiptFor(row);});
  const result=await pay.verifyCheckout(f.b.id,f.o.id);assert.equal(result.status,'SUCCEEDED');assert.equal(result.stock_committed,true);
  assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);assert.equal((await m.preview([{id:f.p,qty:2}])).lines[0].available,true);
  await resetVerify(f.o.id);await pay.verifyCheckout(f.b.id,f.o.id);assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);
  await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);const history=(await orders.buyerOrders(f.b.id))[0];assert.equal(history.status,'TEST_PAID');assert.equal(history.events.filter(e=>e.kind==='PAYMENT_VERIFIED').length,1);assert.equal(history.events.filter(e=>e.kind==='EXPIRED').length,0);assert.equal(history.dispatch_allowed,false);
  await assert.rejects(orders.cancelOrder({userId:f.s.uid},f.o.id,{reason:'Cannot cancel paid order'}),e=>e.status===409);
 }finally{resetCheckout();}
});
test('late, cancelled, partial and overpaid Monnify receipts require review without consuming stock',async()=>{
 testCheckout();
 try{
  for(const condition of ['expired','cancelled','partial','overpaid']){
   const f=await paymentFixture();await initialiseFixture(f);const row=await paymentRow(f.o.id);
   if(condition==='expired')await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);
   if(condition==='cancelled'){await db.run("UPDATE market_payment_attempts SET status='FAILED' WHERE id=?",[row.id]);await orders.cancelOrder({buyerId:f.b.id},f.o.id,{reason:'Confirmed failed sandbox payment'});}
   const extra=condition==='partial'?{paymentStatus:'PARTIALLY_PAID',amountPaid:1}:condition==='overpaid'?{paymentStatus:'OVERPAID',amountPaid:99999}:{};
   mockMonnify(()=>receiptFor(row,extra));const result=await pay.verifyCheckout(f.b.id,f.o.id);assert.equal(result.status,'REVIEW');assert.equal(result.stock_committed,false);
   assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),3);assert.equal((await orders.buyerOrders(f.b.id))[0].status,'PAYMENT_REVIEW');
  }
 }finally{resetCheckout();}
});
test('Monnify amounts, currency, both references and ownership are verified before confirming',async()=>{
 const f=await paymentFixture(),other=await buyer();testCheckout();
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id);await assert.rejects(pay.verifyCheckout(other.id,f.o.id),e=>e.status===404);
  for(const extra of [{amountPaid:null},{amountPaid:'1e5'},{amountPaid:'21,000.00'},{currencyCode:'USD'},{paymentReference:'OBIT-membership'},{transactionReference:'MNFY|OTHER|different'}]){
   await resetVerify(f.o.id);mockMonnify(()=>receiptFor(row,extra));await assert.rejects(pay.verifyCheckout(f.b.id,f.o.id),e=>e.status===422);
  }
  assert.equal(Number((await paymentRow(f.o.id)).stock_committed),0);
  mockMonnify(()=>receiptFor(row,{paymentStatus:'PENDING',amountPaid:0}));await resetVerify(f.o.id);assert.equal((await pay.verifyCheckout(f.b.id,f.o.id)).status,'READY');await assert.rejects(pay.verifyCheckout(f.b.id,f.o.id),e=>e.status===429);
 }finally{resetCheckout();}
});
test('Monnify webhook notifications cannot fulfil orders without server verification and deduplicate safely',async()=>{
 const f=await paymentFixture();testCheckout();let calls=0;
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id),data=receiptFor(row);mockMonnify(()=>{calls++;return data;});
  await assert.rejects(webhook(data,'bad'),e=>e.status===401);await assert.rejects(webhook(data,null),e=>e.status===401);assert.equal(calls,0);
  const first=await webhook(data);assert.equal(first.status,200);const repeat=await webhook(data);assert.equal(repeat.data.replayed,true);assert.equal(calls,1);
  assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);await assert.rejects(webhook({...data,paymentReference:'OBIT-membership'}),e=>e.status===422);
  assert.equal((await endpoint('GET','/api/admin/market/payments',auth.buyerToken(f.b))).status,401);
 }finally{resetCheckout();}
});
test('unsigned sandbox notifications require an explicit test switch and still use Monnify verification',async()=>{
 const f=await paymentFixture();testCheckout();
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id);process.env.MARKET_MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOK='true';
  mockMonnify(()=>receiptFor(row,{paymentStatus:'PENDING',amountPaid:0}));await assert.rejects(webhook(receiptFor(row),null),e=>e.status===503);assert.equal(Number((await paymentRow(f.o.id)).stock_committed),0);
  process.env.NODE_ENV='production';await assert.rejects(webhook(receiptFor(row),null),e=>e.status===503);
 }finally{resetCheckout();}
});
test('Monnify reconciliation racing cancellation or expiry cannot commit stock twice',async()=>{
 const f=await paymentFixture();testCheckout();
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id);mockMonnify(()=>receiptFor(row));
  const results=await Promise.allSettled([pay.verifyCheckout(f.b.id,f.o.id),orders.cancelOrder({userId:f.s.uid},f.o.id,{reason:'Concurrent seller cancellation'}),orders.buyerOrders(f.b.id)]);
  assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal((await orders.buyerOrders(f.b.id))[0].status,'TEST_PAID');assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);
  await db.migrate();
 }finally{resetCheckout();}
});
test('an expiry refresh racing a late Monnify receipt leaves stock available and payment in review',async()=>{
 const f=await paymentFixture();testCheckout();
 try{
  await initialiseFixture(f);const row=await paymentRow(f.o.id);await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);mockMonnify(()=>receiptFor(row));
  await Promise.all([pay.verifyCheckout(f.b.id,f.o.id),orders.buyerOrders(f.b.id)]);
  const current=(await orders.buyerOrders(f.b.id))[0];assert.equal(current.status,'PAYMENT_REVIEW');assert.equal(current.events.filter(e=>e.kind==='EXPIRED').length,1);assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),3);
 }finally{resetCheckout();}
});

const delivery=await import('../src/services/market-delivery.js');
const pickupData={name:'Test collection point',address:'25 Fictional Pickup Road',city:'Ikeja',state:'Lagos',hours:'Monday to Friday, 9am to 5pm',version:0};
async function activePickup(){const admin=await staff(),p=await delivery.savePickup(admin.id,null,pickupData);await delivery.reviewPickup(admin.id,p.id,{version:1,status:'ACTIVE',confirmed:true,verification_note:'Fictional operations verification reference'});return {admin,id:p.id};}
async function pickupOrder(pickup){const s=await seller(),b=await buyer(),id=await listing(s,2000000,3),body={...request([{id,qty:1}],2000000),fulfilment:{method:'PICKUP',pickup_id:pickup.id}};const r=await m.createRequest(b.id,body),shop=(await m.buyerRequests(b.id))[0].shops[0];await m.respondToRequest(s.uid,shop.id,{decision:'QUOTED',delivery_kobo:50000,delivery_days:3,note:'Test pickup quote'});const o=await orders.acceptQuote(b.id,shop.id,{expected_total_kobo:2050000});return {s,b,p:id,q:{total:2050000},o,body,r,shop};}
async function paidDeliveryFixture(){const f=await paymentFixture();testCheckout();process.env.MARKET_DELIVERY_MODE='test';await initialiseFixture(f);const row=await paymentRow(f.o.id);mockMonnify(()=>receiptFor(row));await pay.verifyCheckout(f.b.id,f.o.id);return f;}
function tracking(version,status,note='Fictional tracking update'){return {version,status,note,command_key:crypto.randomUUID()};}
test('pickup locations are private drafts until reviewed and edits revoke public availability',async()=>{
 const admin=await staff(),s=await seller(),p=await delivery.savePickup(admin.id,null,pickupData);
 assert.ok(!(await delivery.pickupLocations()).some(x=>x.id===p.id));
 await assert.rejects(delivery.reviewPickup(admin.id,p.id,{version:1,status:'ACTIVE',confirmed:false,verification_note:'Checked address'}),e=>e.status===400);
 await assert.rejects(delivery.reviewPickup(s.uid,p.id,{version:1,status:'ACTIVE',confirmed:true,verification_note:'Checked address'}),e=>e.status===403);
 await delivery.reviewPickup(admin.id,p.id,{version:1,status:'ACTIVE',confirmed:true,verification_note:'PRIVATE-verified-operations-note'});
 const active=(await delivery.pickupLocations('Lagos')).find(x=>x.id===p.id);assert.equal(active.name,pickupData.name);assert.ok(!JSON.stringify(active).includes('PRIVATE'));assert.equal(active.verified_by,undefined);
 await delivery.savePickup(admin.id,p.id,{...pickupData,name:'Changed collection point',version:2});assert.ok(!(await delivery.pickupLocations()).some(x=>x.id===p.id));
 await assert.rejects(delivery.reviewPickup(admin.id,p.id,{version:2,status:'ACTIVE',confirmed:true,verification_note:'Stale review'}),e=>e.status===409);
 await assert.rejects(delivery.pickupLocations('Invalid State'),e=>e.status===400);
});
test('pickup quotes snapshot the destination, preserve contact privacy and replay after a location pause',async()=>{
 const point=await activePickup(),f=await pickupOrder(point),buyer=(await m.buyerRequests(f.b.id))[0],seller=(await m.sellerRequests(f.s.uid))[0];
 assert.equal(buyer.fulfilment.method,'PICKUP');assert.equal(buyer.address.city,'Ikeja');assert.equal(buyer.address.address,pickupData.address);assert.equal(buyer.address.recipient,address.recipient);
 assert.deepEqual(seller.destination,{city:'Ikeja',state:'Lagos'});assert.equal(seller.fulfilment.pickup.name,pickupData.name);assert.ok(!JSON.stringify(seller).includes(address.phone));
 assert.equal((await orders.buyerOrders(f.b.id))[0].fulfilment.pickup.address,pickupData.address);
 await delivery.reviewPickup(point.admin.id,point.id,{version:2,status:'PAUSED',verification_note:'Temporarily unavailable'});
 assert.equal((await m.createRequest(f.b.id,f.body)).replayed,true);
 await assert.rejects(m.createRequest(f.b.id,{...f.body,request_key:crypto.randomUUID()}),e=>e.status===409);
});
test('changed pickup details reject stale quote acceptance and checkout',async()=>{
 const point=await activePickup(),s=await seller(),b=await buyer(),p=await listing(s);
 await m.createRequest(b.id,{...request([{id:p,qty:1}],2000000),fulfilment:{method:'PICKUP',pickup_id:point.id}});const q=(await m.buyerRequests(b.id))[0].shops[0];await m.respondToRequest(s.uid,q.id,{decision:'QUOTED',delivery_kobo:0,delivery_days:2});
 await delivery.savePickup(point.admin.id,point.id,{...pickupData,address:'99 Changed Test Avenue',version:2});await assert.rejects(orders.acceptQuote(b.id,q.id,{expected_total_kobo:2000000}),e=>e.status===409);
 const other=await activePickup(),f=await pickupOrder(other);testCheckout();
 try{await delivery.reviewPickup(other.admin.id,other.id,{version:2,status:'PAUSED',verification_note:'Location no longer available'});await assert.rejects(initialiseFixture(f),e=>e.status===409);}finally{resetCheckout();}
});
test('delivery simulation is blocked in production, for unpaid orders and for unrelated sellers',async()=>{
 const f=await paymentFixture(),other=await seller();process.env.NODE_ENV='production';process.env.MARKET_DELIVERY_MODE='test';
 try{await assert.rejects(delivery.startShipment({kind:'SELLER',id:f.s.uid},f.o.id),e=>e.status===503);process.env.NODE_ENV='test';await assert.rejects(delivery.startShipment({kind:'SELLER',id:f.s.uid},f.o.id),e=>e.status===409);await assert.rejects(delivery.startShipment({kind:'SELLER',id:other.uid},f.o.id),e=>e.status===404);await assert.rejects(delivery.startShipment({kind:'BUYER',id:f.b.id},f.o.id),e=>e.status===403);}finally{delete process.env.NODE_ENV;delete process.env.MARKET_DELIVERY_MODE;}
});
test('test tracking is versioned, idempotent and receipt belongs to the buyer',async()=>{
 let f;try{
  f=await paidDeliveryFixture();const actor={kind:'SELLER',id:f.s.uid};await delivery.startShipment(actor,f.o.id);assert.equal((await delivery.startShipment(actor,f.o.id)).replayed,true);
  const step=tracking(1,'IN_TRANSIT');await delivery.updateShipment(actor,f.o.id,step);assert.equal((await delivery.updateShipment(actor,f.o.id,step)).replayed,true);
  await assert.rejects(delivery.updateShipment(actor,f.o.id,{...step,note:'Changed payload'}),e=>e.status===409);
  await assert.rejects(delivery.updateShipment(actor,f.o.id,tracking(1,'DELIVERY_FAILED')),e=>e.status===409);
  await assert.rejects(delivery.updateShipment(actor,f.o.id,tracking(2,'DELIVERED')),e=>e.status===409);
  const other=await buyer();await assert.rejects(delivery.readDelivery({kind:'BUYER',id:other.id},f.o.id),e=>e.status===404);
  const receipt=tracking(2,'DELIVERED','Test buyer confirms receipt');await delivery.updateShipment({kind:'BUYER',id:f.b.id},f.o.id,receipt);assert.equal((await delivery.updateShipment({kind:'BUYER',id:f.b.id},f.o.id,receipt)).replayed,true);
  const read=await delivery.readDelivery({kind:'BUYER',id:f.b.id},f.o.id);assert.equal(read.shipment.status,'DELIVERED');assert.equal(read.shipment.events.length,3);assert.equal(read.booking_available,false);assert.equal((await orders.buyerOrders(f.b.id))[0].status,'TEST_PAID');
 }finally{resetCheckout();delete process.env.MARKET_DELIVERY_MODE;}
});
test('pickup tracking cannot use home-delivery transitions or skip pickup readiness',async()=>{
 const point=await activePickup();testCheckout();process.env.MARKET_DELIVERY_MODE='test';
 try{
  const f=await pickupOrder(point);await initialiseFixture(f);const row=await paymentRow(f.o.id);mockMonnify(()=>receiptFor(row));await pay.verifyCheckout(f.b.id,f.o.id);const actor={kind:'SELLER',id:f.s.uid};await delivery.startShipment(actor,f.o.id);
  await assert.rejects(delivery.updateShipment(actor,f.o.id,tracking(1,'IN_TRANSIT')),e=>e.status===409);await assert.rejects(delivery.updateShipment({kind:'BUYER',id:f.b.id},f.o.id,tracking(1,'DELIVERED')),e=>e.status===409);
  await delivery.updateShipment(actor,f.o.id,tracking(1,'READY_FOR_PICKUP'));await delivery.updateShipment({kind:'BUYER',id:f.b.id},f.o.id,tracking(2,'DELIVERED','Test pickup received'));
  assert.equal((await delivery.readDelivery(actor,f.o.id)).shipment.status,'DELIVERED');
 }finally{resetCheckout();delete process.env.MARKET_DELIVERY_MODE;}
});
test('delivery failure can retry but concurrent updates and payment review block unsafe progress',async()=>{
 try{
  const f=await paidDeliveryFixture(),actor={kind:'SELLER',id:f.s.uid};await delivery.startShipment(actor,f.o.id);await delivery.updateShipment(actor,f.o.id,tracking(1,'IN_TRANSIT'));
  const result=await Promise.allSettled([delivery.updateShipment(actor,f.o.id,tracking(2,'DELIVERY_FAILED')),delivery.updateShipment(actor,f.o.id,tracking(2,'DELIVERY_FAILED'))]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  await delivery.updateShipment(actor,f.o.id,tracking(3,'IN_TRANSIT'));await db.run("UPDATE market_payment_attempts SET status='REVIEW' WHERE order_id=?",[f.o.id]);await assert.rejects(delivery.updateShipment({kind:'BUYER',id:f.b.id},f.o.id,tracking(4,'DELIVERED')),e=>e.status===409);
 }finally{resetCheckout();delete process.env.MARKET_DELIVERY_MODE;}
});
test('delivery endpoints protect roles and public options expose no test shipment or customer data',async()=>{
 const b=await buyer(),s=await seller(),token=issueToken(await db.get('SELECT * FROM users WHERE id=?',[s.uid]));
 assert.equal((await endpoint('GET','/api/admin/market/pickup-locations',auth.buyerToken(b))).status,401);assert.equal((await endpoint('GET','/api/admin/market/pickup-locations',token)).status,403);
 const response=await endpoint('GET','/api/market/delivery/options','');assert.equal(response.status,200);assert.equal(response.data.booking_available,false);assert.ok(!JSON.stringify(response.data).includes('verification_note'));await db.migrate();
});
test('a pickup closure after checkout puts a received test payment into review without consuming stock',async()=>{
 const point=await activePickup(),f=await pickupOrder(point);testCheckout();
 try{await initialiseFixture(f);const row=await paymentRow(f.o.id);await delivery.reviewPickup(point.admin.id,point.id,{version:2,status:'PAUSED',verification_note:'Collection operation temporarily closed'});assert.equal((await orders.buyerOrders(f.b.id))[0].fulfilment.available,false);await assert.rejects(initialiseFixture(f),e=>e.status===409);mockMonnify(()=>receiptFor(row));const result=await pay.verifyCheckout(f.b.id,f.o.id);assert.equal(result.status,'REVIEW');assert.equal(result.review_reason,'PICKUP_UNAVAILABLE');assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),3);}finally{resetCheckout();}
});

const media=await import('../src/services/market-media.js');
test('product video links accept single YouTube videos and public HTTPS MP4 only',()=>{
 for(const link of ['https://youtu.be/abcdefghijk','https://www.youtube.com/watch?v=abcdefghijk&t=10','https://www.youtube.com/shorts/abcdefghijk'])assert.equal(media.videoInput(link).url,'https://www.youtube.com/watch?v=abcdefghijk');
 assert.equal(media.videoInput('https://cdn.obitcooperative.com/item.mp4').kind,'mp4');
 for(const link of ['javascript:alert(1)','http://cdn.example.com/x.mp4','https://user:pass@cdn.example.com/x.mp4','https://127.0.0.1/x.mp4','https://localhost/x.mp4','https://host.internal/x.mp4','https://youtube.com/playlist?list=abc','https://youtube.com/watch?v=bad','https://cdn.example.com/x.html','https://cdn.example.com:443/x.mp4#bad'])assert.throws(()=>media.videoInput(link),e=>e.status===400);
});
test('videos stay private pending review, edits withdraw approval and stale staff review fails',async()=>{
 const s=await seller(),other=await seller(),id=await listing(s),staff=await db.run("INSERT INTO users (email,role) VALUES (?,'staff')",[`${tag}-${++seq}@example.test`]);
 const body={version:0,video_url:'https://youtu.be/abcdefghijk',description:'Seller demonstrates the actual item and its controls.'};
 await assert.rejects(media.submitVideo(other.uid,id,body),e=>e.status===404);
 const created=await media.submitVideo(s.uid,id,body);assert.equal(created.status,'PENDING');
 const state=()=>m.preview([{id,qty:1}]);assert.equal((await state()).lines[0].product.video,null);
 await assert.rejects(media.reviewVideo(s.uid,id,{version:1,decision:'APPROVE',confirmed:true,note:'Checked the actual product video.'}),e=>e.status===403);
 await assert.rejects(media.reviewVideo(staff.lastInsertRowid,id,{version:1,decision:'APPROVE',note:'Checked the actual product video.'}),e=>e.status===400);
 await media.reviewVideo(staff.lastInsertRowid,id,{version:1,decision:'APPROVE',confirmed:true,note:'Checked product match and publication permission.'});
 assert.equal((await m.catalogue(new URLSearchParams({videos:'1',q:tag}))).items.some(x=>x.id===id),true);
 assert.equal((await state()).lines[0].product.video.kind,'youtube');assert.equal((await state()).lines[0].product.video.review_note,undefined);
 await media.submitVideo(s.uid,id,{...body,version:2,video_url:'https://cdn.obitcooperative.com/new.mp4'});assert.equal((await state()).lines[0].product.video,null);
 await assert.rejects(media.reviewVideo(staff.lastInsertRowid,id,{version:2,decision:'APPROVE',confirmed:true,note:'Outdated product video review.'}),e=>e.status===409);
 await media.reviewVideo(staff.lastInsertRowid,id,{version:3,decision:'REJECT',note:'The item shown does not match the listing.'});assert.equal((await state()).lines[0].product.video,null);
 await db.migrate();assert.equal(Number((await db.get('SELECT version FROM market_listing_videos WHERE listing_id=?',[id])).version),4);
});
test('video routes require authentication and seller ownership',async()=>{
 assert.equal((await endpoint('GET','/api/admin/market/videos','')).status,401);
 const s=await seller(),id=await listing(s),token=issueToken({id:s.uid,role:'member',session_version:0});
 assert.equal((await endpoint('GET','/api/admin/market/videos',token)).status,403);
 assert.equal((await endpoint('POST',`/api/market/seller/listings/${id}/video`,token,{version:0,video_url:'https://youtu.be/abcdefghijk',description:'A close look at this product and its controls.'})).status,200);
});
test('listing and initial video commit together and invalid video rolls back the listing',async()=>{
 const {safePayRouter}=await import('../src/routes/safepay.js');const s=await seller(),token=issueToken({id:s.uid,role:'member',session_version:0});
 const match=safePayRouter.match('POST','/api/market/listings');
 async function submit(body){const req={headers:{authorization:'Bearer '+token},body};const res={json(status,data){this.status=status;this.data=data;},setHeader(){}};for(const h of match.handlers)await h(req,res,match.params);return res;}
 const body={title:tag+' video listing',price:'25000',category:'Other',video_url:'https://youtu.be/abcdefghijk',video_description:'A demonstration of this actual item and its controls.'};
 const result=await submit(body);assert.equal(result.status,201);
 assert.equal((await db.get('SELECT status FROM market_listing_videos WHERE listing_id=?',[result.data.id])).status,'PENDING');
 await assert.rejects(submit({...body,title:tag+' rejected initial video',video_url:'https://localhost/x.mp4'}),e=>e.status===400);
 assert.equal(await db.get('SELECT id FROM market_listings WHERE title=?',[tag+' rejected initial video']),undefined);
 const hidden=await m.catalogue(new URLSearchParams({videos:'1',q:tag+' video listing'}));assert.equal(hidden.total,0);
});

const bank=await import('../src/services/market-bank-transfer.js');
function enableBank(){Object.assign(process.env,{MARKET_TRANSFER_ENABLED:'true',MARKET_TRANSFER_BANK_NAME:'Test Bank',MARKET_TRANSFER_ACCOUNT_NAME:'Test Company',MARKET_TRANSFER_ACCOUNT_NUMBER:'0123456789'});}
test('internal checkout requires account configuration and order ownership',async()=>{
 const f=await paymentFixture(),b=await buyer();process.env.MARKET_TRANSFER_ENABLED='false';
 await assert.rejects(bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===503);
 enableBank();await assert.rejects(bank.startBankTransfer(b.id,f.o.id,{expected_total_kobo:f.q.total}),e=>e.status===404);
 await assert.rejects(bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:1}),e=>e.status===409);
 assert.equal((await bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total})).status,'READY');
 assert.equal((await endpoint('POST',`/api/admin/market/orders/${f.o.id}/bank-transfer/confirm`,auth.buyerToken(f.b))).status,401);
});
test('payment notification remains pending until bank credit is confirmed, with stock and credit deduplication',async()=>{
 enableBank();const f=await paymentFixture();await bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total});
 const [a,b]=await Promise.all([bank.claimBankTransfer(f.b.id,f.o.id),bank.claimBankTransfer(f.b.id,f.o.id)]);assert.equal(a.status,'CLAIMED');assert.equal(b.status,'CLAIMED');
 const u=new URL(a.whatsapp_url);assert.equal(u.pathname,'/2348030567787');assert.ok(u.searchParams.get('text').includes(f.o.reference));
 assert.equal((await orders.buyerOrders(f.b.id))[0].status,'PAYMENT_PENDING');assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),3);
 await assert.rejects(orders.cancelOrder({buyerId:f.b.id},f.o.id,{reason:'Cancel now'}),e=>e.status===409);
 const staff=await db.run("INSERT INTO users (email,role) VALUES (?,'staff')",[`${tag}-bank-staff@example.test`]);const body={bank_credit_checked:true,bank_reference:'BANK-TEST-UNIQUE-0001',amount_kobo:f.q.total};
 await assert.rejects(bank.confirmBankTransfer(staff.lastInsertRowid,f.o.id,{...body,bank_credit_checked:false}),e=>e.status===400);
 await assert.rejects(bank.confirmBankTransfer(staff.lastInsertRowid,f.o.id,{...body,amount_kobo:1}),e=>e.status===409);
 await bank.confirmBankTransfer(staff.lastInsertRowid,f.o.id,body);await bank.confirmBankTransfer(staff.lastInsertRowid,f.o.id,body);
 assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);
 await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);const o=(await orders.buyerOrders(f.b.id))[0];assert.equal(o.status,'PAID');assert.equal(o.bank_payment.receipt_reference,'OBMR-'+o.reference);
 const g=await paymentFixture();await bank.startBankTransfer(g.b.id,g.o.id,{expected_total_kobo:g.q.total});await bank.claimBankTransfer(g.b.id,g.o.id);
 await assert.rejects(bank.confirmBankTransfer(staff.lastInsertRowid,g.o.id,{...body,amount_kobo:g.q.total}),e=>e.status===409);
});
test('late transfer notification goes to review and does not revive the reservation',async()=>{
 enableBank();const f=await paymentFixture();await bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total});await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);assert.equal((await bank.claimBankTransfer(f.b.id,f.o.id)).status,'REVIEW');assert.equal(Number((await db.get('SELECT expires_ms FROM market_purchase_orders WHERE id=?',[f.o.id])).expires_ms),0);
});

const care=await import('../src/services/market-aftercare.js');
test('late verified bank credits can be refunded without allocating stock or authorising dispatch',async()=>{
 enableBank();const f=await paymentFixture(),admin=await staff(),actor={kind:'STAFF',id:admin.id};
 await bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total});await db.run('UPDATE market_purchase_orders SET expires_ms=0 WHERE id=?',[f.o.id]);await bank.claimBankTransfer(f.b.id,f.o.id);
 const body={bank_credit_checked:true,bank_reference:'LATE-CREDIT-'+crypto.randomUUID(),amount_kobo:f.q.total};
 await assert.rejects(bank.verifyCreditForRefund(f.s.uid,f.o.id,body),e=>e.status===403);
 await bank.verifyCreditForRefund(admin.id,f.o.id,body);await bank.verifyCreditForRefund(admin.id,f.o.id,body);
 const a=await care.readAftercare(actor,f.o.id);assert.equal(a.payment_confirmed,true);assert.equal(a.fulfilment_allowed,false);assert.equal(a.return_case.status,'OPEN');
 await assert.rejects(care.updateManualDelivery(actor,f.o.id,{status:'PREPARING',version:0,note:'Cannot dispatch a refund-only order'}),e=>e.status===409);
 await care.decideReturn(admin.id,f.o.id,{status:'APPROVED',version:1,amount_kobo:f.q.total,note:'Late credit verified and full refund agreed'});
 await care.recordRefund(admin.id,f.o.id,{version:2,amount_kobo:f.q.total,bank_reference:'LATE-REFUND-'+crypto.randomUUID(),bank_debit_checked:true,recipient_checked:true});
 assert.equal((await care.readAftercare(actor,f.o.id)).return_case.status,'REFUNDED');assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),3);
 assert.equal((await db.get('SELECT status FROM market_bank_payments WHERE order_id=?',[f.o.id])).status,'REVIEW');
});
async function livePaidFixture(){
 enableBank();const f=await paymentFixture(),admin=await staff();
 await bank.startBankTransfer(f.b.id,f.o.id,{expected_total_kobo:f.q.total});await bank.claimBankTransfer(f.b.id,f.o.id);
 await bank.confirmBankTransfer(admin.id,f.o.id,{bank_credit_checked:true,bank_reference:'INBOUND-'+crypto.randomUUID(),amount_kobo:f.q.total});
 return {...f,admin,actor:{kind:'STAFF',id:admin.id},customer:{kind:'BUYER',id:f.b.id}};
}
test('manual fulfilment requires bank confirmation, staff access and buyer ownership',async()=>{
 const f=await paymentFixture(),admin=await staff(),b=await buyer(),actor={kind:'STAFF',id:admin.id};
 await assert.rejects(care.updateManualDelivery(actor,f.o.id,{status:'PREPARING',version:0,note:'Order preparation started'}),e=>e.status===409);
 await assert.rejects(care.readAftercare({kind:'BUYER',id:b.id},f.o.id),e=>e.status===404);
 await assert.rejects(care.readAftercare({kind:'STAFF',id:f.s.uid},f.o.id),e=>e.status===403);
 const token=auth.buyerToken(f.b);
 assert.equal((await endpoint('POST',`/api/admin/market/orders/${f.o.id}/fulfilment`,token,{status:'PREPARING',version:0,note:'Should be refused'})).status,401);
 assert.equal((await endpoint('GET',`/api/market/orders/${f.o.id}/aftercare`,auth.buyerToken(b))).status,404);
});
test('manual delivery progresses after payment and only its buyer can confirm receipt',async()=>{
 const f=await livePaidFixture();
 await care.updateManualDelivery(f.actor,f.o.id,{status:'PREPARING',version:0,note:'Paid goods are being prepared'});
 await assert.rejects(care.updateManualDelivery(f.actor,f.o.id,{status:'IN_TRANSIT',version:1,note:'Ready for dispatch'}),e=>e.status===400);
 const dispatch={status:'IN_TRANSIT',version:1,carrier:'Test operations team',tracking_reference:'TEST-HANDOVER-'+f.o.id,note:'Actual handover recorded for this isolated test'};
 const concurrent=await Promise.allSettled([care.updateManualDelivery(f.actor,f.o.id,dispatch),care.updateManualDelivery(f.actor,f.o.id,dispatch)]);
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(care.updateManualDelivery(f.actor,f.o.id,{status:'RECEIVED',version:2,note:'Staff cannot confirm buyer receipt'}),e=>e.status===409);
 await assert.rejects(care.updateManualDelivery(f.customer,f.o.id,{status:'RECEIVED',version:2,note:'Receipt must be acknowledged'}),e=>e.status===409);
 await care.updateManualDelivery(f.customer,f.o.id,{status:'RECEIVED',version:2,note:'Buyer received the goods',receipt_confirmed:true});
 assert.equal((await care.readAftercare(f.customer,f.o.id)).delivery.status,'RECEIVED');
 const history=(await orders.buyerOrders(f.b.id))[0];assert.equal(history.aftercare.delivery.status,'RECEIVED');assert.equal(history.aftercare.events.length,3);
 assert.equal(Number((await db.get('SELECT quantity FROM market_inventory WHERE listing_id=?',[f.p])).quantity),2);
});
test('return requests deduplicate, block dispatch, allow inspection and cap refund approvals',async()=>{
 const f=await livePaidFixture(),reason='The item is damaged and needs review';
 const r=await Promise.all([care.requestReturn(f.b.id,f.o.id,{reason}),care.requestReturn(f.b.id,f.o.id,{reason})]);assert.equal(r[0].id,r[1].id);
 await assert.rejects(care.updateManualDelivery(f.actor,f.o.id,{status:'PREPARING',version:0,note:'Must resolve the problem first'}),e=>e.status===409);
 await care.decideReturn(f.admin.id,f.o.id,{status:'RETURN_AUTHORISED',version:1,note:'Return arrangements agreed with the customer'});
 await assert.rejects(care.decideReturn(f.admin.id,f.o.id,{status:'APPROVED',version:2,amount_kobo:f.q.total,note:'Inspection still required'}),e=>e.status===409);
 await care.decideReturn(f.admin.id,f.o.id,{status:'RECEIVED',version:2,note:'Returned item received and inspected'});
 await assert.rejects(care.decideReturn(f.admin.id,f.o.id,{status:'APPROVED',version:3,amount_kobo:f.q.total+1,note:'Amount above payment must fail'}),e=>e.status===409);
 await care.decideReturn(f.admin.id,f.o.id,{status:'APPROVED',version:3,amount_kobo:f.q.total,note:'Full refund approved after inspection'});
 assert.equal((await care.readAftercare(f.customer,f.o.id)).return_case.refunded_kobo,0);
});
test('refund recording requires bank checks, caps cumulative payments, deduplicates references and protects privacy',async()=>{
 const f=await livePaidFixture();await care.requestReturn(f.b.id,f.o.id,{reason:'Goods not delivered, requesting a full refund'});
 await care.decideReturn(f.admin.id,f.o.id,{status:'APPROVED',version:1,amount_kobo:f.q.total,note:'Non-delivery checked and refund approved'});
 const body={amount_kobo:Math.floor(f.q.total/2),version:2,bank_reference:'DEBIT-'+crypto.randomUUID(),bank_debit_checked:true,recipient_checked:true};
 await assert.rejects(care.recordRefund(f.admin.id,f.o.id,{...body,bank_debit_checked:false}),e=>e.status===400);
 await assert.rejects(care.recordRefund(f.admin.id,f.o.id,{...body,recipient_checked:false}),e=>e.status===400);
 const result=await Promise.all([care.recordRefund(f.admin.id,f.o.id,body),care.recordRefund(f.admin.id,f.o.id,body)]);assert.equal(result[0].receipt_reference,result[1].receipt_reference);
 let publicView=await care.readAftercare(f.customer,f.o.id);assert.equal(publicView.return_case.status,'PARTIALLY_REFUNDED');assert.equal(publicView.return_case.refunded_kobo,body.amount_kobo);assert.ok(!JSON.stringify(publicView).includes(body.bank_reference));
 assert.ok(JSON.stringify(await care.readAftercare(f.actor,f.o.id)).includes(body.bank_reference));
 await assert.rejects(care.recordRefund(f.admin.id,f.o.id,{...body,version:3,bank_reference:'DEBIT-'+crypto.randomUUID(),amount_kobo:f.q.total}),e=>e.status===409);
 await care.recordRefund(f.admin.id,f.o.id,{...body,version:3,bank_reference:'DEBIT-'+crypto.randomUUID(),amount_kobo:f.q.total-body.amount_kobo});
 assert.equal((await care.readAftercare(f.customer,f.o.id)).return_case.status,'REFUNDED');
 await assert.rejects(care.recordRefund(f.admin.id,f.o.id,{...body,version:4,bank_reference:'DEBIT-'+crypto.randomUUID(),amount_kobo:1}),e=>e.status===409);
 const g=await livePaidFixture();await care.requestReturn(g.b.id,g.o.id,{reason:'Another non-delivery case for this order'});await care.decideReturn(g.admin.id,g.o.id,{status:'APPROVED',version:1,amount_kobo:g.q.total,note:'Separate order refund approved for testing'});
 await assert.rejects(care.recordRefund(g.admin.id,g.o.id,{...body}),e=>e.status===409);
 await db.migrate();assert.equal((await care.readAftercare(f.customer,f.o.id)).return_case.refunded_kobo,f.q.total);
});
test('refund and dispatch races cannot progress a case or duplicate records',async()=>{
 const f=await livePaidFixture();await care.updateManualDelivery(f.actor,f.o.id,{status:'PREPARING',version:0,note:'Preparation started for this order'});
 await care.requestReturn(f.b.id,f.o.id,{reason:'Stop this order and review the payment'});
 const result=await Promise.allSettled([care.updateManualDelivery(f.actor,f.o.id,{version:1,status:'IN_TRANSIT',carrier:'Test team',tracking_reference:'TEST-123',note:'Must not dispatch during a return case'}),care.decideReturn(f.admin.id,f.o.id,{version:1,status:'APPROVED',amount_kobo:f.q.total,note:'Cancellation and refund approved after review'})]);
 assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'fulfilled');
 const body={amount_kobo:f.q.total,version:2,bank_debit_checked:true,recipient_checked:true};
 const refunds=await Promise.allSettled([care.recordRefund(f.admin.id,f.o.id,{...body,bank_reference:'DEBIT-'+crypto.randomUUID()}),care.recordRefund(f.admin.id,f.o.id,{...body,bank_reference:'DEBIT-'+crypto.randomUUID()})]);
 assert.equal(refunds.filter(r=>r.status==='fulfilled').length,1);
});
