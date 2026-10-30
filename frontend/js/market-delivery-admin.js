const DeliveryAdmin=(()=>{
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let records=[],token='';
 function editor(row=null){const form=$('pickupEditor');form.dataset.id=row?.id||'';form.dataset.version=row?.version||'0';for(const k of ['name','address','city','state','hours'])form.elements[k].value=row?.[k]||'';$('pickupEditorTitle').textContent=row?'Edit pickup location':'Add pickup location';}
 async function refresh(auth){token=auth;try{
  const [rows,caps]=await Promise.all([OBIT.get('/api/admin/market/pickup-locations',{token}),OBIT.get('/api/market/capabilities')]);records=rows;const form=$('pickupEditor'),current=form.elements.state.value;form.elements.state.innerHTML='<option value="">Select state</option>'+caps.states.map(s=>`<option>${esc(s)}</option>`).join('');form.elements.state.value=current;
  $('pickupLocationsAdmin').innerHTML=rows.map(p=>`<article class="card"><h3>${esc(p.name)}</h3><span class="status-badge">${esc(p.status)}</span><p>${esc(p.address)}, ${esc(p.city)}, ${esc(p.state)}</p><p>${esc(p.hours)}</p><p class="muted-note">${esc(p.code)} · Version ${Number(p.version)}</p><form data-pickup-review="${p.id}" data-version="${p.version}"><label class="field">Private operations verification note<textarea name="note" maxlength="600" rows="3">${esc(p.verification_note)}</textarea></label><label class="pickup-confirm"><input name="confirmed" type="checkbox"> I checked the address, opening hours and collection arrangements. This location is ready to receive customers.</label><div class="pickup-admin-actions"><button class="btn" type="submit">Verify &amp; publish location</button><button class="btn btn-secondary" type="button" data-pause-pickup>Pause location</button><button class="text-button" type="button" data-edit-pickup="${p.id}">Edit details</button></div><p role="status"></p></form></article>`).join('')||'<p>No pickup locations registered. Add a draft and verify operations before publishing it.</p>';
  $('pickupLocationsAdmin').querySelectorAll('[data-pickup-review]').forEach(f=>{
   async function review(status){const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await OBIT.post(`/api/admin/market/pickup-locations/${f.dataset.pickupReview}/review`,{version:Number(f.dataset.version),status,confirmed:f.elements.confirmed.checked,verification_note:f.elements.note.value},{token});await refresh(token);}catch(e){f.querySelector('[role=status]').textContent=e.message;buttons.forEach(b=>b.disabled=false);}}
   f.addEventListener('submit',e=>{e.preventDefault();review('ACTIVE');});f.querySelector('[data-pause-pickup]').addEventListener('click',()=>review('PAUSED'));
   f.querySelector('[data-edit-pickup]').addEventListener('click',()=>{editor(records.find(p=>Number(p.id)===Number(f.dataset.pickupReview)));$('pickupEditor').scrollIntoView({block:'start'});});
  });
 }catch(e){$('pickupLocationsAdmin').textContent=e.message;}}
 $('pickupEditor').addEventListener('submit',async e=>{e.preventDefault();const f=e.target,button=f.querySelector('button[type=submit]');button.disabled=true;try{const body=Object.fromEntries(new FormData(f));body.version=Number(f.dataset.version||0);await OBIT.post('/api/admin/market/pickup-locations'+(f.dataset.id?'/'+f.dataset.id:''),body,{token});editor();$('pickupEditorStatus').textContent='Draft saved. Review and verify the location before publishing.';await refresh(token);}catch(err){$('pickupEditorStatus').textContent=err.message;}finally{button.disabled=false;}});
 $('newPickupDraft').addEventListener('click',()=>editor());$('refreshPickupAdmin').addEventListener('click',()=>refresh(OBIT.getSession('staff')));
 function bindOrders(rows,auth){
  document.querySelectorAll('[data-inspect-delivery]').forEach(button=>button.addEventListener('click',async()=>{
   const o=rows.find(r=>Number(r.id)===Number(button.dataset.inspectDelivery));const root=$('opsDeliveryPanel');
   async function load(){try{const data=await OBIT.get(`/api/admin/market/orders/${o.id}/delivery`,{token:auth}),order={...o,...data,delivery_test_available:data.test_available&&o.status==='TEST_PAID'&&data.fulfilment?.available!==false};root.innerHTML=`<h3>${esc(o.reference)}</h3>`+DeliveryUI.card(order,'STAFF');DeliveryUI.bind(root,[order],'STAFF',load);root.scrollIntoView({block:'start'});}catch(e){root.textContent=e.message;}}
   await load();
  }));
 }
 return {refresh,bindOrders};
})();
