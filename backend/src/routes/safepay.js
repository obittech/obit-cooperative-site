// routes/safepay.js
// Obit Market + Obit SafePay MVP.
// Obit never marks funds as secured from the browser. Provider-funded state
// will only be accepted through a verified provider webhook once EscrowPay
// supplies the signed webhook contract.

import crypto from 'node:crypto';
import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { createEscrow, safePayProviderStatus } from '../services/safepay-provider.js';

export const safePayRouter = new Router();

function memberForUser(userId) {
  const member = get('SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!member || member.status !== 'ACTIVE') throw new HttpError(403, 'Active cooperative membership required');
  return member;
}
function publicListing(row) {
  return {
    id: row.id, title: row.title, description: row.description,
    price: Number(row.price_kobo || 0) / 100, currency: row.currency,
    category: row.category, status: row.status, created_at: row.created_at,
  };
}

safePayRouter.get('/api/market/listings', async (req, res) => {
  const rows = all("SELECT id,title,description,price_kobo,currency,category,status,created_at FROM market_listings WHERE status='ACTIVE' ORDER BY id DESC LIMIT 100");
  res.json(200, rows.map(publicListing));
});

safePayRouter.get('/api/safepay/status', async (req, res) => {
  res.json(200, { product: 'Obit SafePay', custody: 'third_party_regulated_partner', ...safePayProviderStatus() });
});

safePayRouter.post('/api/market/listings', requireAuth('member'), async (req, res) => {
  const member = memberForUser(req.user.id);
  const { title, description='', category='Other', price } = req.body || {};
  const priceKobo = Math.round(Number(price) * 100);
  if (!title || title.trim().length < 3) throw new HttpError(400, 'Listing title is required');
  if (!Number.isSafeInteger(priceKobo) || priceKobo < 2000000) throw new HttpError(400, 'SafePay marketplace listings must be at least ₦20,000 during the pilot');
  if (priceKobo > 300000000) throw new HttpError(400, 'SafePay pilot limit is ₦3,000,000 per transaction');
  const result = run(`INSERT INTO market_listings (seller_member_id,title,description,category,price_kobo,currency,status)
    VALUES (?,?,?,?,?,'NGN','ACTIVE')`, [member.id,title.trim(),String(description).trim(),String(category).trim(),priceKobo]);
  audit(req.user.id,'MARKET_LISTING_CREATED','market_listings',Number(result.lastInsertRowid),{price_kobo:priceKobo});
  res.json(201,{id:Number(result.lastInsertRowid),status:'ACTIVE'});
});

safePayRouter.post('/api/market/orders', requireAuth('member'), async (req, res) => {
  const buyer = memberForUser(req.user.id);
  const listing = get("SELECT * FROM market_listings WHERE id=? AND status='ACTIVE'", [Number(req.body?.listing_id)]);
  if (!listing) throw new HttpError(404,'Listing not found');
  if (listing.seller_member_id === buyer.id) throw new HttpError(409,'You cannot buy your own listing');
  const reference = `OBM-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const result = run(`INSERT INTO market_orders
    (reference,listing_id,buyer_member_id,seller_member_id,amount_kobo,currency,status)
    VALUES (?,?,?,?,?,'NGN','CREATED')`,
    [reference,listing.id,buyer.id,listing.seller_member_id,listing.price_kobo]);
  audit(req.user.id,'MARKET_ORDER_CREATED','market_orders',Number(result.lastInsertRowid),{reference});
  res.json(201,{id:Number(result.lastInsertRowid),reference,status:'CREATED',amount:Number(listing.price_kobo)/100,currency:'NGN'});
});

safePayRouter.post('/api/safepay/orders/:id/fund', requireAuth('member'), async (req, res, params) => {
  const buyer = memberForUser(req.user.id);
  const order = get(`SELECT o.*, l.title FROM market_orders o JOIN market_listings l ON l.id=o.listing_id
    WHERE o.id=? AND o.buyer_member_id=?`, [Number(params.id),buyer.id]);
  if (!order) throw new HttpError(404,'Order not found');
  if (order.status !== 'CREATED') throw new HttpError(409,`Order cannot be funded from ${order.status}`);

  const buyerUser = get('SELECT phone FROM users WHERE id=?',[req.user.id]);
  const seller = get(`SELECT u.phone FROM members m JOIN users u ON u.id=m.user_id WHERE m.id=?`,[order.seller_member_id]);
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
    run("UPDATE market_orders SET provider='escrowpay',provider_escrow_id=?,status='AWAITING_FUNDING',updated_at=datetime('now') WHERE id=?",
      [String(escrowId),order.id]);
    audit(req.user.id,'SAFEPAY_ESCROW_CREATED','market_orders',order.id,{reference:order.reference,provider_escrow_id:String(escrowId)});
    res.json(201,{order_id:order.id,reference:order.reference,status:'AWAITING_FUNDING',funding:p.funding || p.data?.funding || p});
  } catch (err) {
    audit(req.user.id,'SAFEPAY_ESCROW_CREATE_FAILED','market_orders',order.id,{error:err.message});
    throw new HttpError(503,err.message);
  }
});

safePayRouter.get('/api/safepay/orders', requireAuth('member'), async (req,res) => {
  const member=memberForUser(req.user.id);
  const rows=all(`SELECT o.id,o.reference,o.amount_kobo,o.currency,o.status,o.created_at,o.updated_at,l.title,
    CASE WHEN o.buyer_member_id=? THEN 'BUYER' ELSE 'SELLER' END AS role
    FROM market_orders o JOIN market_listings l ON l.id=o.listing_id
    WHERE o.buyer_member_id=? OR o.seller_member_id=? ORDER BY o.id DESC LIMIT 100`,[member.id,member.id,member.id]);
  res.json(200,rows.map(r=>({...r,amount:Number(r.amount_kobo)/100,amount_kobo:undefined})));
});

safePayRouter.post('/api/safepay/orders/:id/confirm-delivery', requireAuth('member'), async (req,res,params)=>{
  const buyer=memberForUser(req.user.id);
  const order=get('SELECT * FROM market_orders WHERE id=? AND buyer_member_id=?',[Number(params.id),buyer.id]);
  if(!order) throw new HttpError(404,'Order not found');
  if(order.status!=='DELIVERED') throw new HttpError(409,'Delivery must be recorded before buyer confirmation');
  // Release remains deliberately disabled until signed provider webhook + sandbox contract are configured.
  run("UPDATE market_orders SET status='DELIVERY_CONFIRMED',updated_at=datetime('now') WHERE id=?",[order.id]);
  audit(req.user.id,'SAFEPAY_DELIVERY_CONFIRMED','market_orders',order.id,{reference:order.reference});
  res.json(200,{id:order.id,status:'DELIVERY_CONFIRMED',release_pending:true});
});

safePayRouter.post('/api/safepay/orders/:id/disputes', requireAuth('member'), async (req,res,params)=>{
  const member=memberForUser(req.user.id);
  const order=get('SELECT * FROM market_orders WHERE id=? AND (buyer_member_id=? OR seller_member_id=?)',[Number(params.id),member.id,member.id]);
  if(!order) throw new HttpError(404,'Order not found');
  if(['RELEASED','REFUNDED','CANCELLED'].includes(order.status)) throw new HttpError(409,'This order is already settled');
  const reason=String(req.body?.reason||'').trim();
  if(reason.length<10) throw new HttpError(400,'Please describe the dispute');
  const result=run("INSERT INTO market_disputes (order_id,opened_by_member_id,reason,status) VALUES (?,?,?,'OPEN')",[order.id,member.id,reason]);
  run("UPDATE market_orders SET status='DISPUTED',updated_at=datetime('now') WHERE id=?",[order.id]);
  audit(req.user.id,'SAFEPAY_DISPUTE_OPENED','market_disputes',Number(result.lastInsertRowid),{order_id:order.id});
  res.json(201,{id:Number(result.lastInsertRowid),order_id:order.id,status:'OPEN'});
});
