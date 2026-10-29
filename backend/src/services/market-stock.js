import {committedSql} from './market-payment-state.js';
import {get} from '../db.js';
// Only unexpired, unpaid orders hold stock. A clock-based predicate makes expiry
// release stock even if no worker or customer opens the expired order.
export function heldStockSql(listing='l.id',now=Date.now()){
 if(!['l.id','?'].includes(listing))throw Error('Unsupported stock expression');
 return `(SELECT COALESCE(SUM(oi.quantity),0) FROM market_purchase_order_items oi JOIN market_purchase_orders mo ON mo.id=oi.order_id WHERE oi.listing_id=${listing} AND mo.status='AWAITING_PAYMENT' AND mo.expires_ms>${Number(now)} AND NOT ${committedSql()})`;
}
export async function heldQuantity(id,now=Date.now()){
 const row=await get('SELECT '+heldStockSql('?',now)+' AS n',[id]);return Number(row.n);
}
