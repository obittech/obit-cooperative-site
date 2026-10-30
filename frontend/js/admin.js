// admin.js

function showAlert(message, type = 'error') {
  document.getElementById('alertBox').innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

document.getElementById('btnShowAdminSetup').addEventListener('click', () => {
  const panel = document.getElementById('adminSetup');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

document.getElementById('btnAdminCode').addEventListener('click', async () => {
  try {
    const email = document.getElementById('adminSetupEmail').value.trim();
    const r = await OBIT.post('/api/auth/request-admin-setup', { email });
    document.getElementById('adminSetupUserId').value = r.user_id;
    showAlert('Activation code sent. Check the authorized admin mailbox.', 'success');
  } catch (err) { showAlert(err.message); }
});

document.getElementById('btnAdminActivate').addEventListener('click', async () => {
  try {
    await OBIT.post('/api/auth/set-admin-password', {
      user_id: Number(document.getElementById('adminSetupUserId').value),
      setup_code: document.getElementById('adminSetupCode').value.trim(),
      password: document.getElementById('adminSetupPassword').value
    });
    showAlert('Super Admin activated. You can now log in with your admin email and new password.', 'success');
    document.getElementById('loginIdentifier').value = document.getElementById('adminSetupEmail').value.trim();
    document.getElementById('adminSetup').style.display = 'none';
  } catch (err) { showAlert(err.message); }
});

document.getElementById('btnLogin').addEventListener('click', async () => {
  const btn = document.getElementById('btnLogin');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  const identifier = document.getElementById('loginIdentifier').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await OBIT.post('/api/auth/login', { identifier, password });
    if (!['staff', 'admin'].includes(res.role)) throw new Error('This login is for staff/admin accounts only.');
    if (res.mfa_required) {
      const code = prompt('Use the newest 6-digit code from the email titled "Your Obit Admin login code". It expires in 10 minutes. Enter it here:');
      if (code === null) {
        showAlert('Login code was not entered. Click Log In to request a new code.');
        return;
      }
      const verified = await OBIT.post('/api/auth/admin-mfa', { user_id: res.user_id, code: code.trim() });
      OBIT.saveSession('staff', verified.token);
    } else {
      OBIT.saveSession('staff', res.token);
    }
    await loadAll();
  } catch (err) {
    showAlert(err.message === 'Invalid or expired admin login code'
      ? 'That code was not accepted. Click Log In again, then enter the code from the newest admin login email within 10 minutes.'
      : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Log In';
  }
});

document.getElementById('logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
  OBIT.clearSession('staff');
  document.getElementById('loggedInView').style.display = 'none';
  document.getElementById('loggedOutView').style.display = '';
  document.getElementById('logoutLink').style.display = 'none';
});

document.querySelectorAll('.tab-row [data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-row [data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    ['queue', 'withdrawals', 'market', 'reconciliation', 'audit'].forEach((name) => {
      document.getElementById(`panel-${name}`).style.display = name === btn.dataset.tab ? '' : 'none';
    });
  });
});

