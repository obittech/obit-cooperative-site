function money(value){return '₦'+Number(value||0).toLocaleString('en-NG',{maximumFractionDigits:2});}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function imageUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
const categories=['All products','Solar & Power','Home Appliances','Phones & Computing','Business Equipment','Other'];
let publicListings=[],selectedCategory='All products',rhythm='monthly',savedView=new URLSearchParams(location.search).get('saved')==='1',catalogLoaded=false;
let promotionsOnly=false,officialOnly=false,storeVersion=0;
let catalogPage=1,catalogPages=0,catalogTotal=0,catalogShops=[],catalogTimer,catalogSequence=0,bagSequence=0;
let cartQueue=Promise.resolve(),buyerReady=Promise.resolve();
const CART_KEY='obit_market_bag_v1',SAVED_KEY='obit_market_saved_v1';
function stored(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
let cart=ObitMarketState.normalize(stored(CART_KEY,[]));
let saved=Array.isArray(stored(SAVED_KEY,[]))?stored(SAVED_KEY,[]).filter(x=>Number.isSafeInteger(x)&&x>0).slice(0,100):[];
function persist(){try{if(!MarketCommerce.signedIn())localStorage.setItem(CART_KEY,JSON.stringify(cart));localStorage.setItem(SAVED_KEY,JSON.stringify(saved));}catch{toast('Your browser could not save these selections.');}updateBadges();}
function toast(message){const el=document.getElementById('marketToast');el.textContent=message;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.hidden=true},4000);}
function updateBadges(){document.getElementById('cartCount').textContent=cart.reduce((n,r)=>n+r.qty,0);document.getElementById('savedCount').textContent=saved.length;document.getElementById('wishlistButton').setAttribute('aria-pressed',String(savedView));const count=cart.reduce((n,r)=>n+r.qty,0),badge=document.getElementById('mobileCartCount');if(badge){badge.textContent=count;badge.hidden=count===0;}document.getElementById('mobileSaved')?.setAttribute('aria-pressed',String(savedView));document.getElementById('mobileShopLink')?.setAttribute('aria-current',savedView?'false':'page');}
function changeBag(id,quantity){
 const task=cartQueue.catch(()=>{}).then(async()=>{
  await buyerReady;
  const qty=typeof quantity==='function'?quantity(cart.find(r=>r.id===id)?.qty||0):quantity;
  const next=ObitMarketState.setQuantity(cart,id,qty);
  if(MarketCommerce.signedIn()){
   const actor=MarketCommerce.profile().buyer.id,result=await MarketCommerce.change(id,qty);
   if(MarketCommerce.profile()?.buyer.id!==actor)return;
   cart=ObitMarketState.normalize(result.items);
  }else cart=next;
  persist();if(document.getElementById('cartDialog').open)await renderCart();
 });cartQueue=task;return task;
}
function addToCart(id){
 const p=publicListings.find(p=>Number(p.id)===id);if(!p){toast('This product is no longer available. Refresh the catalogue.');return;}
 if(p.stock_quantity===0){toast('This product is out of stock.');return;}
 changeBag(id,q=>q+1).then(()=>toast('Added to your shopping bag.')).catch(e=>toast(e.message));
}
function toggleSaved(id){saved=saved.includes(id)?saved.filter(x=>x!==id):[...saved,id].slice(0,100);persist();renderMarket();}
function showBag(){renderCart();document.getElementById('cartDialog').showModal();}
async function renderCart(){
 const sequence=++bagSequence;document.getElementById('cartSummary').textContent='Checking prices and availability…';
 try{
  const result=MarketCommerce.signedIn()?await MarketCommerce.cart():await MarketCommerce.preview(cart);
  if(sequence!==bagSequence)return;
  if(MarketCommerce.signedIn()){cart=ObitMarketState.normalize(result.items);persist();}
  document.getElementById('bagStorageNote').textContent=MarketCommerce.signedIn()?'Saved to your shopping account. Prices and availability are checked with the server.':'Saved in this browser. Sign in to keep your bag across devices. Prices and availability are checked with the server.';
  document.getElementById('cartLines').innerHTML=result.lines.length?result.lines.map(line=>{const p=line.product;return `<article class="bag-line"><div><h3>${escapeHtml(p?.title||'Unavailable listing #'+line.id)}</h3><p>${line.available?money(p.price)+' each':p?'Requested quantity is unavailable.':'This listing is not currently available.'}</p><small>${escapeHtml(p?.seller_name||'')}</small></div><label>Quantity<input type="number" min="1" max="99" step="1" data-cart-qty="${line.id}" value="${line.qty}"></label><strong>${line.available?money(line.subtotal_kobo/100):'Unavailable'}</strong><button type="button" data-cart-remove="${line.id}" aria-label="Remove ${escapeHtml(p?.title||'unavailable listing')}">Remove</button></article>`}).join(''):'<div class="empty-catalog"><h3>Your bag is waiting for your next find.</h3><p>Explore member products and add what you like.</p></div>';
  document.getElementById('cartSummary').innerHTML=`<div class="bag-total"><span>Available products subtotal (${result.count} ${result.count===1?'item':'items'})</span><strong>${money(result.total_kobo/100)}</strong></div><p>Delivery is quoted separately. Unavailable products are excluded. Adding an item does not reserve stock.</p>`;
  document.querySelectorAll('[data-cart-qty]').forEach(input=>input.addEventListener('change',()=>changeBag(Number(input.dataset.cartQty),Number(input.value)).catch(e=>{toast(e.message);renderCart();})));
  document.querySelectorAll('[data-cart-remove]').forEach(btn=>btn.addEventListener('click',()=>changeBag(Number(btn.dataset.cartRemove),0).catch(e=>toast(e.message))));
 }catch(e){if(sequence!==bagSequence)return;document.getElementById('cartLines').textContent='Your selections are saved. We could not check their current prices.';document.getElementById('cartSummary').textContent=e.message;}
}
function renderSellers(){const select=document.getElementById('sellerFilter'),value=select.value;select.innerHTML='<option value="">All member shops</option>'+catalogShops.map(s=>`<option value="${Number(s.id)}">${escapeHtml(s.name)}</option>`).join('');if(catalogShops.some(s=>String(s.id)===value))select.value=value;renderStoreDirectory();}

