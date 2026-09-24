function money(n){return '₦'+Number(n||0).toLocaleString('en-NG',{maximumFractionDigits:2});}
async function loadMarket(){
 const grid=document.getElementById('listingGrid'), alert=document.getElementById('marketAlert');
 grid.innerHTML='<div class="muted-note">Loading market…</div>'; alert.innerHTML='';
 try{
  const [rows,status]=await Promise.all([OBIT.get('/api/market/listings'),OBIT.get('/api/safepay/status')]);
  document.getElementById('pilotNotice').innerHTML='<strong>SafePay '+(status.mode||'pilot')+':</strong> '+(status.enabled?'Provider sandbox is connected for controlled testing.':'Real escrow funding remains disabled until provider sandbox credentials, signed webhook rules and commercial approval are completed.');
  grid.innerHTML=rows.length?rows.map(x=>`<article class="listing"><span class="category">${x.category||'Other'}</span><h3>${x.title}</h3><p>${x.description||'Member marketplace listing.'}</p><div class="price">${money(x.price)}</div><span class="status-badge ok">Verified-member marketplace</span></article>`).join(''):'<div class="card"><h3>Marketplace pilot ready</h3><p class="muted-note">Member listings will appear here as the controlled pilot opens.</p></div>';
 }catch(e){grid.innerHTML='';alert.innerHTML=`<div class="alert alert-error">${e.message}</div>`;}
}
document.getElementById('btnRefresh').addEventListener('click',loadMarket);loadMarket();