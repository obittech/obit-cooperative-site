// routes/safepay.js
// Obit Market + Obit SafePay MVP.
// Technology infrastructure: Obit Technologies Limited.
// Community partner: Obit Technologies Multipurpose Cooperative Society Limited.
// Neither Obit entity marks funds as secured from the browser. Provider-funded
// state will only be accepted through a verified provider webhook after the
// provider supplies the signed webhook/authentication contract.

import crypto from 'node:crypto';
import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { createEscrow, safePayProviderStatus } from '../services/safepay-provider.js';
import { parseNgnToKobo } from '../utils/money.js';

export const safePayRouter = new Router();

const ANCHOR_COMMUNITY_SLUG = 'obit-cooperative';
async function anchorCommunity() {
  const community = await get('SELECT * FROM communities WHERE slug = ?', [ANCHOR_COMMUNITY_SLUG]);
  if (!community || community.status !== 'ACTIVE') throw new HttpError(503, 'Anchor community is not configured');
  return community;
}

async function memberForUser(userId) {
  const member = await get('SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!member || member.status !== 'ACTIVE') throw new HttpError(403, 'Active cooperative membership required');
  return member;
}
function publicListing(row) {
  return {
    id: row.id, title: row.title, description: row.description,
    price: Number(row.price_kobo || 0) / 100, currency: row.currency,
    category: row.category, status: row.status, created_at: row.created_at, image_url: row.image_url || null,
  };
}

safePayRouter.get('/api/market/listings', async (req, res) => {
  const community = await anchorCommunity();
  const rows = await all(`SELECT l.id,l.title,l.description,l.price_kobo,l.currency,l.category,l.status,l.created_at,l.image_url
    FROM market_listings l JOIN members m ON m.id=l.seller_member_id
    WHERE l.community_id=? AND l.status='ACTIVE' AND m.status='ACTIVE'
    ORDER BY l.id DESC LIMIT 100`, [community.id]);
  res.json(200, rows.map(publicListing));
});

safePayRouter.get('/api/safepay/status', async (req, res) => {
  res.json(200, {
    product: 'Obit SafePay',
    platform: 'Obit Market',
    technology_operator: 'Obit Technologies Limited',
    community_partner: 'Obit Technologies Multipurpose Cooperative Society Limited',
    custody: 'approved_third_party_financial_provider',
    obit_custody: false,
    ...safePayProviderStatus()
  });
});

safePayRouter.post('/api/market/listings', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const community = await anchorCommunity();
  const { title, description='', category='Other', price, image_url=null } = req.body || {};
  let imageUrl = null;
  if (image_url !== null && image_url !== '') {
    if (typeof image_url !== 'string' || image_url.length > 2048) throw new HttpError(400, 'Product photo must be a valid HTTPS link');
    try {
      const url = new URL(image_url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid image URL');
      imageUrl = url.href;
    } catch { throw new HttpError(400, 'Product photo must be a valid HTTPS link'); }
  }
  let priceKobo;
  try { priceKobo = parseNgnToKobo(price); } catch { throw new HttpError(400, 'Enter a valid price with no more than two decimal places'); }
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) throw new HttpError(400, 'Listing title must be 3 to 120 characters');
  if (typeof description !== 'string' || description.trim().length > 2000) throw new HttpError(400, 'Description must be at most 2000 characters');
  if (typeof category !== 'string' || category.trim().length < 2 || category.trim().length > 60) throw new HttpError(400, 'Category must be 2 to 60 characters');
  if (!Number.isSafeInteger(priceKobo) || priceKobo < 2000000) throw new HttpError(400, 'SafePay marketplace listings must be at least ₦20,000 during the pilot');
  if (priceKobo > 300000000) throw new HttpError(400, 'SafePay pilot limit is ₦3,000,000 per transaction');
  const result = await run(`INSERT INTO market_listings (community_id,seller_member_id,title,description,category,price_kobo,image_url,currency,status)
    VALUES (?,?,?,?,?,?,?,'NGN','DRAFT')`, [community.id,member.id,title.trim(),description.trim(),category.trim(),priceKobo,imageUrl]);
  await audit(req.user.id,'MARKET_LISTING_SUBMITTED','market_listings',Number(result.lastInsertRowid),{price_kobo:priceKobo});
  res.json(201,{id:Number(result.lastInsertRowid),status:'DRAFT'});
});

