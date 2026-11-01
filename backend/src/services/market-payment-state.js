// Isolated Monnify sandbox checkout. Live collection is deliberately unavailable.
import {monnifyReadiness} from './market-monnify-readiness.js';
export function checkoutConfig(){
 const apiKey=String(process.env.MARKET_MONNIFY_API_KEY||''),key=String(process.env.MARKET_MONNIFY_SECRET_KEY||''),contract=String(process.env.MARKET_MONNIFY_CONTRACT_CODE||'');
 let callback=null;try{const u=new URL(process.env.MARKET_MONNIFY_CALLBACK_URL||'');if(!u.username&&!u.password&&!u.search&&u.pathname.endsWith('/market-account.html')&&(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','terminal.local'].includes(u.hostname))))callback=u.href;}catch{}
 const available=monnifyReadiness().sandbox_configured;
 return {available,provider:'monnify',mode:available?'test':'off',callback,apiKey,key,contract,reason:available?'Monnify sandbox checkout. No real money or delivery.':'Payment collection is not available.'};
}
export function committedSql(order='mo.id'){
 if(!['mo.id','market_purchase_orders.id'].includes(order))throw Error('Unsupported order expression');
 return `(EXISTS (SELECT 1 FROM market_payment_attempts mp WHERE mp.order_id=${order} AND mp.stock_committed=1) OR EXISTS (SELECT 1 FROM market_bank_payments bp WHERE bp.order_id=${order} AND bp.status='CONFIRMED'))`;
}
export function effectiveOrderStatus(row,now=Date.now()){
 if(row.bank_status==='CONFIRMED')return 'PAID';
 if(row.bank_status==='CLAIMED')return 'PAYMENT_PENDING';
 if(row.bank_status==='REVIEW')return 'PAYMENT_REVIEW';
 if(row.payment_status==='REVIEW')return 'PAYMENT_REVIEW';
 if(row.payment_status==='SUCCEEDED'&&Number(row.stock_committed)===1)return 'TEST_PAID';
 return row.status==='AWAITING_PAYMENT'&&Number(row.expires_ms)<=now?'EXPIRED':row.status;
}