function productCategory(item){
 const text=String(item.category||'').toLowerCase();
 if(/solar|power|energy|inverter|battery/.test(text))return 'Solar & Power';
 if(/phone|comput|laptop|tablet|gadget/.test(text))return 'Phones & Computing';
 if(/appliance|kitchen|home|freezer|fridge|washing|cooling/.test(text))return 'Home Appliances';
 if(/business|equipment|tool|machine/.test(text))return 'Business Equipment';
 return 'Other';
}
function productArt(category){
 const drawings={
  'Solar & Power':'<rect x="20" y="8" width="119" height="115" rx="4" fill="#264c5b" stroke="#bdcfca" stroke-width="6"/><path d="M58 8v115M100 8v115M20 45h119M20 85h119" stroke="#81a1aa" stroke-width="2"/>',
  'Home Appliances':'<rect x="18" y="39" width="124" height="83" rx="6" fill="#dae5df" stroke="#8ca39b" stroke-width="2"/><rect x="15" y="31" width="130" height="15" rx="4" fill="#fbfdfb" stroke="#8ca39b"/><rect x="61" y="34" width="33" height="5" rx="2" fill="#92a59a"/><path d="M107 95h22M107 102h22M107 109h22" stroke="#8ca39b" stroke-width="2"/><rect x="28" y="100" width="12" height="12" rx="2" fill="#34684f"/>',
  'Phones & Computing':'<rect x="45" y="8" width="69" height="118" rx="10" fill="#1d3d38"/><rect x="50" y="13" width="59" height="108" rx="7" fill="#cfe5d1"/><path d="M50 79Q74 43 109 64v57H50Z" fill="#539578"/><path d="M50 105Q76 77 109 92v29H50Z" fill="#236148"/><rect x="68" y="16" width="23" height="4" rx="2" fill="#1d3d38"/>',
  'Business Equipment':'<rect x="22" y="43" width="116" height="76" rx="6" fill="#d5e2d8" stroke="#6e9081" stroke-width="3"/><path d="M61 43V28h38v15" fill="none" stroke="#6e9081" stroke-width="5"/><path d="M22 72h116" stroke="#6e9081" stroke-width="2"/><rect x="68" y="66" width="24" height="14" rx="3" fill="#377556"/>',
  'Other':'<path d="M22 41L80 18l58 23v65L80 130l-58-24Z" fill="#dfc9a6" stroke="#b49a72" stroke-width="2"/><path d="M22 41l58 24 58-24M80 65v65M51 30l59 24v25" fill="none" stroke="#b49a72" stroke-width="3"/>'
 };
 return `<svg viewBox="0 0 160 145" aria-hidden="true">${drawings[category]||drawings.Other}</svg>`;
}
function productMedia(item){
 const src=imageUrl(item.image_url);
 return `<div class="product-media"><div class="product-media product-placeholder">${productArt(productCategory(item))}<small>Product photo unavailable</small></div>${src?`<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title)}" loading="lazy" referrerpolicy="no-referrer">`:''}</div>`;
}
function bindImageFallback(root){root.querySelectorAll('.product-media img').forEach(img=>img.addEventListener('error',()=>img.remove(),{once:true}));}
function renderCategories(){
 const mobileCategory=document.getElementById('mobileCategoryFilter');if(mobileCategory?.options.length)mobileCategory.value=selectedCategory;
 document.getElementById('categoryFilters').innerHTML=categories.map(category=>`<button type="button" data-category="${escapeHtml(category)}" class="${category===selectedCategory?'selected':''}" aria-pressed="${category===selectedCategory}">${escapeHtml(category)}</button>`).join('');
 document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{selectedCategory=button.dataset.category;renderCategories();renderMarket();}));
}
function renderMarket(){catalogPage=1;clearTimeout(catalogTimer);catalogSequence++;catalogTimer=setTimeout(loadMarket,250);}
function paintMarket(rows){
 document.getElementById('catalogTitle').textContent=savedView?'Your saved products':selectedCategory==='All products'?'Explore member products':selectedCategory;
 document.getElementById('listingCount').textContent=`${catalogTotal} product${catalogTotal===1?'':'s'}`;
 document.getElementById('catalogPageLabel').textContent=catalogPages?`Page ${catalogPage} of ${catalogPages}`:'No matching products';
 document.getElementById('catalogPrevious').disabled=catalogPage<=1;
 document.getElementById('catalogNext').disabled=catalogPage>=catalogPages;
 const grid=document.getElementById('listingGrid');
 grid.innerHTML=rows.length?rows.map(item=>`<article class="listing">${productMedia(item)}<div class="product-body"><span class="category">${escapeHtml(item.category||'Other')}</span><h3>${escapeHtml(item.title)}</h3><button class="seller-marker shop-link" type="button" data-seller="${Number(item.seller_id)||0}">✓ ${escapeHtml(item.seller_name||'Active member seller')}</button><span class="stock-label ${item.stock_quantity===0?'out':''}">${item.stock_quantity===null?'Stock to be confirmed':item.stock_quantity===0?'Out of stock':'In stock'}</span>${item.promotion?`<span class="promotion-label">${escapeHtml(item.promotion.label)}</span>`:''}${item.official_store?'<span class="official-label">Official store</span>':''}<span class="full-price-label">Full product price</span><div class="price">${money(item.price)}</div><p class="product-estimate">Estimate <b>${money(Math.ceil(Number(item.price)*100/4)/100)}/month</b><br>4 payments · Terms to be confirmed</p><div class="product-actions"><button class="add-bag" type="button" ${item.stock_quantity===0?'disabled':''} data-add="${Number(item.id)}">Add to bag</button><button type="button" class="save-product" data-save="${Number(item.id)}" aria-pressed="${saved.includes(Number(item.id))}" aria-label="${saved.includes(Number(item.id))?'Unsave':'Save'} ${escapeHtml(item.title)}">${saved.includes(Number(item.id))?'♥':'♡'}</button></div><button class="text-button" type="button" data-product="${Number(item.id)}">View product →</button></div></article>`).join('')
 : `<div class="empty-catalog"><h3>${catalogTotal===0&&document.getElementById('marketSearch').value?'No products match this selection':savedView?'No saved products in this selection':'No products in this selection'}</h3><p>Try another category, seller or search. Approved member products appear here when available.</p><a href="#plan">Explore the payment planner →</a></div>`;
 grid.setAttribute('aria-busy','false');bindImageFallback(grid);
 grid.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>addToCart(Number(button.dataset.add))));
 grid.querySelectorAll('[data-save]').forEach(button=>button.addEventListener('click',()=>toggleSaved(Number(button.dataset.save))));
 grid.querySelectorAll('[data-seller]').forEach(button=>button.addEventListener('click',()=>{if(!Number(button.dataset.seller))return;document.getElementById('sellerFilter').value=button.dataset.seller;renderMarket();}));
 grid.querySelectorAll('[data-product]').forEach(button=>button.addEventListener('click',()=>openProduct(Number(button.dataset.product))));
}
async function loadMarket(){
 clearTimeout(catalogTimer);const sequence=++catalogSequence;
 const alert=document.getElementById('marketAlert');alert.textContent='';
 document.getElementById('listingGrid').setAttribute('aria-busy','true');
 try{
  const minRaw=document.getElementById('priceMin').value,maxRaw=document.getElementById('priceMax').value;
  const min=minRaw===''?0:Number(minRaw),max=maxRaw===''?3000000:Number(maxRaw);
  if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min||max>3000000)throw Error('Enter a valid price range up to ₦3,000,000.');
  document.getElementById('filterError').textContent='';
  const params=new URLSearchParams({page:String(catalogPage),page_size:'24',q:document.getElementById('marketSearch').value.trim(),category:selectedCategory,sort:document.getElementById('marketSort').value,seller:document.getElementById('sellerFilter').value,min_kobo:String(Math.round(min*100)),max_kobo:String(Math.round(max*100))});
  if(savedView)params.set('ids',saved.join(','));
  if(promotionsOnly)params.set('promotions','1');if(officialOnly)params.set('official','1');
  const result=await OBIT.get('/api/market/catalog?'+params);if(sequence!==catalogSequence)return;
  publicListings=result.items;catalogLoaded=true;catalogPages=result.pages;catalogTotal=result.total;catalogShops=result.shops;renderSellers();paintMarket(publicListings);
  if(document.getElementById('cartDialog').open)renderCart();
 }catch(error){if(sequence!==catalogSequence)return;catalogLoaded=false;publicListings=[];document.getElementById('listingGrid').innerHTML='';document.getElementById('listingGrid').setAttribute('aria-busy','false');document.getElementById('listingCount').textContent='';alert.textContent=error.message;document.getElementById('catalogPrevious').disabled=true;document.getElementById('catalogNext').disabled=true;document.getElementById('catalogPageLabel').textContent='Catalogue unavailable';}
}

