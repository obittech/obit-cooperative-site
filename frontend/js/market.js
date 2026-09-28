function money(n){return '₦'+Number(n||0).toLocaleString('en-NG',{maximumFractionDigits:2});}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function loadMarket(){
 const grid=document.getElementById('listingGrid'), alert=document.getElementById('marketAlert');
 grid.innerHTML='<div class="muted-note">Loading market…</div>'; alert.innerHTML='';
 try{
  const [rows,status]=await Promise.all([OBIT.get('/api/market/listings'),OBIT.get('/api/safepay/status')]);
  document.getElementById('pilotNotice').innerHTML='<strong>Obit Market pilot:</strong> Listings are available to browse. Checkout for nonmember buyers and live payments are still in development. Do not send payment for a listing through this page.';
  grid.innerHTML=rows.length?rows.map(x=>`<article class="listing"><span class="category">${escapeHtml(x.category||'Other')}</span><h3>${escapeHtml(x.title)}</h3><p>${escapeHtml(x.description||'Member marketplace listing.')}</p><div class="price">${money(x.price)}</div><span class="status-badge ok">Active member seller</span></article>`).join(''):'<div class="card"><h3>Marketplace pilot ready</h3><p class="muted-note">Member listings will appear here as the controlled pilot opens.</p></div>';
 }catch(e){grid.innerHTML='';alert.textContent=e.message;}
}
document.getElementById('btnRefresh').addEventListener('click',loadMarket);loadMarket();
