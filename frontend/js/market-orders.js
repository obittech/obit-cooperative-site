// Order history and isolated Monnify sandbox checkout. No live collection or dispatch.
const OrderUI=(()=>{
 const $=id=>document.getElementById(id),escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=kobo=>'₦'+(Number(kobo)/100).toLocaleString('en-NG',{maximumFractionDigits:2});
 const when=ms=>new Date(ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'});
 let selected=null,sequence=0,bankAvailable=false;
 function clear(){sequence++;selected=null;$('buyerOrders').textContent='';$('acceptQuoteDetails').textContent='';$('acceptQuoteForm').reset();$('acceptQuoteDialog').close();}
 function review(shop){
  const subtotal=shop.items.reduce((n,i)=>n+Number(i.unit_kobo)*Number(i.quantity),0);
  selected={id:Number(shop.id),total:subtotal+Number(shop.delivery_kobo)};
  $('acceptQuoteDetails').innerHTML=`<p>Member shop ${Number(shop.seller_member_id)}</p>${DeliveryUI.preferenceCard(shop.fulfilment)}<ul>${shop.items.map(i=>`<li>${escape(i.title)} × ${Number(i.quantity)} <strong>${money(Number(i.unit_kobo)*Number(i.quantity))}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(subtotal)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(shop.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(selected.total)}</dd></div></dl><p class="order-notice">Accepting creates an order. You can open Pay Now to view bank-transfer instructions when checkout is available. Accepting reserves available stock for 15 minutes. The order will expire if unpaid. Do not send money to the seller. The seller estimates delivery in ${Number(shop.delivery_days)} days once a paid order is confirmed. Delivery follow-up is handled through Obit support after payment confirmation.</p>`;
  $('acceptQuoteForm').reset();$('acceptQuoteStatus').textContent='';$('acceptQuoteDialog').setAttribute('aria-labelledby','acceptQuoteHeading');$('acceptQuoteDialog').showModal();
 }
 async function refresh(){
  const current=++sequence;if(!MarketCommerce.signedIn())return;
  try{
   const [orders,caps]=await Promise.all([MarketCommerce.call('GET','/api/market/orders'),MarketCommerce.call('GET','/api/market/capabilities')]);bankAvailable=caps.bank_transfer_available===true;if(current!==sequence)return;
   $('buyerOrders').innerHTML=orders.length?orders.map(o=>`<article class="purchase-order"><div class="order-card-head"><h3>${escape(o.reference)}</h3><span class="status-badge">${escape({PAID:'Payment confirmed',PAYMENT_PENDING:'Payment awaiting confirmation',AWAITING_PAYMENT:'Unpaid · Stock held',EXPIRED:'Reservation expired',CANCELLED:'Cancelled',TEST_PAID:'Sandbox payment verified',PAYMENT_REVIEW:'Payment review required'}[o.status]||o.status)}</span></div><p>Member shop ${o.seller_id} · ${escape(o.destination.city)}, ${escape(o.destination.state)}</p><ul class="order-products">${o.items.map(i=>`<li><span>${escape(i.title)} × ${i.quantity}</span><strong>${money(i.unit_kobo*i.quantity)}</strong></li>`).join('')}</ul><dl class="order-totals"><div><dt>Products</dt><dd>${money(o.subtotal_kobo)}</dd></div><div><dt>Delivery estimate</dt><dd>${money(o.delivery_kobo)}</dd></div><div><dt>Total</dt><dd>${money(o.total_kobo)}</dd></div></dl><ol class="order-timeline">${o.events.map(e=>`<li><strong>${escape({CREATED:'Order created',CANCELLED:'Order cancelled',EXPIRED:'Reservation expired',CHECKOUT_READY:'Monnify sandbox checkout',CHECKOUT_UNCERTAIN:'Checkout status uncertain',PAYMENT_VERIFIED:'Sandbox payment verified',PAYMENT_REVIEW:'Payment review required',PAYMENT_FAILED:'Sandbox payment failed'}[e.kind]||e.kind)}</strong><time>${escape(when(e.occurred_ms))} (Nigeria time)</time><p>${escape(e.note)}</p></li>`).join('')}</ol>${paymentControls(o)}${o.bank_payment?'<p class="order-notice">For delivery updates, contact Obit on WhatsApp with your order reference. Our team follows up until you receive your goods.</p>':DeliveryUI.card(o)}${o.cancellation_available?`<form data-cancel-order="${o.id}"><label class="field">Cancellation reason<input name="reason" minlength="3" maxlength="300" required placeholder="For example, changed my mind"></label><button class="text-button" type="submit">Cancel unpaid order &amp; release stock</button><p role="status"></p></form>`:''}</article>`).join(''):'<p>No orders yet. Review a seller quote in Requests to create an unpaid order.</p>';
   bindPayments(orders);DeliveryUI.bind($('buyerOrders'),orders,'BUYER',refresh);
   $('buyerOrders').querySelectorAll('[data-cancel-order]').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const result=await MarketCommerce.call('POST',`/api/market/orders/${form.dataset.cancelOrder}/cancel`,{reason:form.elements.reason.value});await refresh();$('accountAlert').textContent=result.status==='CANCELLED'?'Order cancelled. Its stock reservation has been released.':'This order has expired. Its stock reservation has been released.';}catch(e){form.querySelector('[role=status]').textContent=e.message;button.disabled=false;}}));
  }catch(e){if(current===sequence)$('buyerOrders').textContent=e.message;}
 }

 function paymentControls(o){
  if(o.bank_payment||(!o.payment&&o.status==='AWAITING_PAYMENT'))return bankControls(o);
  const p=o.payment,test=o.checkout_mode==='test',live='Live payment collection and delivery booking are unavailable.';
  if(o.status==='TEST_PAID')return `<p class="order-notice">Monnify sandbox payment verified. No real money or dispatch. Reference: ${escape(p?.reference)}</p>`;
  const notice=o.status==='PAYMENT_REVIEW'?'Payment status requires review. Do not pay again or dispatch.':o.status==='AWAITING_PAYMENT'?`Stock held until ${escape(when(o.expires_ms))} (Nigeria time). ${p?'Check the existing payment status before trying again.':'No payment collected.'}`:'Stock reservation released. '+(p?'Check the existing payment status before trying again.':'No payment attempt was created.');
  return `<p class="order-notice">${notice} ${live}</p>${p?`<p class="fine-print">Monnify sandbox reference ${escape(p.reference)} · ${escape(p.status)}</p>`:''}${o.payment_available&&test?`<button class="btn" type="button" data-start-checkout="${o.id}">${p?'Open existing Monnify sandbox checkout':'Start Monnify sandbox checkout'}</button><p class="fine-print">Sandbox only. Checkout extends the stock hold to 45 minutes. Never send real money to a sandbox account.</p>`:!p&&o.status==='AWAITING_PAYMENT'?'<button class="btn" type="button" disabled>Monnify live checkout not yet available</button>':''}${p&&test?`<button class="text-button" type="button" data-check-payment="${o.id}">Check Monnify payment status</button>`:''}<div data-payment-result="${o.id}" role="status"></div>`;
 }
 function bankControls(o){
  const p=o.bank_payment;
  if(p?.status==='CONFIRMED')return `<section class="order-notice"><h4>Payment confirmed</h4><p>Receipt: ${escape(p.receipt_reference)}</p><p>${money(p.amount_kobo)} received for ${escape(o.reference)} on ${escape(when(p.confirmed_ms))} (Nigeria time).</p><p>Received by ${escape(p.account_name)} · ${escape(p.bank_name)}</p><a class="btn" href="${supportUrl(o)}" target="_blank" rel="noopener noreferrer">Follow up on delivery</a><button class="text-button" type="button" data-print-bank-receipt="${o.id}">Print / save receipt</button></section>`;
  if(p&&['CLAIMED','REVIEW'].includes(p.status))return `<section class="order-notice" role="status"><h4>Payment awaiting confirmation</h4><p>We have recorded your payment notification. Our team will check the bank credit. Please do not pay again.</p><a class="btn" href="${supportUrl(o)}" target="_blank" rel="noopener noreferrer">Continue on WhatsApp</a><p>No receipt upload required. We will follow up through delivery.</p></section>`;
  if(p)return bankDetails(o,p);
  return `<p class="order-notice">Pay by bank transfer, then click I Have Paid to continue on WhatsApp. No receipt upload required.</p><button class="btn" type="button" data-bank-start="${o.id}" ${bankAvailable?'':'disabled'}>Pay Now</button>${bankAvailable?'':'<p class="fine-print">Bank-transfer checkout is awaiting confirmation of the company receiving account.</p>'}<div data-bank-result="${o.id}" role="status"></div>`;
 }
 function supportUrl(o){return 'https://wa.me/2348030567787?text='+encodeURIComponent(`Hello Obit, please follow up on my order ${o.reference}, amount ${money(o.total_kobo)}, through payment confirmation and delivery.`);}
 function bankDetails(o,p){return `<section class="order-notice"><h4>Obit SafePay · Bank transfer</h4><dl class="order-totals"><div><dt>Bank</dt><dd>${escape(p.bank_name)}</dd></div><div><dt>Account name</dt><dd>${escape(p.account_name)}</dd></div><div><dt>Account number</dt><dd><strong>${escape(p.account_number)}</strong></dd></div><div><dt>Amount</dt><dd>${money(p.amount_kobo)}</dd></div><div><dt>Order reference</dt><dd>${escape(o.reference)}</dd></div></dl><p>Use your order reference in the transfer narration. After transferring, click below. Payment is confirmed after our team checks the bank credit.</p><button class="btn" type="button" data-bank-paid="${o.id}">I Have Paid</button><p>No receipt upload required. WhatsApp opens with your order reference and amount. Tap Send there to reach our team.</p><p data-bank-feedback="${o.id}" role="status"></p></section>`;}
 function bindPayments(orders){
  $('buyerOrders').querySelectorAll('[data-bank-start],[data-bank-paid],[data-print-bank-receipt]').forEach(button=>button.addEventListener('click',async()=>{
   const id=Number(button.dataset.bankStart||button.dataset.bankPaid||button.dataset.printBankReceipt),o=orders.find(x=>Number(x.id)===id);
   if(button.dataset.printBankReceipt){window.print();return;}
   const target=$('buyerOrders').querySelector(`[data-bank-result="${id}"],[data-bank-feedback="${id}"]`);button.disabled=true;
   try{
    if(button.dataset.bankStart){await MarketCommerce.call('POST',`/api/market/orders/${id}/bank-transfer`,{expected_total_kobo:o.total_kobo});await refresh();}
    else{const result=await MarketCommerce.call('POST',`/api/market/orders/${id}/bank-transfer/paid`,{});await refresh();window.location.assign(result.whatsapp_url);}
   }catch(e){if(target)target.textContent=e.message;button.disabled=false;}
  }));
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
