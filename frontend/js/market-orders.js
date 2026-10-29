// Unpaid order review and history. No payment or dispatch actions exist here.
const OrderUI=(()=>{
 const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=kobo=>'₦'+(Number(kobo)/100).toLocaleString('en-NG',{maximumFractionDigits:2});
 const when=ms=>new Date(ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'});
 let selected=null,sequence=0;
 function clear(){sequence++;selected=null;$('buyerOrders').textContent='';$('acceptQuoteDetails').textContent='';$('acceptQuoteForm').reset();$('acceptQuoteDialog').close();}
 function review(shop){
  const subtotal=shop.items.reduce((n,i)=>n+Number(i.unit_kobo)*Number(i.quantity),0);
  selected={id:Number(shop.id),total:subtotal+Number(shop.delivery_kobo)};
  $('acceptQuoteDetails').innerHTML=`<p>Member shop ${Number(shop.seller_member_id)}</p><ul>${shop.items.map(i=>`<li>${escape(i.title)} × ${Number(i.quantity)} <strong>${money(Number(i.unit_kobo)*Number(i.quantity))}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(subtotal)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(shop.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(selected.total)}</dd></div></dl><p class="order-notice">Payment collection is not available. Accepting reserves available stock for 15 minutes. The order will expire if unpaid. Do not send money to the seller. The seller estimates delivery in ${Number(shop.delivery_days)} days once a paid order is confirmed. No delivery is booked here.</p>`;
  $('acceptQuoteForm').reset();$('acceptQuoteStatus').textContent='';$('acceptQuoteDialog').setAttribute('aria-labelledby','acceptQuoteHeading');$('acceptQuoteDialog').showModal();
 }
 async function refresh(){
  const current=++sequence;if(!MarketCommerce.signedIn())return;
  try{
   const orders=await MarketCommerce.call('GET','/api/market/orders');if(current!==sequence)return;
   $('buyerOrders').innerHTML=orders.length?orders.map(o=>`<article class="purchase-order"><div class="order-card-head"><h3>${escape(o.reference)}</h3><span class="status-badge">${escape({AWAITING_PAYMENT:'Unpaid · Stock held',EXPIRED:'Reservation expired',CANCELLED:'Cancelled'}[o.status]||o.status)}</span></div><p>Member shop ${o.seller_id} · ${escape(o.destination.city)}, ${escape(o.destination.state)}</p><ul class="order-products">${o.items.map(i=>`<li><span>${escape(i.title)} × ${i.quantity}</span><strong>${money(i.unit_kobo*i.quantity)}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(o.subtotal_kobo)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(o.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(o.total_kobo)}</dd></div></dl><ol class="order-timeline">${o.events.map(e=>`<li><strong>${escape({CREATED:'Order created',CANCELLED:'Order cancelled',EXPIRED:'Reservation expired'}[e.kind]||e.kind)}</strong><time>${escape(when(e.occurred_ms))} (Nigeria time)</time><p>${escape(e.note)}</p></li>`).join('')}</ol>${o.status==='AWAITING_PAYMENT'?`<p class="order-notice">Stock held until ${escape(when(o.expires_ms))} (Nigeria time). Refresh to see current status. No payment collected and no delivery booked.</p><button class="btn" type="button" disabled>Payment collection unavailable</button><form data-cancel-order="${o.id}"><label class="field">Cancellation reason<input name="reason" minlength="3" maxlength="300" required placeholder="For example, changed my mind"></label><button class="text-button" type="submit">Cancel unpaid order &amp; release stock</button><p role="status"></p></form>`:'<p class="fine-print">No payment collected. Stock reservation released.</p>'}</article>`).join(''):'<p>No orders yet. Review a seller quote in Requests to create an unpaid order.</p>';
   $('buyerOrders').querySelectorAll('[data-cancel-order]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const result=await MarketCommerce.call('POST',`/api/market/orders/${form.dataset.cancelOrder}/cancel`,{reason:form.elements.reason.value});await refresh();$('accountAlert').textContent=result.status==='CANCELLED'?'Order cancelled. Its stock reservation has been released.':'This order has expired. Its stock reservation has been released.';}catch(e){form.querySelector('[role=status]').textContent=e.message;button.disabled=false;}}));
  }catch(e){if(current===sequence)$('buyerOrders').textContent=e.message;}
 }
 $('closeAcceptQuote').addEventListener('click',()=>$('acceptQuoteDialog').close());
 $('acceptQuoteForm').addEventListener('submit',async event=>{
  event.preventDefault();if(!selected)return;const button=event.target.querySelector('button');if(button.disabled)return;button.disabled=true;
  try{const result=await MarketCommerce.call('POST',`/api/market/quotes/${selected.id}/accept`,{expected_total_kobo:selected.total});$('acceptQuoteDialog').close();$('accountAlert').textContent=`${result.reference}: ${result.replayed?'Existing order opened.':'Unpaid order created.'} No payment collected.`;await refresh();ObitMobile.setAccountView('orders',true);$('orderHistory').scrollIntoView({block:'start'});document.dispatchEvent(new Event('market:order-created'));}
  catch(e){$('acceptQuoteStatus').textContent=e.message;}finally{button.disabled=false;}
 });
 $('refreshOrders').addEventListener('click',refresh);
 // Refresh on return to the page and when opening Orders. Server time determines expiry.
 document.querySelector('[data-account-view="orders"]').addEventListener('click',refresh);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
 return {review,refresh,clear};
})();