function badge(status) {
  const cls = ['ACTIVE', 'PAYMENT_VERIFIED', 'KYC_VERIFIED'].includes(status) ? 'ok'
    : (status || '').includes('FAILED') || status === 'REJECTED' ? 'fail'
    : 'pending';
  return `<span class="status-badge ${cls}">${status}</span>`;
}
function escapeMarket(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadAll() {
  const token = OBIT.getSession('staff');
  if (!token) return;
  try {
    const dash = await OBIT.get('/api/admin/dashboard', { token });
    document.getElementById('dashboardCards').innerHTML = `
      <div class="card"><div class="eyebrow green">ACTIVE MEMBERS</div><h2 style="font-size:38px">${dash.active_members}</h2></div>
      <div class="card"><div class="eyebrow green">BY STATUS</div>${Object.entries(dash.applications_by_status).map(([s, n]) => `<div style="margin-top:6px">${badge(s)} <b>${n}</b></div>`).join('') || '<p class="muted-note">No applications yet.</p>'}</div>
    `;

    await refreshQueue(token);
    await refreshWithdrawals(token);
    await refreshMarketListings(token);
    await refreshMarketRequests(token);
    await refreshMarketOrders(token);
    await DeliveryAdmin.refresh(token);
    await refreshMarketPayments(token);
    await refreshMarketStores(token);
    await refreshReconciliation(token);
    await refreshAudit(token);

    document.getElementById('loggedOutView').style.display = 'none';
    document.getElementById('loggedInView').style.display = '';
    document.getElementById('logoutLink').style.display = '';
  } catch (err) {
    OBIT.clearSession('staff');
    showAlert(err.message);
  }
}

async function refreshMarketListings(token) {
  const rows = await OBIT.get('/api/admin/market/listings', { token });
  await refreshMarketPromotions(token,rows);
  document.getElementById('marketListingsBody').innerHTML = rows.map((item) => {
    const actions = item.status === 'DRAFT'
      ? `<button class="btn btn-secondary" data-market-id="${item.id}" data-market-decision="APPROVE">Approve</button> <button class="btn btn-secondary" data-market-id="${item.id}" data-market-decision="REJECT">Reject</button>`
      : item.status === 'ACTIVE'
        ? `<button class="btn btn-secondary" data-market-id="${item.id}" data-market-decision="PAUSE">Pause</button>`
        : `<button class="btn btn-secondary" data-market-id="${item.id}" data-market-decision="RESUME">Resume</button>`;
    return `<tr><td><strong>${escapeMarket(item.title)}</strong><br><span class="muted-note">${escapeMarket(item.category)} · ${escapeMarket(item.description || '')}</span>${item.image_url && /^https:\/\//.test(item.image_url) ? `<br><a href="${escapeMarket(item.image_url)}" target="_blank" rel="noopener noreferrer">View product photo ↗</a>` : ''}</td><td>${escapeMarket(item.member_code)}<br><span class="muted-note">${escapeMarket(item.full_legal_name)} (${escapeMarket(item.member_status)})</span></td><td>₦${Number(item.price).toLocaleString('en-NG')}</td><td>${badge(escapeMarket(item.status))}</td><td>${actions}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted-note">No listings to review.</td></tr>';
  document.querySelectorAll('[data-market-decision]').forEach((button) => button.addEventListener('click', async () => {
    const status = document.getElementById('marketReviewAlert');
    button.disabled = true;
    try {
      const decision = button.dataset.marketDecision;
      await OBIT.post(`/api/admin/market/listings/${button.dataset.marketId}/decision`, { decision }, { token });
      status.textContent = `Listing status: ${{APPROVE:'approved',REJECT:'rejected',PAUSE:'paused',RESUME:'active'}[decision]}.`;
      await refreshMarketListings(token);
    } catch (err) { status.textContent = err.message; button.disabled = false; }
  }));
}

async function refreshQueue(token) {
  const apps = await OBIT.get('/api/admin/applications', { token });
  document.getElementById('queueBody').innerHTML = apps.map((a) => `
    <tr>
      <td>${a.id}</td>
      <td>${a.full_legal_name || '—'}</td>
      <td>${badge(a.status)}</td>
      <td>${a.updated_at}</td>
      <td>
        ${a.status === 'UNDER_REVIEW' ? `
          <button class="btn btn-secondary" data-decide="${a.id}" data-decision="APPROVE">Approve</button>
          <button class="btn btn-secondary" data-decide="${a.id}" data-decision="NEEDS_INFORMATION">Needs Info</button>
          <button class="btn btn-secondary" data-decide="${a.id}" data-decision="REJECT">Reject</button>
        ` : '<span class="muted-note">—</span>'}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="5" class="muted-note">No applications yet.</td></tr>`;

  document.querySelectorAll('[data-decide]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.decide;
      const decision = btn.dataset.decision;
      try {
        const result = await OBIT.post(`/api/admin/applications/${id}/decision`, { decision }, { token });
        if (decision === 'APPROVE' && result.member?.member_code) {
          alert(`Application approved. Permanent Member ID: ${result.member.member_code}`);
        }
        await refreshQueue(token);
        const dash = await OBIT.get('/api/admin/dashboard', { token });
        document.getElementById('dashboardCards').querySelector('h2').textContent = dash.active_members;
      } catch (err) { alert(err.message); }
    });
  });
}

async function refreshWithdrawals(token) {
  const summary = await OBIT.get('/api/admin/finance/summary', { token });
  document.getElementById('financeCards').innerHTML = `
    <div class="card"><div class="eyebrow green">VERIFIED CONTRIBUTIONS</div><h2>₦${Number(summary.verified_contributions.total || 0).toLocaleString()}</h2></div>
    <div class="card"><div class="eyebrow green">PENDING WITHDRAWALS</div><h2>₦${Number(summary.pending_withdrawals.total || 0).toLocaleString()}</h2></div>`;
  const rows = await OBIT.get('/api/admin/withdrawals', { token });
  document.getElementById('withdrawalsBody').innerHTML = rows.map(w => `<tr>
    <td>${w.member_code}<br><span class="muted-note">${w.full_legal_name}</span></td>
    <td>₦${Number(w.amount).toLocaleString()}</td><td>${w.bank_name}<br><span class="muted-note">${w.account_number}</span></td>
    <td>${badge(w.status)}</td><td>${w.status === 'PENDING' ? `
      <button class="btn btn-secondary" data-wid="${w.id}" data-wdecision="APPROVE">Approve</button>
      <button class="btn btn-secondary" data-wid="${w.id}" data-wdecision="REJECT">Reject</button>` :
      w.status === 'APPROVED' ? (!w.transfer_reference
        ? `<button class="btn btn-primary" data-payout="${w.id}">Initiate Payout</button>`
        : w.provider_status === 'otp'
          ? `<button class="btn btn-primary" data-otp-payout="${w.id}">Enter Paystack OTP</button>`
          : `<button class="btn btn-primary" data-reconcile-payout="${w.id}">Verify Paystack Status</button>`) : '—'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="muted-note">No withdrawal requests.</td></tr>';

  document.querySelectorAll('[data-wdecision]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await OBIT.post(`/api/admin/withdrawals/${btn.dataset.wid}/decision`, { decision: btn.dataset.wdecision }, { token });
      await refreshWithdrawals(token);
    } catch (err) { alert(err.message); }
  }));
  document.querySelectorAll('[data-otp-payout]').forEach(btn => btn.addEventListener('click', async () => {
    const otp = prompt('Enter the 6-digit Paystack transfer OTP.');
    if (otp === null) return;
    try {
      const r = await OBIT.post(`/api/admin/withdrawals/${btn.dataset.otpPayout}/finalize-payout`, { otp: otp.trim() }, { token });
      alert(`Paystack OTP submitted. Provider status: ${r.provider_status}. The ledger will debit only after provider success confirmation.`);
      await refreshWithdrawals(token);
    } catch (err) { alert(err.message); }
  }));
  document.querySelectorAll('[data-reconcile-payout]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      const r = await OBIT.post(`/api/admin/withdrawals/${btn.dataset.reconcilePayout}/reconcile-payout`, {}, { token });
      alert(r.status === 'PAID' ? 'Paystack confirmed the payout. Withdrawal is now PAID and the member ledger has been updated.' : `Paystack status: ${r.provider_status || r.status}. No ledger debit was made.`);
      await refreshWithdrawals(token);
    } catch (err) { alert(err.message); }
  }));
  document.querySelectorAll('[data-payout]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Initiate this Paystack payout to the verified member bank account?')) return;
    try {
      const r = await OBIT.post(`/api/admin/withdrawals/${btn.dataset.payout}/initiate-payout`, {}, { token });
      alert(`Payout initiated. Provider status: ${r.provider_status}. The member ledger will debit only after transfer.success confirmation.`);
      await refreshWithdrawals(token);
    } catch (err) { alert(err.message); }
  }));
}

