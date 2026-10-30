// Order history and isolated Monnify sandbox checkout. No live collection or dispatch.
const OrderUI=(()=>{
 const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=kobo=>'₦'+(Number(kobo)/100).toLocaleString('en-NG',{maximumFractionDigits:2});
 const when=ms=>new Date(ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'});
 let selected=null,sequence=0;
 function clear(){sequence++;selected=null;$('buyerOrders').textContent='';$('acceptQuoteDetails').textContent='';$('acceptQuoteForm').reset();$('acceptQuoteDialog').close();}
 function review(shop){
  const subtotal=shop.items.reduce((n,i)=>n+Number(i.unit_kobo)*Number(i.quantity),0);
  selected={id:Number(shop.id),total:subtotal+Number(shop.delivery_kobo)};
  $('acceptQuoteDetails').innerHTML=`<p>Member shop ${Number(shop.seller_member_id)}</p>${DeliveryUI.preferenceCard(shop.fulfilment)}<ul>${shop.items.map(i=>`<li>${escape(i.title)} × ${Number(i.quantity)} <strong>${money(Number(i.unit_kobo)*Number(i.quantity))}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(subtotal)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(shop.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(selected.total)}</dd></div></dl><p class="order-notice">Payment collection is not available. Accepting reserves available stock for 15 minutes. The order will expire if unpaid. Do not send money to the seller. The seller estimates delivery in ${Number(shop.delivery_days)} days once a paid order is confirmed. No delivery is booked here.</p>`;
  $('acceptQuoteForm').reset();$('acceptQuoteStatus').textContent='';$('acceptQuoteDialog').setAttribute('aria-labelledby','acceptQuoteHeading');$('acceptQuoteDialog').showModal();
 }
 async function refresh(){
  const current=++sequence;if(!MarketCommerce.signedIn())return;
  try{
   const orders=await MarketCommerce.call('GET','/api/market/orders');if(current!==sequence)return;
   $('buyerOrders').innerHTML=orders.length?orders.map(o=>`<article class="purchase-order"><div class="order-card-head"><h3>${escape(o.reference)}</h3><span class="status-badge">${escape({AWAITING_PAYMENT:'Unpaid · Stock held',EXPIRED:'Reservation expired',CANCELLED:'Cancelled',TEST_PAID:'Sandbox payment verified',PAYMENT_REVIEW:'Payment review required'}[o.status]||o.status)}</span></div><p>Member shop ${o.seller_id} · ${escape(o.destination.city)}, ${escape(o.destination.state)}</p><ul class="order-products">${o.items.map(i=>`<li><span>${escape(i.title)} × ${i.quantity}</span><strong>${money(i.unit_kobo*i.quantity)}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(o.subtotal_kobo)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(o.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(o.total_kobo)}</dd></div></dl><ol class="order-timeline">${o.events.map(e=>`<li><strong>${escape({CREATED:'Order created',CANCELLED:'Order cancelled',EXPIRED:'Reservation expired',CHECKOUT_READY:'Monnify sandbox checkout',CHECKOUT_UNCERTAIN:'Checkout status uncertain',PAYMENT_VERIFIED:'Sandbox payment verified',PAYMENT_REVIEW:'Payment review required',PAYMENT_FAILED:'Sandbox payment failed'}[e.kind]||e.kind)}</strong><time>${escape(when(e.occurred_ms))} (Nigeria time)</time><p>${escape(e.note)}</p></li>`).join('')}</ol>${paymentControls(o)}${DeliveryUI.card(o)}${o.cancellation_available?`<form data-cancel-order="${o.id}"><label class="field">Cancellation reason<input name="reason" minlength="3" maxlength="300" required placeholder="For example, changed my mind"></label><button class="text-button" type="submit">Cancel unpaid order &amp; release stock</button><p role="status"></p></form>`:''}</article>`).join(''):'<p>No orders yet. Review a seller quote in Requests to create an unpaid order.</p>';
   bindPayments(orders);DeliveryUI.bind($('buyerOrders'),orders,'BUYER',refresh);
   $('buyerOrders').querySelectorAll('[data-cancel-order]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const result=await MarketCommerce.call('POST',`/api/market/orders/${form.dataset.cancelOrder}/cancel`,{reason:form.elements.reason.value});await refresh();$('accountAlert').textContent=result.status==='CANCELLED'?'Order cancelled. Its stock reservation has been released.':'This order has expired. Its stock reservation has been released.';}catch(e){form.querySelector('[role=status]').textContent=e.message;button.disabled=false;}}));
  }catch(e){if(current===sequence)$('buyerOrders').textContent=e.message;}
 }

 function paymentControls(o){
  const p=o.payment,test=o.checkout_mode==='test',live='Live payment collection and delivery booking are unavailable.';
  if(o.status==='TEST_PAID')return `<p class="order-notice">Monnify sandbox payment verified. No real money or dispatch. Reference: ${escape(p?.reference)}</p>`;
  const notice=o.status==='PAYMENT_REVIEW'?'Payment status requires review. Do not pay again or dispatch.':o.status==='AWAITING_PAYMENT'?`Stock held until ${escape(when(o.expires_ms))} (Nigeria time). ${p?'Check the existing payment status before trying again.':'No payment collected.'}`:'Stock reservation released. '+(p?'Check the existing payment status before trying again.':'No payment attempt was created.');
  return `<p class="order-notice">${notice} ${live}</p>${p?`<p class="fine-print">Monnify sandbox reference ${escape(p.reference)} · ${escape(p.status)}</p>`:''}${o.payment_available&&test?`<button class="btn" type="button" data-start-checkout="${o.id}">${p?'Open existing Monnify sandbox checkout':'Start Monnify sandbox checkout'}</button><p class="fine-print">Sandbox only. Checkout extends the stock hold to 45 minutes. Never send real money to a sandbox account.</p>`:!p&&o.status==='AWAITING_PAYMENT'?'<button class="btn" type="button" disabled>Monnify live checkout not yet available</button>':''}${p&&test?`<button class="text-button" type="button" data-check-payment="${o.id}">Check Monnify payment status</button>`:''}<div data-payment-result="${o.id}" role="status"></div>`;
 }
 function bindPayments(orders){
  $('buyerOrders').querySelectorAll('[data-start-checkout],[data-check-payment]').forEach(button=>button.addEventListener('click',async()=>{
   const start=!!button.dataset.startCheckout,id=Number(button.dataset.startCheckout||button.dataset.checkPayment),o=orders.find(x=>x.id===id),target=$('buyerOrders').querySelector(`[data-payment-result="${id}"]`);button.disabled=true;target.textContent=start?'Preparing Monnify sandbox checkout.':'Checking with Monnify. Do not pay again.';
   try{
    const result=await MarketCommerce.call('POST',`/api/market/orders/${id}/${start?'checkout':'payment/verify'}`,start?{expected_total_kobo:o.total_kobo}:{});
    await refresh();const next=$('buyerOrders').querySelector(`[data-payment-result="${id}"]`);
    if(start&&result.checkout_url){const url=new URL(result.checkout_url);if(url.protocol!=='https:'||url.hostname!=='sandbox.sdk.monnify.com'||!url.pathname.startsWith('/checkout/')||url.username||url.password)throw Error('Unexpected checkout address.');if(next)next.innerHTML=`<a class="btn" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">Continue to Monnify sandbox →</a><p class="fine-print">This opens Monnify’s test payment page. Return here and check payment status after testing.</p>`;}
    else if(next)next.textContent=result.status==='SUCCEEDED'?'Monnify sandbox payment verified. No real money.':result.status==='REVIEW'?'Payment requires review. Do not pay again.':'Current payment status: '+result.status;
   }catch(e){const latest=$('buyerOrders').querySelector(`[data-payment-result="${id}"]`);(latest||target).textContent=e.message;button.disabled=false;}
  }));
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
