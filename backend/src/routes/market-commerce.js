import {submitVideo,videoReviews,reviewVideo} from '../services/market-media.js';
import {pickupLocations,pickupOperations,savePickup,reviewPickup,deliveryTestAvailable,startShipment,updateShipment,readDelivery} from '../services/market-delivery.js';
import {checkoutConfig} from '../services/market-payment-state.js';
import {initializeCheckout,verifyCheckout,reconcileCheckout,paymentOperations} from '../services/market-payments.js';
import {acceptQuote,buyerOrders,sellerOrders,cancelOrder,operationsOrders,HOLD_MS} from '../services/market-orders.js';
import {sellerStore,submitStore,reviewStores,reviewStore,promotion,promotions} from '../services/market-stores.js';
import { Router, HttpError } from '../router.js';
import { get, run, atomic } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireBuyer, requestBuyerCode, verifyBuyerCode } from '../services/market-buyer-auth.js';
import { catalogue, preview, buyerCart, changeCart, mergeCart, saveAddress, STATES,
  createRequest,buyerRequests,cancelRequest,setInventory,sellerRequests,respondToRequest,operationsRequests } from '../services/market-commerce.js';

export const marketCommerceRouter=new Router();
function privateResponse(req,res){res.setHeader?.('Cache-Control','no-store');}
marketCommerceRouter.get('/api/market/capabilities',async(req,res)=>res.json(200,{
  email_signin_available:!!process.env.RESEND_API_KEY,payments_available:false,payment_provider:'monnify',test_checkout_available:checkoutConfig().available,checkout_mode:checkoutConfig().mode,
  mode:'quotes_and_unpaid_orders',stock_reserved:false,orders_available:true,delivery_booking_available:false,delivery_test_available:deliveryTestAvailable(),reservation_minutes:HOLD_MS/60000,delivery_countries:['NG'],states:STATES
}));
marketCommerceRouter.get('/api/market/catalog',async(req,res)=>res.json(200,await catalogue(new URL(req.url,'http://localhost').searchParams)));
marketCommerceRouter.post('/api/market/cart-preview',async(req,res)=>res.json(200,await preview(req.body?.items)));
marketCommerceRouter.post('/api/market/buyer/request-code',privateResponse,async(req,res)=>res.json(200,await requestBuyerCode(req.body?.email)));
marketCommerceRouter.post('/api/market/buyer/verify-code',privateResponse,async(req,res)=>res.json(200,await verifyBuyerCode(req.body?.challenge,req.body?.code)));
marketCommerceRouter.get('/api/market/buyer/me',privateResponse,requireBuyer,async(req,res)=>{
  const address=await get('SELECT recipient,phone,address,city,state,country FROM market_addresses WHERE buyer_id=?',[req.buyer.id]);
  res.json(200,{buyer:{id:Number(req.buyer.id),email:req.buyer.email,display_name:req.buyer.display_name},address:address||null});
});
marketCommerceRouter.post('/api/market/buyer/address',privateResponse,requireBuyer,async(req,res)=>res.json(200,await saveAddress(req.buyer.id,req.body)));
marketCommerceRouter.post('/api/market/buyer/logout',privateResponse,requireBuyer,async(req,res)=>{
  await atomic(()=>run('UPDATE market_buyers SET session_version=session_version+1 WHERE id=?',[req.buyer.id]));res.json(200,{ok:true});
});
marketCommerceRouter.get('/api/market/cart',privateResponse,requireBuyer,async(req,res)=>res.json(200,await buyerCart(req.buyer.id)));
marketCommerceRouter.post('/api/market/cart/item',privateResponse,requireBuyer,async(req,res)=>res.json(200,await changeCart(req.buyer.id,req.body?.id,req.body?.qty)));
marketCommerceRouter.post('/api/market/cart/merge',privateResponse,requireBuyer,async(req,res)=>res.json(200,await mergeCart(req.buyer.id,req.body?.items)));
marketCommerceRouter.post('/api/market/requests',privateResponse,requireBuyer,async(req,res)=>res.json(201,await createRequest(req.buyer.id,req.body)));
marketCommerceRouter.get('/api/market/requests',privateResponse,requireBuyer,async(req,res)=>res.json(200,await buyerRequests(req.buyer.id)));
marketCommerceRouter.post('/api/market/requests/:id/cancel',privateResponse,requireBuyer,async(req,res,params)=>res.json(200,await cancelRequest(req.buyer.id,params.id)));
marketCommerceRouter.patch('/api/market/seller/listings/:id/inventory',requireAuth('member'),async(req,res,params)=>res.json(200,await setInventory(req.user.id,params.id,req.body)));
marketCommerceRouter.get('/api/market/seller/requests',privateResponse,requireAuth('member'),async(req,res)=>res.json(200,await sellerRequests(req.user.id)));
marketCommerceRouter.post('/api/market/seller/requests/:id/respond',requireAuth('member'),async(req,res,params)=>res.json(200,await respondToRequest(req.user.id,params.id,req.body)));

marketCommerceRouter.get('/api/admin/market/requests',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await operationsRequests()));