async function refreshReconciliation(token) {
  const rec = await OBIT.get('/api/admin/reconciliation/exceptions', { token });
  document.getElementById('stalePaymentsBody').innerHTML = rec.stale_pending_payments.map((p) =>
    `<tr><td>${p.reference}</td><td>₦${p.amount}</td><td>${p.provider}</td><td>${p.created_at}</td></tr>`
  ).join('') || `<tr><td colspan="4" class="muted-note">None.</td></tr>`;
  document.getElementById('stuckWebhooksBody').innerHTML = rec.stuck_webhooks.map((w) =>
    `<tr><td>${w.provider}</td><td>${w.event_id}</td><td>${w.received_at}</td></tr>`
  ).join('') || `<tr><td colspan="3" class="muted-note">None.</td></tr>`;
}

async function refreshAudit(token) {
  const events = await OBIT.get('/api/admin/audit', { token });
  document.getElementById('auditBody').innerHTML = events.map((e) =>
    `<tr><td>${e.created_at}</td><td>${e.action}</td><td>${e.entity_type}${e.entity_id ? ' #' + e.entity_id : ''}</td><td class="muted-note">${e.detail_json}</td></tr>`
  ).join('') || `<tr><td colspan="4" class="muted-note">No events yet.</td></tr>`;
}

