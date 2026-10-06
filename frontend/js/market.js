function money(value){return '₦'+Number(value||0).toLocaleString('en-NG',{maximumFractionDigits:2});}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function imageUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
const categories=['All products','Solar & Power','Home Appliances','Phones & Computing','Business Equipment','Other'];
let publicListings=[],selectedCategory='All products',rhythm='monthly';
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
 document.getElementById('categoryFilters').innerHTML=categories.map(category=>`<button type="button" data-category="${escapeHtml(category)}" class="${category===selectedCategory?'selected':''}" aria-pressed="${category===selectedCategory}">${escapeHtml(category)}</button>`).join('');
 document.querySelectorAll('[data-category]').forEach(button=>button.addEventListener('click',()=>{selectedCategory=button.dataset.category;renderCategories();renderMarket();}));
}
function renderMarket(){
 const query=document.getElementById('marketSearch').value.trim().toLowerCase();
 const sort=document.getElementById('marketSort').value;
 const rows=publicListings.filter(item=>(selectedCategory==='All products'||productCategory(item)===selectedCategory)&&`${item.title} ${item.category} ${item.description||''}`.toLowerCase().includes(query));
 if(sort==='price-low')rows.sort((a,b)=>Number(a.price)-Number(b.price));
 if(sort==='price-high')rows.sort((a,b)=>Number(b.price)-Number(a.price));
 document.getElementById('listingCount').textContent=`${rows.length} product${rows.length===1?'':'s'}`;
 const grid=document.getElementById('listingGrid');
 grid.innerHTML=rows.length?rows.map(item=>`<article class="listing">${productMedia(item)}<div class="product-body"><span class="category">${escapeHtml(item.category||'Other')}</span><h3>${escapeHtml(item.title)}</h3><span class="seller-marker">✓ Active member seller</span><span class="full-price-label">Full product price</span><div class="price">${money(item.price)}</div><p class="product-estimate">Estimate <b>${money(Math.ceil(Number(item.price)*100/4)/100)}/month</b><br>4 payments · Terms to be confirmed</p><button class="text-button" type="button" data-product="${Number(item.id)}">View product →</button></div></article>`).join('')
 : `<div class="empty-catalog"><h3>${query||selectedCategory!=='All products'?'No products match this selection':'Our member store is getting ready'}</h3><p>${query||selectedCategory!=='All products'?'Try a different category or search.':'Approved member products will appear here. Explore the payment planner while our sellers prepare their listings.'}</p><a href="#plan">Explore the payment planner →</a></div>`;
 grid.setAttribute('aria-busy','false');bindImageFallback(grid);
 grid.querySelectorAll('[data-product]').forEach(button=>button.addEventListener('click',()=>openProduct(Number(button.dataset.product))));
}
async function loadMarket(){
 const alert=document.getElementById('marketAlert');alert.textContent='';
 document.getElementById('listingGrid').setAttribute('aria-busy','true');
 try{publicListings=await OBIT.get('/api/market/listings');renderMarket();}
 catch(error){document.getElementById('listingGrid').innerHTML='';document.getElementById('listingGrid').setAttribute('aria-busy','false');document.getElementById('listingCount').textContent='';alert.textContent='Products could not be loaded. Please refresh to try again.';}
}
function openProduct(id){
 const item=publicListings.find(product=>Number(product.id)===id);if(!item)return;
 const detail=document.getElementById('productDetails');
 detail.innerHTML=`<div class="product-detail-grid">${productMedia(item)}<div><span class="eyebrow">${escapeHtml(item.category)}</span><h2 id="productTitle">${escapeHtml(item.title)}</h2><span class="seller-marker">✓ Active cooperative member seller</span><div class="detail-price">${money(item.price)}</div><p>${escapeHtml(item.description||'The seller has not added further product details.')}</p><div class="detail-actions"><button class="btn" id="estimateProduct" type="button">Estimate a payment plan →</button><div class="detail-notice">Checkout is not yet available. Final payment, delivery and eligibility terms will be confirmed before purchase.</div></div></div></div>`;
 const dialog=document.getElementById('productDialog');dialog.setAttribute('aria-labelledby','productTitle');bindImageFallback(detail);dialog.showModal();
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
  document.getElementById('myListings').innerHTML=rows.length?rows.map(item=>`<article class="listing"><span class="category">${escapeHtml(item.category)}</span><h3>${escapeHtml(item.title)}</h3><div class="price">${money(item.price)}</div><span class="status-badge ${item.status==='ACTIVE'?'ok':'pending'}">${item.status==='DRAFT'?'Under review':escapeHtml(item.status)}</span></article>`).join(''):'<p class="muted-note">You have not submitted any products.</p>';
 }catch(error){document.getElementById('sellerAlert').textContent=error.message;}
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
renderCategories();updatePlan();loadMarket();loadSeller();