marketCommerceRouter.get('/api/market/seller/store',privateResponse,requireAuth('member'),async(req,res)=>res.json(200,await sellerStore(req.user.id)));
marketCommerceRouter.post('/api/market/seller/store',privateResponse,requireAuth('member'),async(req,res)=>res.json(200,await submitStore(req.user.id,req.body)));
marketCommerceRouter.get('/api/admin/market/stores',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await reviewStores()));
marketCommerceRouter.post('/api/admin/market/stores/:id/review',privateResponse,requireAuth('staff','admin'),async(req,res,params)=>res.json(200,await reviewStore(req.user.id,params.id,req.body)));
marketCommerceRouter.get('/api/admin/market/promotions',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await promotions()));
marketCommerceRouter.post('/api/admin/market/listings/:id/promotion',privateResponse,requireAuth('staff','admin'),async(req,res,params)=>res.json(200,await promotion(req.user.id,params.id,req.body)));

marketCommerceRouter.post('/api/market/quotes/:id/accept',privateResponse,requireBuyer,async(req,res,params)=>res.json(201,await acceptQuote(req.buyer.id,params.id,req.body)));
marketCommerceRouter.get('/api/market/orders',privateResponse,requireBuyer,async(req,res)=>res.json(200,await buyerOrders(req.buyer.id)));
marketCommerceRouter.post('/api/market/orders/:id/cancel',privateResponse,requireBuyer,async(req,res,params)=>res.json(200,await cancelOrder({buyerId:req.buyer.id},params.id,req.body)));
marketCommerceRouter.get('/api/market/seller/orders',privateResponse,requireAuth('member'),async(req,res)=>res.json(200,await sellerOrders(req.user.id)));
marketCommerceRouter.post('/api/market/seller/orders/:id/cancel',privateResponse,requireAuth('member'),async(req,res,params)=>res.json(200,await cancelOrder({userId:req.user.id},params.id,req.body)));
marketCommerceRouter.get('/api/admin/market/orders',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await operationsOrders()));

marketCommerceRouter.post('/api/market/orders/:id/checkout',privateResponse,requireBuyer,async(req,res,params)=>res.json(200,await initializeCheckout(req.buyer.id,params.id,req.body)));
marketCommerceRouter.post('/api/market/orders/:id/payment/verify',privateResponse,requireBuyer,async(req,res,params)=>res.json(200,await verifyCheckout(req.buyer.id,params.id)));
marketCommerceRouter.get('/api/admin/market/payments',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await paymentOperations()));
marketCommerceRouter.post('/api/admin/market/orders/:id/payment/reconcile',privateResponse,requireAuth('staff','admin'),async(req,res,params)=>res.json(200,await reconcileCheckout(params.id)));

marketCommerceRouter.get('/api/market/delivery/options',async(req,res)=>res.json(200,{home_delivery:'SELLER_QUOTE',booking_available:false,pickup_locations:await pickupLocations(new URL(req.url,'http://localhost').searchParams.get('state')||'')}));
marketCommerceRouter.get('/api/admin/market/pickup-locations',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await pickupOperations(req.user.id)));
marketCommerceRouter.post('/api/admin/market/pickup-locations',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(201,await savePickup(req.user.id,null,req.body)));
marketCommerceRouter.post('/api/admin/market/pickup-locations/:id',privateResponse,requireAuth('staff','admin'),async(req,res,p)=>res.json(200,await savePickup(req.user.id,p.id,req.body)));
marketCommerceRouter.post('/api/admin/market/pickup-locations/:id/review',privateResponse,requireAuth('staff','admin'),async(req,res,p)=>res.json(200,await reviewPickup(req.user.id,p.id,req.body)));
marketCommerceRouter.get('/api/market/orders/:id/delivery',privateResponse,requireBuyer,async(req,res,p)=>res.json(200,await readDelivery({kind:'BUYER',id:req.buyer.id},p.id)));
marketCommerceRouter.post('/api/market/orders/:id/delivery/receipt',privateResponse,requireBuyer,async(req,res,p)=>res.json(200,await updateShipment({kind:'BUYER',id:req.buyer.id},p.id,{...req.body,status:'DELIVERED'})));
marketCommerceRouter.post('/api/market/seller/orders/:id/delivery/start',privateResponse,requireAuth('member'),async(req,res,p)=>res.json(200,await startShipment({kind:'SELLER',id:req.user.id},p.id)));
marketCommerceRouter.post('/api/market/seller/orders/:id/delivery/update',privateResponse,requireAuth('member'),async(req,res,p)=>res.json(200,await updateShipment({kind:'SELLER',id:req.user.id},p.id,req.body)));
marketCommerceRouter.get('/api/admin/market/orders/:id/delivery',privateResponse,requireAuth('staff','admin'),async(req,res,p)=>res.json(200,await readDelivery({kind:'STAFF',id:req.user.id},p.id)));
marketCommerceRouter.post('/api/admin/market/orders/:id/delivery/start',privateResponse,requireAuth('staff','admin'),async(req,res,p)=>res.json(200,await startShipment({kind:'STAFF',id:req.user.id},p.id)));
marketCommerceRouter.post('/api/admin/market/orders/:id/delivery/update',privateResponse,requireAuth('staff','admin'),async(req,res,p)=>res.json(200,await updateShipment({kind:'STAFF',id:req.user.id},p.id,req.body)));

marketCommerceRouter.post('/api/market/seller/listings/:id/video',privateResponse,requireAuth('member'),async(req,res,params)=>res.json(200,await submitVideo(req.user.id,params.id,req.body)));
marketCommerceRouter.get('/api/admin/market/videos',privateResponse,requireAuth('staff','admin'),async(req,res)=>res.json(200,await videoReviews(req.user.id)));
marketCommerceRouter.post('/api/admin/market/listings/:id/video/decision',privateResponse,requireAuth('staff','admin'),async(req,res,params)=>res.json(200,await reviewVideo(req.user.id,params.id,req.body)));
