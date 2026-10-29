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
