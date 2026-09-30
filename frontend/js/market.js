function money(n){return '₦'+Number(n||0).toLocaleString('en-NG',{maximumFractionDigits:2});}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let publicListings=[];
function renderMarket(){
 const query=document.getElementById('marketSearch').value.trim().toLocaleLowerCase();
 const rows=publicListings.filter(x=>`${x.title} ${x.category} ${x.description||''}`.toLocaleLowerCase().includes(query));
 document.getElementById('listingGrid').innerHTML=rows.length
  ? rows.map(x=>`<article class="listing"><span class="category">${escapeHtml(x.category||'Other')}</span><h3>${escapeHtml(x.title)}</h3><p>${escapeHtml(x.description||'Member marketplace listing.')}</p><div class="price">${money(x.price)}</div><span class="status-badge ok">Active member seller</span></article>`).join('')
  : `<div class="card"><h3>${query?'No matching listings':'Marketplace pilot ready'}</h3><p class="muted-note">${query?'Try another search.':'Approved member listings will appear here as the pilot opens.'}</p></div>`;
}
async function loadMarket(){
 const alert=document.getElementById('marketAlert');
 alert.textContent='';
 try{publicListings=await OBIT.get('/api/market/listings');renderMarket();}
 catch(e){document.getElementById('listingGrid').innerHTML='';alert.textContent=e.message;}
}
async function loadSeller(){
 const token=OBIT.getSession('member');
 if(!token)return;
 try{
  const membership=await OBIT.get('/api/me/membership',{token});
  if(membership.status!=='ACTIVE')return;
  document.getElementById('sellerPanel').style.display='';
  const rows=await OBIT.get('/api/market/my-listings',{token});
  document.getElementById('myListings').innerHTML=rows.length?rows.map(x=>
   `<article class="listing"><span class="category">${escapeHtml(x.category)}</span><h3>${escapeHtml(x.title)}</h3><p>${escapeHtml(x.description||'No description')}</p><div class="price">${money(x.price)}</div><span class="status-badge ${x.status==='ACTIVE'?'ok':'pending'}">${x.status==='DRAFT'?'Under review':escapeHtml(x.status)}</span></article>`
  ).join(''):'<p class="muted-note">You have not submitted any listings.</p>';
 }catch(e){document.getElementById('sellerAlert').textContent=e.message;}
}
document.getElementById('btnSubmitListing').addEventListener('click',async()=>{
 const button=document.getElementById('btnSubmitListing'), alert=document.getElementById('sellerAlert');
 if(button.disabled)return;
 const title=document.getElementById('listingTitle').value.trim();
 const category=document.getElementById('listingCategory').value.trim();
 const description=document.getElementById('listingDescription').value.trim();
 const price=Number(document.getElementById('listingPrice').value);
 if(title.length<3||!category||!Number.isFinite(price)||price<20000||price>3000000){alert.textContent='Enter a name, category and price between ₦20,000 and ₦3,000,000.';return;}
 button.disabled=true;alert.textContent='Submitting…';
 try{
  await OBIT.post('/api/market/listings',{title,category,description,price},{token:OBIT.getSession('member')});
  alert.textContent='Listing submitted for review. It will appear publicly after approval.';
  for(const id of ['listingTitle','listingCategory','listingDescription','listingPrice'])document.getElementById(id).value='';
  await loadSeller();
 }catch(e){alert.textContent=e.message;}
 finally{button.disabled=false;}
});
document.getElementById('marketSearch').addEventListener('input',renderMarket);
document.getElementById('btnRefresh').addEventListener('click',()=>{loadMarket();loadSeller();});
loadMarket();loadSeller();