if (OBIT.getSession('staff')) loadAll();

async function refreshMarketRequests(token) {
  const target=document.getElementById('marketRequestsBody');
  try {
    const rows=await OBIT.get('/api/admin/market/requests',{token});
    target.innerHTML=rows.map(r=>`<tr><td>${escapeMarket(r.reference)}</td><td>₦${(Number(r.subtotal_kobo)/100).toLocaleString('en-NG')}</td><td>${escapeMarket(r.destination.city)}, ${escapeMarket(r.destination.state)}</td><td>${Number(r.waiting_count)} awaiting / ${Number(r.seller_count)} sellers</td><td>${escapeMarket(r.status)}</td></tr>`).join('')||'<tr><td colspan="5">No quote requests yet.</td></tr>';
  } catch (e) { target.innerHTML='<tr><td colspan="5">Quote requests could not be loaded. Refresh to try again.</td></tr>'; }
}

async function refreshMarketStores(token){
 const target=document.getElementById('marketStores');
 try{
  const rows=await OBIT.get('/api/admin/market/stores',{token});
  target.innerHTML=rows.map(s=>`<form class="card" data-store-review="${Number(s.id)}" data-version="${Number(s.version)}"><h3>${escapeMarket(s.name)}</h3><p>${escapeMarket(s.description)}</p><p>${escapeMarket(s.member_code)} · Member ${escapeMarket(s.member_status)} · Store ${escapeMarket(s.status)}</p><label class="field">Decision<select name="decision"><option value="APPROVED" ${s.status==='APPROVED'?'selected':''}>Approve</option><option value="REJECTED" ${s.status==='REJECTED'?'selected':''}>Reject / remove approval</option></select></label><label><input name="official" type="checkbox" ${Number(s.official)===1?'checked':''}> Official store. I have checked brand ownership or written authorisation.</label><label class="field">Private review note / authorisation reference<textarea name="evidence" maxlength="1000" rows="2">${escapeMarket(s.verification_note)}</textarea></label><button class="btn" type="submit">Save review</button><p role="status"></p></form>`).join('')||'<p>No store profiles submitted yet.</p>';
  target.querySelectorAll('[data-store-review]').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await OBIT.post(`/api/admin/market/stores/${form.dataset.storeReview}/review`,{version:Number(form.dataset.version),status:form.elements.decision.value,official:form.elements.official.checked,verification_note:form.elements.evidence.value},{token});await refreshMarketStores(token);}catch(err){form.querySelector('[role=status]').textContent=err.message;button.disabled=false;}}));
 }catch(err){target.textContent=err.message;}
}
async function refreshMarketPromotions(token,listings){
 const target=document.getElementById('marketPromotions');
 try{
  const rows=await OBIT.get('/api/admin/market/promotions',{token}),byId=new Map(rows.map(p=>[Number(p.listing_id),p]));
  target.innerHTML=listings.filter(l=>l.status==='ACTIVE').map(l=>{const p=byId.get(Number(l.id));return `<form class="card" data-promotion="${Number(l.id)}" data-version="${Number(p?.version||0)}"><h3>${escapeMarket(l.title)}</h3><p>Listing price ₦${Number(l.price).toLocaleString('en-NG')}</p><label><input name="enabled" type="checkbox" ${Number(p?.enabled)===1?'checked':''}> Enable promotion</label><label class="field">Label<input name="label" maxlength="60" value="${escapeMarket(p?.label||'Member offer')}"></label><label class="field">Promotional price (₦)<input name="price" type="number" min="20000" max="3000000" step="0.01" value="${p?Number(p.price_kobo)/100:''}"></label><label class="field">Starts at (UTC)<input name="starts" type="datetime-local" value="${p?new Date(Number(p.starts_ms)).toISOString().slice(0,16):''}"></label><label class="field">Ends at (UTC)<input name="ends" type="datetime-local" value="${p?new Date(Number(p.ends_ms)).toISOString().slice(0,16):''}"></label><p class="muted-note">UTC is one hour behind Nigeria time. Maximum duration: 90 days. A listing price change stops the promotion. No crossed-out reference prices are shown.</p><button class="btn" type="submit">Save promotion</button><p role="status"></p></form>`;}).join('')||'<p>Approve real products before scheduling promotions.</p>';
  target.querySelectorAll('[data-promotion]').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await OBIT.post(`/api/admin/market/listings/${form.dataset.promotion}/promotion`,{version:Number(form.dataset.version),enabled:form.elements.enabled.checked,label:form.elements.label.value,price_kobo:Math.round(Number(form.elements.price.value)*100),starts_ms:Date.parse(form.elements.starts.value+'Z'),ends_ms:Date.parse(form.elements.ends.value+'Z')},{token});await refreshMarketPromotions(token,listings);}catch(err){form.querySelector('[role=status]').textContent=err.message;button.disabled=false;}}));
 }catch(err){target.textContent=err.message;}
}