safePayRouter.get('/api/market/my-listings', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const rows = await all('SELECT id,title,description,category,price_kobo,currency,status,created_at,image_url FROM market_listings WHERE seller_member_id=? ORDER BY id DESC LIMIT 100', [member.id]);
  res.json(200, rows.map(row => ({...publicListing(row), status:row.status})));
});

safePayRouter.get('/api/admin/market/listings', requireAuth('staff', 'admin'), async (req, res) => {
  const rows = await all(`SELECT l.id,l.title,l.description,l.category,l.price_kobo,l.status,l.created_at,l.image_url,
    m.member_code,m.status AS member_status,a.full_legal_name
    FROM market_listings l JOIN members m ON m.id=l.seller_member_id
    JOIN member_applications a ON a.id=m.application_id
    WHERE l.status IN ('DRAFT','ACTIVE','PAUSED') ORDER BY l.id DESC LIMIT 200`);
  res.json(200, rows.map(row => ({...row, price:Number(row.price_kobo)/100, price_kobo:undefined})));
});

safePayRouter.post('/api/admin/market/listings/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const id = Number(params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid listing ID');
  const decision = String(req.body?.decision || '');
  const transitions = { APPROVE:['DRAFT','ACTIVE'], REJECT:['DRAFT','REMOVED'], PAUSE:['ACTIVE','PAUSED'], RESUME:['PAUSED','ACTIVE'] };
  if (!transitions[decision]) throw new HttpError(400, 'Invalid listing decision');
  const [from,to] = transitions[decision];
  const listing = await get('SELECT l.status,m.status AS member_status FROM market_listings l JOIN members m ON m.id=l.seller_member_id WHERE l.id=?', [id]);
  if (!listing) throw new HttpError(404, 'Listing not found');
  if (listing.status !== from) throw new HttpError(409, `Listing must be ${from} for this action`);
  if (to === 'ACTIVE' && listing.member_status !== 'ACTIVE') throw new HttpError(409, 'Seller membership is not active');
  const updated = await run("UPDATE market_listings SET status=?,updated_at=datetime('now') WHERE id=? AND status=?", [to,id,from]);
  if (updated.changes !== 1) throw new HttpError(409, 'Listing changed during review');
  await audit(req.user.id,`MARKET_LISTING_${decision}`,'market_listings',id);
  res.json(200,{id,status:to});
});