function openProduct(id){
 const item=publicListings.find(product=>Number(product.id)===id);if(!item)return;
 const detail=document.getElementById('productDetails');
 detail.innerHTML=`<div class="product-detail-grid">${productMedia(item)}<div><span class="eyebrow">${escapeHtml(item.category)}</span><h2 id="productTitle">${escapeHtml(item.title)}</h2><span class="seller-marker">✓ ${escapeHtml(item.seller_name||'Active cooperative member seller')}</span>${item.official_store?'<p class="official-label">Official store</p>':''}<div class="detail-price">${money(item.price)}</div>${item.promotion?`<p class="promotion-label">${escapeHtml(item.promotion.label)} · Ends ${escapeHtml(new Date(item.promotion.ends_ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'}))} (Nigeria time)</p>`:''}<p>${escapeHtml(item.description||'The seller has not added further product details.')}</p><div class="detail-actions"><button class="btn" id="detailAddBag" type="button">Add to bag</button><button class="btn btn-secondary" id="estimateProduct" type="button">Estimate a payment plan →</button><div class="detail-notice">Checkout is not yet available. Final payment, delivery and eligibility terms will be confirmed before purchase.</div></div></div></div>`;
 const dialog=document.getElementById('productDialog');dialog.setAttribute('aria-labelledby','productTitle');bindImageFallback(detail);dialog.showModal();
 document.getElementById('detailAddBag').addEventListener('click',()=>{addToCart(id);dialog.close();showBag();});
 document.getElementById('estimateProduct').addEventListener('click',()=>{document.getElementById('planAmount').value=item.price;updatePlan();dialog.close();document.getElementById('plan').scrollIntoView({block:'start'});document.getElementById('planAmount').focus({preventScroll:true});});
}
function updatePlan(){
 const raw=document.getElementById('planAmount').value;
 const count=Number(document.getElementById('planLength').value);
 const amount=Number(raw),valid=/^\d+(\.\d{1,2})?$/.test(raw)&&amount>=20000&&amount<=3000000;
 document.getElementById('planError').textContent=valid?'':'Enter a price from ₦20,000 to ₦3,000,000 with up to two decimal places.';
 document.getElementById('planPayment').textContent=valid?money(Math.ceil(Math.round(amount*100)/count)/100):'—';
 document.getElementById('planFrequency').textContent=`per ${rhythm==='weekly'?'week':'month'} for ${count} payments`;
 document.getElementById('planTotal').textContent=valid?money(amount):'—';
 const last=valid?(Math.round(amount*100)-Math.ceil(Math.round(amount*100)/count)*(count-1))/100:0;
 const first=valid?Math.ceil(Math.round(amount*100)/count)/100:0;
 document.getElementById('planSchedule').textContent=`${count} ${rhythm} payments${valid&&last!==first?`, last ${money(last)}`:''}`;
}
document.querySelectorAll('[data-rhythm]').forEach(button=>button.addEventListener('click',()=>{
 rhythm=button.dataset.rhythm;
 document.querySelectorAll('[data-rhythm]').forEach(item=>{item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));});
 document.getElementById('planLength').innerHTML=(rhythm==='weekly'?[4,8,10,16,24]:[2,4,6,12]).map(count=>`<option value="${count}"${count===(rhythm==='weekly'?10:4)?' selected':''}>${count} ${rhythm==='weekly'?'weeks':'months'}</option>`).join('');updatePlan();
}));
async function loadSeller(){
 const token=OBIT.getSession('member');if(!token)return;
 try{
  const membership=await OBIT.get('/api/me/membership',{token});if(membership.status!=='ACTIVE')return;
  document.getElementById('sellerPanel').hidden=false;
  const rows=await OBIT.get('/api/market/my-listings',{token});
  document.getElementById('myListings').innerHTML=rows.length?rows.map(item=>`<article class="listing"><div class="product-body"><span class="category">${escapeHtml(item.category)}</span><h3>${escapeHtml(item.title)}</h3><div class="price">${money(item.price)}</div><span class="status-badge ${item.status==='ACTIVE'?'ok':'pending'}">${item.status==='DRAFT'?'Under review':escapeHtml(item.status)}</span><p class="fine-print">${item.stock_quantity===null?'Stock has not been confirmed.':Number(item.stock_quantity)+' on hand · '+Number(item.reserved_quantity||0)+' reserved · '+Math.max(0,Number(item.stock_quantity)-Number(item.reserved_quantity||0))+' available'}</p><form class="seller-stock-form" data-stock="${Number(item.id)}" data-version="${Number(item.stock_version)}"><label>Stock on hand<input name="quantity" type="number" min="0" max="1000000" step="1" required value="${item.stock_quantity===null?'':Number(item.stock_quantity)}"></label><button class="btn" type="submit">Save stock</button><p role="status"></p></form></div></article>`).join(''):'<p class="muted-note">You have not submitted any products.</p>';
  document.querySelectorAll('[data-stock]').forEach(form=>form.addEventListener('submit',async event=>{
   event.preventDefault();const button=form.querySelector('button');button.disabled=true;
   try{const result=await OBIT.patch(`/api/market/seller/listings/${Number(form.dataset.stock)}/inventory`,{quantity:Number(form.elements.quantity.value),version:Number(form.dataset.version)},{token});form.dataset.version=String(result.version);form.querySelector('p').textContent='Stock saved.';form.closest('article').querySelector('.fine-print').textContent=result.quantity+' units on hand. Refresh for current reservations.';loadMarket();}
   catch(e){form.querySelector('p').textContent=e.message;}finally{button.disabled=false;}
  }));
  await loadSellerRequests(token);await loadStoreProfile(token);await loadSellerOrders(token);
 }catch(error){document.getElementById('sellerAlert').textContent=error.message;}
}
async function loadSellerRequests(token){
 const requests=await OBIT.get('/api/market/seller/requests',{token});
 document.getElementById('sellerRequests').innerHTML=requests.length?requests.map(r=>`<article class="quote-card"><h3>${escapeHtml(r.reference)}</h3><span class="status-badge">${escapeHtml(r.status)}</span><p>Deliver to ${escapeHtml(r.destination.city)}, ${escapeHtml(r.destination.state)}</p><ul>${r.items.map(i=>`<li>${escapeHtml(i.title)} × ${Number(i.quantity)} — ${money(Number(i.unit_kobo)*Number(i.quantity)/100)}</li>`).join('')}</ul>${r.status==='REQUESTED'?`<form data-shop-request="${Number(r.id)}"><label>Delivery fee (₦)<input name="delivery" required type="number" min="0" max="1000000" step="0.01"></label><label>Estimated delivery days<input name="days" required type="number" min="1" max="90" step="1"></label><label>Note for buyer<textarea name="note" rows="2" maxlength="500" placeholder="Availability, delivery or product details"></textarea></label><p class="fine-print">Confirm availability before quoting. This does not create a paid order or reserve stock.</p><button class="btn" type="submit">Send quote</button><button class="text-button" type="button" data-decline>Decline request</button><p role="status"></p></form>`:`${r.status==='QUOTED'?`<p>Delivery ${money(Number(r.delivery_kobo)/100)} · ${Number(r.delivery_days)} days</p>`:''}<p class="quote-note">${escapeHtml(r.seller_note)}</p>`}</article>`).join(''):'<p class="muted-note">No buyer requests yet.</p>';
 document.querySelectorAll('[data-shop-request]').forEach(form=>{
  async function respond(decision){
   const buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
   try{await OBIT.post(`/api/market/seller/requests/${Number(form.dataset.shopRequest)}/respond`,{decision,delivery_kobo:Math.round(Number(form.elements.delivery.value)*100),delivery_days:Number(form.elements.days.value),note:form.elements.note.value.trim()},{token});await loadSellerRequests(token);}
   catch(e){form.querySelector('[role="status"]').textContent=e.message;buttons.forEach(b=>b.disabled=false);}
  }
  form.addEventListener('submit',e=>{e.preventDefault();respond('QUOTED');});
  form.querySelector('[data-decline]').addEventListener('click',()=>respond('DECLINED'));
 });
}
document.getElementById('sellerForm').addEventListener('submit',async(event)=>{
 event.preventDefault();const button=document.getElementById('btnSubmitListing'),alert=document.getElementById('sellerAlert');if(button.disabled)return;
 const title=document.getElementById('listingTitle').value.trim(),category=document.getElementById('listingCategory').value;
 const description=document.getElementById('listingDescription').value.trim(),price=document.getElementById('listingPrice').value;
 const photo=document.getElementById('listingImage').value.trim();
 if(photo&&!imageUrl(photo)){alert.textContent='Use a valid HTTPS link for the product photo.';return;}
 button.disabled=true;button.textContent='Submitting';alert.textContent='';
 try{
  await OBIT.post('/api/market/listings',{title,category,description,price,image_url:photo||null},{token:OBIT.getSession('member')});
  alert.textContent='Product submitted for review. It will appear in the store after approval.';event.target.reset();await loadSeller();
 }catch(error){alert.textContent=error.message;}finally{button.disabled=false;button.textContent='Submit for review';}
});
document.getElementById('marketSearch').addEventListener('input',renderMarket);
document.getElementById('marketSort').addEventListener('change',renderMarket);
document.getElementById('planAmount').addEventListener('input',updatePlan);
document.getElementById('planLength').addEventListener('change',updatePlan);
document.getElementById('closeProduct').addEventListener('click',()=>document.getElementById('productDialog').close());
document.getElementById('btnRefresh').addEventListener('click',()=>{loadMarket();loadSeller();});
document.getElementById('globalSearch').addEventListener('submit',event=>{event.preventDefault();renderMarket();document.getElementById('shop').scrollIntoView({block:'start'});});
for(const id of ['priceMin','priceMax'])document.getElementById(id).addEventListener('input',renderMarket);
document.getElementById('sellerFilter').addEventListener('change',renderMarket);
document.getElementById('wishlistButton').addEventListener('click',()=>{savedView=!savedView;updateBadges();renderMarket();document.getElementById('shop').scrollIntoView({block:'start'});});
for(const id of ['cartButton','mobileCart'])document.getElementById(id).addEventListener('click',showBag);
document.getElementById('refreshCart').addEventListener('click',renderCart);
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>document.getElementById(b.dataset.close).close()));
document.getElementById('bulkButton').addEventListener('click',()=>document.getElementById('bulkDialog').showModal());
document.getElementById('bulkForm').addEventListener('submit',event=>{event.preventDefault();const f=new FormData(event.target);const q=Number(f.get('quantity'));if(!Number.isInteger(q)||q<1||q>100000)return;const text=['OBIT MARKET · BULK ENQUIRY DRAFT','Not an order or confirmed quotation.','Product: '+f.get('product'),'Quantity: '+q,'Delivery location: '+f.get('location'),'Requirements: '+f.get('notes'),'Prepared: '+new Date().toISOString(),'Contact: admin@obitcooperative.com'].join('\n');document.getElementById('bulkDraftWrap').hidden=false;document.getElementById('bulkDraft').value=text;const url=URL.createObjectURL(new Blob([text],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='Obit_Market_Enquiry.txt';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);document.getElementById('bulkStatus').textContent='Draft prepared below and download requested. You can copy the text if your browser blocks the download. No message was sent.';});
document.getElementById('categoryShowcase').innerHTML=categories.slice(1).map(c=>`<button type="button" data-showcase="${escapeHtml(c)}">${productArt(c)}<b>${escapeHtml(c)}</b><span>Explore category →</span></button>`).join('');
function chooseCategory(c){savedView=false;selectedCategory=c;renderCategories();updateBadges();renderMarket();document.getElementById('shop').scrollIntoView({block:'start'});}
document.querySelectorAll('[data-showcase]').forEach(b=>b.addEventListener('click',()=>chooseCategory(b.dataset.showcase)));
document.querySelectorAll('[data-quick-category]').forEach(b=>b.addEventListener('click',()=>chooseCategory(b.dataset.quickCategory)));
const initialSeller=new URLSearchParams(location.search).get('seller');if(initialSeller&&/^[1-9]\d*$/.test(initialSeller)){const option=new Option('Selected store',initialSeller);document.getElementById('sellerFilter').add(option);document.getElementById('sellerFilter').value=initialSeller;}
renderCategories();updatePlan();updateBadges();loadMarket();loadSeller();

document.getElementById('catalogPrevious').addEventListener('click',()=>{if(catalogPage>1){catalogPage--;loadMarket();document.getElementById('shop').scrollIntoView({block:'start'});}});
document.getElementById('catalogNext').addEventListener('click',()=>{if(catalogPage<catalogPages){catalogPage++;loadMarket();document.getElementById('shop').scrollIntoView({block:'start'});}});
document.addEventListener('market:signout',()=>{cart=MarketCommerce.guest();updateBadges();document.getElementById('shoppingAccountLink').textContent='Account';if(document.getElementById('cartDialog').open)renderCart();});
buyerReady=(async()=>{try{const p=await MarketCommerce.initialise();if(p){const result=await MarketCommerce.connectGuest();cart=ObitMarketState.normalize(result.items);updateBadges();document.getElementById('shoppingAccountLink').textContent='My shopping account';if(result.skipped_items?.length)toast('Some guest bag items are unavailable and could not be added.');}}catch(e){toast(e.message);}})();

function renderStoreDirectory(){
 const directory=document.getElementById('storeDirectory');
 directory.innerHTML=catalogShops.length?catalogShops.map(s=>`<a class="store-card" href="market.html?seller=${s.id}#shop" data-store="${s.id}"><span class="store-avatar" aria-hidden="true">${escapeHtml(s.name.slice(0,1).toUpperCase())}</span><strong>${escapeHtml(s.name)}</strong>${s.official?'<span class="official-label">Official store</span>':'<span>Member shop</span>'}</a>`).join(''):'<p class="muted-note">Stores appear here when member sellers have approved products available.</p>';
 directory.querySelectorAll('[data-store]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();selectStore(a.dataset.store);}));
 const selected=catalogShops.find(s=>String(s.id)===document.getElementById('sellerFilter').value),target=document.getElementById('selectedStore');
 target.hidden=!selected;if(selected)target.innerHTML=`<h3>${escapeHtml(selected.name)}</h3>${selected.official?'<span class="official-label">Official store</span>':''}<p>${escapeHtml(selected.description)}</p><a href="market.html?seller=${selected.id}#shop">Link to this store</a>`;
 document.getElementById('promotionFilter').setAttribute('aria-pressed',String(promotionsOnly));document.getElementById('officialFilter').setAttribute('aria-pressed',String(officialOnly));
}
function selectStore(id){document.getElementById('sellerFilter').value=id;renderMarket();document.getElementById('shop').scrollIntoView({block:'start'});}
for(const [id,key]of [['promotionFilter','promotions'],['officialFilter','official']])document.getElementById(id).addEventListener('click',()=>{if(key==='promotions')promotionsOnly=!promotionsOnly;else officialOnly=!officialOnly;document.getElementById(id).setAttribute('aria-pressed',String(key==='promotions'?promotionsOnly:officialOnly));renderMarket();});
document.getElementById('clearCollection').addEventListener('click',()=>{promotionsOnly=false;officialOnly=false;savedView=false;selectedCategory='All products';document.getElementById('sellerFilter').value='';document.getElementById('marketSearch').value='';document.getElementById('priceMin').value='';document.getElementById('priceMax').value='';document.getElementById('marketSort').value='newest';renderCategories();updateBadges();renderMarket();});
async function loadStoreProfile(token){const store=await OBIT.get('/api/market/seller/store',{token});storeVersion=store?.version||0;const form=document.getElementById('storeProfileForm');form.elements.storeName.value=store?.name||'';form.elements.storeDescription.value=store?.description||'';document.getElementById('storeProfileStatus').textContent=store?'Review status: '+store.status+(store.official?' · Official store':''):'';}
document.getElementById('storeProfileForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.target,button=form.querySelector('button'),status=document.getElementById('storeProfileStatus');button.disabled=true;try{await OBIT.post('/api/market/seller/store',{name:form.elements.storeName.value,description:form.elements.storeDescription.value,version:storeVersion},{token:OBIT.getSession('member')});await loadStoreProfile(OBIT.getSession('member'));loadMarket();}catch(err){status.textContent=err.message;}finally{button.disabled=false;}});

async function loadSellerOrders(token){
 const rows=await OBIT.get('/api/market/seller/orders',{token}),target=document.getElementById('sellerOrders');
 target.innerHTML=rows.length?rows.map(o=>`<article class="quote-card"><h3>${escapeHtml(o.reference)}</h3><span class="status-badge">${escapeHtml(o.status.replaceAll('_',' '))}</span><p>${escapeHtml(o.destination.city)}, ${escapeHtml(o.destination.state)}</p><ul>${o.items.map(i=>`<li>${escapeHtml(i.title)} × ${i.quantity}</li>`).join('')}</ul><p>Total ${money(o.total_kobo/100)} · Unpaid</p>${o.status==='AWAITING_PAYMENT'?`<p>Stock held until ${escapeHtml(new Date(o.expires_ms).toLocaleTimeString('en-NG',{timeZone:'Africa/Lagos'}))} (Nigeria time). Do not dispatch.</p><form data-cancel-seller-order="${o.id}"><label>Reason for cancelling<input name="reason" required minlength="3" maxlength="300" placeholder="For example, unable to supply"></label><button class="btn" type="submit">Cancel unpaid order</button><p role="status"></p></form>`:`<p>${escapeHtml(o.cancel_reason||'Stock reservation expired.')}</p>`}</article>`).join(''):'<p class="muted-note">No purchase orders yet.</p>';
 target.querySelectorAll('[data-cancel-seller-order]').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await OBIT.post(`/api/market/seller/orders/${form.dataset.cancelSellerOrder}/cancel`,{reason:form.elements.reason.value},{token});await loadSeller();loadMarket();}catch(err){form.querySelector('[role=status]').textContent=err.message;button.disabled=false;}}));
}
document.getElementById('refreshSellerOrders').addEventListener('click',()=>{loadSeller();loadMarket();});
