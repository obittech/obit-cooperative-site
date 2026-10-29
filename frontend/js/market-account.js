const $=id=>document.getElementById(id);
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const naira=kobo=>'₦'+(Number(kobo)/100).toLocaleString('en-NG',{maximumFractionDigits:2});
let challenge='',bag=null,submitting=false,addressDirty=false;
function message(text){$('accountAlert').textContent=text;}
function showSession(){const yes=MarketCommerce.signedIn();$('buyerAccount').hidden=!yes;$('signInSection').hidden=yes;if(yes){const p=MarketCommerce.profile();$('buyerEmail').textContent=p.buyer.email;if(p.address)for(const key of ['recipient','phone','address','city','state'])$('buyerAddressForm').elements[key].value=p.address[key]||'';}}
async function busy(form,action){const button=form.querySelector('button[type="submit"]');button.disabled=true;try{await action();}catch(e){message(e.message);}finally{button.disabled=false;}}
$('buyerEmailForm').addEventListener('submit',event=>{event.preventDefault();busy(event.target,async()=>{
 const result=await MarketCommerce.call('POST','/api/market/buyer/request-code',{email:event.target.elements.email.value.trim()});
 challenge=result.challenge;$('buyerCodeForm').hidden=false;$('buyerEmailForm').hidden=true;message(result.message);$('buyerCodeForm').elements.code.focus();
});});
$('changeBuyerEmail').addEventListener('click',()=>{$('buyerEmailForm').hidden=false;$('buyerCodeForm').hidden=true;challenge='';message('Enter your email to request a new code. Codes can be requested once per minute.');});
$('buyerCodeForm').addEventListener('submit',event=>{event.preventDefault();busy(event.target,async()=>{
 await MarketCommerce.verify(challenge,event.target.elements.code.value.trim());
 showSession();message('You are signed in.');
 try{const result=await MarketCommerce.connectGuest();if(result.skipped_items?.length)message('Signed in. Some guest bag items are unavailable and could not be added.');}catch(e){message('Signed in. Your guest bag could not be synced: '+e.message);}
 await Promise.all([refreshBag(),refreshRequests()]);
});});
$('buyerAddressForm').addEventListener('submit',event=>{event.preventDefault();busy(event.target,async()=>{
 const values=Object.fromEntries(new FormData(event.target));values.country='NG';await MarketCommerce.saveAddress(values);addressDirty=false;message('Delivery details saved.');updateRequestButton();ObitMobile.setAccountView('bag',true);
});});
$('buyerAddressForm').addEventListener('input',()=>{addressDirty=true;updateRequestButton();});
$('buyerLogout').addEventListener('click',async()=>{try{await MarketCommerce.logout();message('Signed out of all shopping sessions.');}catch(e){message(e.message);}});
document.addEventListener('market:signout',()=>{challenge='';$('buyerEmailForm').reset();$('buyerEmailForm').hidden=false;$('buyerCodeForm').reset();$('buyerCodeForm').hidden=true;bag=null;$('accountBag').textContent='';$('buyerRequests').textContent='';$('buyerAddressForm').reset();showSession();});
function updateRequestButton(){const ready=!!bag?.items.length&&bag.lines.every(l=>l.available)&&!!MarketCommerce.profile()?.address&&!addressDirty;$('submitQuoteRequest').disabled=!ready||submitting;const a=MarketCommerce.profile()?.address;$('accountDeliverySummary').textContent=addressDirty?'Save your delivery changes before requesting quotes.':a?`Delivery to ${a.recipient} · ${a.city}, ${a.state}`:'Add your delivery details to request seller quotes.';const badge=$('accountBagCount');if(badge){const count=bag?.items.reduce((n,i)=>n+i.qty,0)||0;badge.textContent=count;badge.hidden=count===0;}}
async function refreshBag(){
 try{bag=await MarketCommerce.cart();
 $('accountBag').innerHTML=bag.lines.length?bag.lines.map(l=>`<article class="account-bag-line"><div><h3>${html(l.product?.title||'Unavailable product #'+l.id)}</h3><p>${html(l.product?.seller_name||'')} · Quantity ${l.qty}</p><p>${l.available?l.product?.stock_quantity===null?'Stock to be confirmed by seller':'Stock available at last check':'Unavailable — edit your bag before requesting'}</p></div><strong>${l.available?naira(l.subtotal_kobo):'Unavailable'}</strong></article>`).join(''):'<p>Your bag is empty. Add products from the marketplace.</p>';
 $('accountBagTotal').innerHTML=`<div class="bag-total"><span>Available product subtotal</span><strong>${naira(bag.total_kobo)}</strong></div><p class="fine-print">Delivery fees are quoted separately by each seller.</p>`;
 updateRequestButton();
 }catch(e){bag=null;updateRequestButton();$('accountBagTotal').textContent='Refresh your bag to check the current total.';message(e.message);}
}
async function refreshRequests(){
 try{const requests=await MarketCommerce.call('GET','/api/market/requests');
 $('buyerRequests').innerHTML=requests.length?requests.map(r=>`<article class="quote-card"><div class="account-welcome"><div><h3>${html(r.reference)}</h3><span class="status-badge">${r.status==='CANCELLED'?'Cancelled':'Quote request'}</span></div>${r.status==='REQUESTED'?`<button type="button" class="text-button" data-cancel-request="${r.id}">Cancel request</button>`:''}</div><p>Products: <strong>${naira(r.subtotal_kobo)}</strong> · Delivery to ${html(r.address.city)}, ${html(r.address.state)}</p>${r.shops.map(s=>`<section class="quote-shop"><h4>Member shop ${Number(s.seller_member_id)} · ${html({REQUESTED:'Awaiting seller',QUOTED:'Seller quoted',DECLINED:'Seller declined',CANCELLED:'Cancelled'}[s.status]||s.status)}</h4><ul>${s.items.map(i=>`<li>${html(i.title)} × ${Number(i.quantity)} — ${naira(Number(i.unit_kobo)*Number(i.quantity))}</li>`).join('')}</ul>${s.status==='QUOTED'?`<p>Delivery estimate: <strong>${naira(s.delivery_kobo)}</strong> · ${Number(s.delivery_days)} days</p>`:''}${s.seller_note?`<p class="quote-note">${html(s.seller_note)}</p>`:''}</section>`).join('')}<p class="fine-print">No payment collected. No stock reserved. Delivery estimates are subject to confirmation before purchase.</p></article>`).join(''):'<p>Your quote requests will appear here.</p>';
 $('buyerRequests').querySelectorAll('[data-cancel-request]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await MarketCommerce.call('POST',`/api/market/requests/${Number(button.dataset.cancelRequest)}/cancel`,{});sessionStorage.removeItem('obit_market_quote_draft');await refreshRequests();message('Quote request cancelled.');}catch(e){button.disabled=false;message(e.message);}}));
 }catch(e){message(e.message);}
}
$('submitQuoteRequest').addEventListener('click',async()=>{
 if(submitting||!MarketCommerce.profile()?.address)return;
 const reviewed=JSON.stringify({items:bag?.items,total:bag?.total_kobo});
 submitting=true;updateRequestButton();
 try{
  await refreshBag();if(JSON.stringify({items:bag?.items,total:bag?.total_kobo})!==reviewed)throw Error('Your bag or prices changed. Review the refreshed bag before requesting quotes.');if(!bag?.items.length||bag.lines.some(l=>!l.available))throw Error('Refresh your bag and remove unavailable items.');
  const body={items:bag.items,address:MarketCommerce.profile().address,expected_total_kobo:bag.total_kobo};
  const signature=JSON.stringify(body);let draft;
  try{draft=JSON.parse(sessionStorage.getItem('obit_market_quote_draft')||'null');}catch{}
  if(draft?.signature!==signature){draft={signature,key:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')};sessionStorage.setItem('obit_market_quote_draft',JSON.stringify(draft));}
  const result=await MarketCommerce.call('POST','/api/market/requests',{...body,request_key:draft.key});
  message(`${result.reference}: ${result.replayed?'Your existing request is shown below.':'Quote request sent to the member sellers.'} No payment was collected.`);
  await refreshRequests();ObitMobile.setAccountView('requests');$('buyerRequests').scrollIntoView({block:'start',behavior:'smooth'});
 }catch(e){message(e.message);}finally{submitting=false;updateRequestButton();}
});
$('refreshAccountBag').addEventListener('click',refreshBag);$('refreshRequests').addEventListener('click',refreshRequests);
(async()=>{
 try{
  const caps=await MarketCommerce.call('GET','/api/market/capabilities');
  $('buyerAddressForm').elements.state.innerHTML='<option value="">Select state</option>'+caps.states.map(s=>`<option>${html(s)}</option>`).join('');
  if(!caps.email_signin_available){$('sendBuyerCode').disabled=true;$('emailServiceStatus').textContent='Email sign-in is being configured. You can continue browsing and using your guest bag.';}
  await MarketCommerce.initialise();showSession();
  if(MarketCommerce.signedIn()){
   try{const result=await MarketCommerce.connectGuest();if(result.skipped_items?.length)message('Some guest bag items are unavailable and could not be added.');}catch(e){message(e.message);}
   await Promise.all([refreshBag(),refreshRequests()]);
  }
 }catch(e){showSession();message(e.message);}
})();