safePayRouter.post('/api/market/orders', requireAuth('member'), async (req, res) => {
  const buyer = await memberForUser(req.user.id);
  const community = await anchorCommunity();
  const listing = await get(`SELECT l.* FROM market_listings l JOIN members m ON m.id=l.seller_member_id
    WHERE l.id=? AND l.community_id=? AND l.status='ACTIVE' AND m.status='ACTIVE'`, [Number(req.body?.listing_id), community.id]);
  if (!listing) throw new HttpError(404,'Listing not found');
  if (listing.seller_member_id === buyer.id) throw new HttpError(409,'You cannot buy your own listing');
  const reference = `OBM-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const result = await run(`INSERT INTO market_orders
    (community_id,reference,listing_id,buyer_member_id,seller_member_id,amount_kobo,currency,status)
    VALUES (?,?,?,?,?,?,'NGN','CREATED')`,
    [community.id,reference,listing.id,buyer.id,listing.seller_member_id,listing.price_kobo]);
  await audit(req.user.id,'MARKET_ORDER_CREATED','market_orders',Number(result.lastInsertRowid),{reference});
  res.json(201,{id:Number(result.lastInsertRowid),reference,status:'CREATED',amount:Number(listing.price_kobo)/100,currency:'NGN'});
});

safePayRouter.post('/api/safepay/orders/:id/fund', requireAuth('member'), async (req, res, params) => {
  const buyer = await memberForUser(req.user.id);
  const order = await get(`SELECT o.*, l.title FROM market_orders o JOIN market_listings l ON l.id=o.listing_id
    WHERE o.id=? AND o.buyer_member_id=?`, [Number(params.id),buyer.id]);
  if (!order) throw new HttpError(404,'Order not found');
  if (order.status !== 'CREATED') throw new HttpError(409,`Order cannot be funded from ${order.status}`);

  const buyerUser = await get('SELECT phone FROM users WHERE id=?',[req.user.id]);
  const seller = await get(`SELECT u.phone FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=?`,[order.seller_member_id]);
  if (!buyerUser?.phone || !seller?.phone) throw new HttpError(400,'Buyer and seller must have verified phone numbers');

  try {
    const p = await createEscrow({
      amountNaira:Number(order.amount_kobo)/100,
      buyerPhone:buyerUser.phone,
      sellerPhone:seller.phone,
      reference:order.reference,
      terms:order.title,
    });
    const escrowId = p.escrow_id || p.id || p.data?.escrow_id || p.data?.id;
    if (!escrowId) throw new Error('Provider did not return an escrow id');
    await run("UPDATE market_orders SET provider='escrowpay',provider_escrow_id=?,status='AWAITING_FUNDING',updated_at=datetime('now') WHERE id=?",
      [String(escrowId),order.id]);
    await audit(req.user.id,'SAFEPAY_ESCROW_CREATED','market_orders',order.id,{reference:order.reference,provider_escrow_id:String(escrowId)});
    res.json(201,{order_id:order.id,reference:order.reference,status:'AWAITING_FUNDING',funding:p.funding || p.data?.funding || p});
  } catch (err) {
    await audit(req.user.id,'SAFEPAY_ESCROW_CREATE_FAILED','market_orders',order.id,{error:err.message});
    throw new HttpError(503,err.message);
  }
});

safePayRouter.get('/api/safepay/orders', requireAuth('member'), async (req,res) => {
  const member=await memberForUser(req.user.id);
  const rows=await all(`SELECT o.id,o.reference,o.amount_kobo,o.currency,o.status,o.created_at,o.updated_at,l.title,
    CASE WHEN o.buyer_member_id=? THEN 'BUYER' ELSE 'SELLER' END AS role
    FROM market_orders o JOIN market_listings l ON l.id=o.listing_id
    WHERE o.buyer_member_id=? OR o.seller_member_id=? ORDER BY o.id DESC LIMIT 100`,[member.id,member.id,member.id]);
  res.json(200,rows.map(r=>({...r,amount:Number(r.amount_kobo)/100,amount_kobo:undefined})));
});

safePayRouter.post('/api/safepay/orders/:id/confirm-delivery', requireAuth('member'), async (req,res,params)=>{
  const buyer=await memberForUser(req.user.id);
  const order=await get('SELECT * FROM market_orders WHERE id=? AND buyer_member_id=?',[Number(params.id),buyer.id]);
  if(!order) throw new HttpError(404,'Order not found');
  if(order.status!=='DELIVERED') throw new HttpError(409,'Delivery must be recorded before buyer confirmation');
  // Release remains disabled until signed provider webhook/auth contract and sandbox E2E are complete.
  await run("UPDATE market_orders SET status='DELIVERY_CONFIRMED',updated_at=datetime('now') WHERE id=?",[order.id]);
  await audit(req.user.id,'SAFEPAY_DELIVERY_CONFIRMED','market_orders',order.id,{reference:order.reference});
  res.json(200,{id:order.id,status:'DELIVERY_CONFIRMED',release_pending:true});
});

safePayRouter.post('/api/safepay/orders/:id/disputes', requireAuth('member'), async (req,res,params)=>{
  const member=await memberForUser(req.user.id);
  const order=await get('SELECT * FROM market_orders WHERE id=? AND (buyer_member_id=? OR seller_member_id=?)',[Number(params.id),member.id,member.id]);
  if(!order) throw new HttpError(404,'Order not found');
  if(['RELEASED','REFUNDED','CANCELLED'].includes(order.status)) throw new HttpError(409,'This order is already settled');
  const reason=String(req.body?.reason||'').trim();
  if(reason.length<10) throw new HttpError(400,'Please describe the dispute');
  const result=await run("INSERT INTO market_disputes (order_id,opened_by_member_id,reason,status) VALUES (?,?,?,'OPEN')",[order.id,member.id,reason]);
  await run("UPDATE market_orders SET status='DISPUTED',updated_at=datetime('now') WHERE id=?",[order.id]);
  await audit(req.user.id,'SAFEPAY_DISPUTE_OPENED','market_disputes',Number(result.lastInsertRowid),{order_id:order.id});
  res.json(201,{id:Number(result.lastInsertRowid),order_id:order.id,status:'OPEN'});
});