async function refreshMarketOrders(token){
 const target=document.getElementById('marketOrdersBody');
 try{const rows=await OBIT.get('/api/admin/market/orders',{token});target.innerHTML=rows.map(o=>`<tr><td>${escapeMarket(o.reference)}<br><button class="text-button" type="button" data-inspect-delivery="${o.id}">Delivery details</button></td><td>₦${(o.total_kobo/100).toLocaleString('en-NG')}</td><td>${escapeMarket(o.destination.city)}, ${escapeMarket(o.destination.state)}</td><td>${escapeMarket(o.status)}</td><td>${escapeMarket(new Date(o.expires_ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'}))} (Nigeria time)</td></tr>`).join('')||'<tr><td colspan="5">No purchase orders yet.</td></tr>';DeliveryAdmin.bindOrders(rows,token);}catch(e){target.textContent=e.message;}
}
document.getElementById('refreshMarketOrders').addEventListener('click',()=>refreshMarketOrders(OBIT.getSession('staff')));

async function refreshMarketPayments(token){
 const target=document.getElementById('marketPaymentsBody');
 try{const [rows,caps]=await Promise.all([OBIT.get('/api/admin/market/payments',{token}),OBIT.get('/api/market/capabilities')]);
 document.getElementById('marketPaymentReadiness').textContent=caps.test_checkout_available?'Monnify sandbox only. Reconciliation queries the provider and cannot initiate a refund or dispatch.':'Monnify live collection is disabled. Sandbox credentials and an isolated test environment are required to test checkout.';
 target.innerHTML=rows.map(p=>`<tr><td>${escapeMarket(p.order_reference)}<br>${escapeMarket(p.reference)}<br>Monnify · ${escapeMarket(p.mode)}</td><td>₦${(p.amount_kobo/100).toLocaleString('en-NG')}</td><td>${escapeMarket(p.status)}</td><td>${escapeMarket(p.review_reason)}</td><td><button class="btn btn-secondary" type="button" data-reconcile-market="${p.order_id}" ${caps.test_checkout_available?'':'disabled'}>Check Monnify status</button></td></tr>`).join('')||'<tr><td colspan="5">No marketplace payment attempts.</td></tr>';
 target.querySelectorAll('[data-reconcile-market]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const result=await OBIT.post(`/api/admin/market/orders/${button.dataset.reconcileMarket}/payment/reconcile`,{},{token});document.getElementById('marketPaymentAlert').textContent='Provider status: '+result.status;await refreshMarketPayments(token);await refreshMarketOrders(token);}catch(e){document.getElementById('marketPaymentAlert').textContent=e.message;button.disabled=false;}}));
 }catch(e){target.textContent=e.message;}
}
document.getElementById('refreshMarketPayments').addEventListener('click',()=>refreshMarketPayments(OBIT.getSession('staff')));
