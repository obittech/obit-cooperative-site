// admin.js

function showAlert(message, type = 'error') {
  document.getElementById('alertBox').innerHTML = `<div class="alert alert-${type === 'success' ? 'success' : 'error'}">${escapeMarket(message)}</div>`;
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

const adminLoginForm = document.getElementById('adminLoginForm');
const adminMfaForm = document.getElementById('adminMfaForm');
const adminMfaCode = document.getElementById('adminMfaCode');
let pendingAdminUserId = null;
let adminAuthBusy = false;

function setAdminAuthBusy(busy) {
  adminAuthBusy = busy;
  ['btnLogin', 'btnVerifyAdminCode', 'btnResendAdminCode', 'btnChangeAdminLogin'].forEach(id => {
    document.getElementById(id).disabled = busy;
  });
}

function resetAdminLogin() {
  pendingAdminUserId = null;
  adminMfaCode.value = '';
  document.getElementById('loginPassword').value = '';
  adminMfaForm.hidden = true;
  adminLoginForm.hidden = false;
  document.getElementById('btnShowAdminSetup').style.display = '';
}

async function requestAdminLoginCode() {
  if (adminAuthBusy) return;
  setAdminAuthBusy(true);
  const btn = document.getElementById('btnLogin');
  const resend = document.getElementById('btnResendAdminCode');
  btn.textContent = 'Signing in...';
  resend.textContent = 'Sending...';
  // A new login replaces the previous challenge. Never submit an old code after a resend.
  pendingAdminUserId = null;
  adminMfaCode.value = '';
  try {
    const identifier = document.getElementById('loginIdentifier').value.trim();
    const password = document.getElementById('loginPassword').value;
    const res = await OBIT.post('/api/auth/login', { identifier, password });
    if (!['staff', 'admin'].includes(res.role)) throw new Error('This login is for staff/admin accounts only.');
    if (res.mfa_required) {
      pendingAdminUserId = res.user_id;
      adminLoginForm.hidden = true;
      adminMfaForm.hidden = false;
      document.getElementById('adminSetup').style.display = 'none';
      document.getElementById('btnShowAdminSetup').style.display = 'none';
      showAlert('Login code sent. Enter the newest emailed code in the box below.', 'success');
      adminMfaCode.focus();
      return;
    }
    OBIT.saveSession('staff', res.token);
    resetAdminLogin();
    await loadAll();
  } catch (err) {
    resetAdminLogin();
    showAlert(err.message);
  } finally {
    setAdminAuthBusy(false);
    btn.textContent = 'Log In';
    resend.textContent = 'Send New Code';
  }
}

adminLoginForm.addEventListener('submit', event => {
  event.preventDefault();
  if (adminLoginForm.reportValidity()) return requestAdminLoginCode();
});
document.getElementById('btnResendAdminCode').addEventListener('click', requestAdminLoginCode);
document.getElementById('btnChangeAdminLogin').addEventListener('click', () => {
  if (adminAuthBusy) return;
  resetAdminLogin();
  document.getElementById('alertBox').textContent = '';
  document.getElementById('loginPassword').focus();
});

adminMfaForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (adminAuthBusy) return;
  const code = adminMfaCode.value.trim();
  if (!/^[0-9]{6}$/.test(code)) {
    showAlert('Enter the 6-digit code from your newest admin login email.');
    adminMfaCode.focus();
    return;
  }
  if (pendingAdminUserId === null) {
    showAlert('Select Send New Code to request a fresh login code.');
    return;
  }
  setAdminAuthBusy(true);
  const btn = document.getElementById('btnVerifyAdminCode');
  btn.textContent = 'Verifying...';
  try {
    const verified = await OBIT.post('/api/auth/admin-mfa', { user_id: pendingAdminUserId, code });
    OBIT.saveSession('staff', verified.token);
    resetAdminLogin();
    document.getElementById('alertBox').textContent = '';
    await loadAll();
  } catch (err) {
    showAlert(err.message === 'Invalid or expired admin login code'
      ? 'That code was not accepted. Enter the newest emailed code, or select Send New Code if it has expired.'
      : err.message);
    adminMfaCode.value = '';
    adminMfaCode.focus();
  } finally {
    setAdminAuthBusy(false);
    btn.textContent = 'Verify Code';
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
  return `<span class="status-badge ${cls}">${escapeMarket(status)}</span>`;
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
    await refreshMarketStores(token);await refreshMarketTrials(token);
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
  await MarketVideoAdmin.refresh(token);
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
  await refreshMembershipTransfers(token);
  await refreshReferralBonuses(token);
  const apps = await OBIT.get('/api/admin/applications', { token });
  document.getElementById('queueBody').innerHTML = apps.map((a) => `
    <tr>
      <td>${escapeMarket(a.id)}</td>
      <td>${escapeMarket(a.full_legal_name || '—')}</td>
      <td>${badge(a.status)}</td>
      <td>${escapeMarket(a.updated_at)}</td>
      <td>
        ${a.status === 'UNDER_REVIEW' ? `
          <button class="btn btn-secondary" data-decide="${escapeMarket(a.id)}" data-decision="APPROVE">Approve</button>
          <button class="btn btn-secondary" data-decide="${escapeMarket(a.id)}" data-decision="NEEDS_INFORMATION">Needs Info</button>
          <button class="btn btn-secondary" data-decide="${escapeMarket(a.id)}" data-decision="REJECT">Reject</button>
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

async function refreshMembershipTransfers(token) {
  const rows = await OBIT.get('/api/admin/membership-transfers', { token });
  const root = document.getElementById('membershipTransfers');
  root.innerHTML = rows.map(p => `<article style="border-top:1px solid #ddd;padding:16px 0"><h3>Application ${Number(p.application_id)} · ${escapeMarket(p.full_legal_name || '')}</h3><p>${escapeMarket(p.reference)} · ₦${(Number(p.amount_kobo) / 100).toLocaleString('en-NG')} · ${escapeMarket(p.status)}</p><p>${escapeMarket(p.bank_name)} · ${escapeMarket(p.account_name)} · ${escapeMarket(p.account_number)}</p>${p.bank_reference ? `<p><strong>Confirmed bank credit reference:</strong> ${escapeMarket(p.bank_reference)}</p>` : ''}${p.existing_member_code ? `<p><strong>Existing Member ID:</strong> ${escapeMarket(p.existing_member_code)} · ${escapeMarket(p.existing_member_status)} · Application ${Number(p.existing_member_application_id)}<br>${p.linked_member_id ? 'This application is approved under the existing membership.' : Number(p.existing_member_application_id) === Number(p.application_id) ? 'This application already has a membership record.' : 'Review the existing membership before approving a duplicate application.'}</p>` : ''}${p.sponsor_code ? `<p><strong>Sponsor:</strong> ${escapeMarket(p.sponsor_code)} · ${escapeMarket(p.sponsor_name)} · ${escapeMarket(p.sponsor_phone)}<br>Referral bonus: ₦500 after membership approval.</p>` : `<p>No member sponsor recorded.</p>`}${p.status === 'CLAIMED' ? `<form data-membership-transfer="${escapeMarket(p.reference)}" data-existing-member="${p.existing_member_code && Number(p.existing_member_application_id) !== Number(p.application_id) ? escapeMarket(p.existing_member_code) : ''}"><label class="field">Actual credit amount (₦)<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="field">Bank transaction reference<input name="bank_reference" minlength="6" maxlength="120" required></label><label class="checkbox-row"><input name="checked" type="checkbox" required><span>I checked this credit in the receiving bank account.</span></label>${p.existing_member_code && Number(p.existing_member_application_id) !== Number(p.application_id) ? `<label class="checkbox-row"><input name="same_member" type="checkbox" required><span>I checked that both applications belong to this same member and refer to the same payment.</span></label>` : ''}<button class="btn btn-primary" type="submit">${p.existing_member_code ? 'Confirm Payment & Approve Existing Membership' : 'Confirm Payment & Approve Membership'}</button><p role="status"></p></form>` : p.status === 'CONFIRMED' ? (p.application_status === 'ACTIVE' ? '<p>Payment confirmed. Membership is active.</p>' : p.existing_member_code ? '<p>Payment confirmed. Existing membership requires review. Please do not approve a duplicate application.</p>' : '<p>Payment confirmed. Membership approval is pending in the Application Queue.</p>') : '<p>Waiting for the applicant to report payment.</p>'}</article>`).join('') || '<p class="muted-note">No membership bank transfers yet.</p>';
  root.querySelectorAll('[data-membership-transfer]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await OBIT.post(`/api/admin/membership-transfers/${encodeURIComponent(form.dataset.membershipTransfer)}/${form.dataset.existingMember ? 'approve-existing' : 'confirm-and-approve'}`, {
        amount_kobo: Math.round(Number(form.elements.amount.value) * 100),
        bank_reference: form.elements.bank_reference.value.trim(), bank_credit_checked: form.elements.checked.checked,
        ...(form.dataset.existingMember ? { member_code: form.dataset.existingMember, same_member_checked: form.elements.same_member.checked } : {}),
      }, { token });
      if (result.membership_review_required) alert(`Payment confirmed. Existing Member ID: ${result.existing_member.member_code} (${result.existing_member.status}), linked to Application ${result.existing_member.application_id}. This application is under review. No duplicate membership was created.`);
      else if (result.member?.member_code) alert(`Payment confirmed and membership active. Member ID: ${result.member.member_code}`);
      await refreshQueue(token);
    } catch (err) { form.querySelector('[role="status"]').textContent = err.message; button.disabled = false; }
  }));
}

async function refreshReferralBonuses(token) {
  const rows = await OBIT.get('/api/admin/referral-bonuses', { token });
  const root = document.getElementById('referralBonuses');
  root.innerHTML = rows.map(row => `<article style="border-top:1px solid #ddd;padding:16px 0"><h3>₦500 · ${escapeMarket(row.status)}</h3><p><strong>Sponsor:</strong> ${escapeMarket(row.sponsor_code)} · ${escapeMarket(row.sponsor_name)} · ${escapeMarket(row.sponsor_phone)}</p><p>New member: ${escapeMarket(row.new_member_name)} · Application ${Number(row.application_id)}</p>${row.status === 'EARNED' ? `<form data-referral-bonus="${Number(row.id)}"><label class="field">Completed payout bank reference<input name="reference" minlength="6" maxlength="120" required></label><label class="checkbox-row"><input name="checked" type="checkbox" required><span>I verified that the ₦500 referral bonus has been paid to this sponsor.</span></label><button class="btn btn-primary" type="submit">Record completed payout</button><p role="status"></p></form>` : `<p>Payout reference: ${escapeMarket(row.payout_reference)}</p>`}</article>`).join('') || '<p class="muted-note">No referral bonuses earned yet.</p>';
  root.querySelectorAll('[data-referral-bonus]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await OBIT.post(`/api/admin/referral-bonuses/${form.dataset.referralBonus}/paid`, {
        payout_reference: form.elements.reference.value.trim(), amount_kobo: 50000, payout_completed: form.elements.checked.checked,
      }, { token });
      await refreshReferralBonuses(token);
    } catch (err) { form.querySelector('[role="status"]').textContent = err.message; button.disabled = false; }
  }));
}

async function refreshWithdrawals(token) {
  await refreshMemberFinanceRequests(token);
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
  target.innerHTML=rows.map(s=>`<form class="card" data-store-review="${Number(s.id)}" data-version="${Number(s.version)}"><h3>${escapeMarket(s.name)}</h3><p>${escapeMarket(s.description)}</p><p>${escapeMarket(s.member_code)} · Member ${escapeMarket(s.member_status)} · Store ${escapeMarket(s.status)}</p>${s.location?`<div class="card"><h4>Public shop location</h4><p>${escapeMarket([s.location.zone,s.location.state,s.location.lga,s.location.community,s.location.kind,s.location.cluster,s.location.shop_number,s.location.address,s.location.landmark,s.location.hours,s.location.keywords,s.location.phone].filter(Boolean).join(' · '))}</p><p>Map pin: ${escapeMarket(String(s.location.latitude??'not supplied'))}, ${escapeMarket(String(s.location.longitude??'not supplied'))}</p>${s.location.image_url?`<p>Photo: <a href="${escapeMarket(s.location.image_url)}" target="_blank" rel="noopener noreferrer">Review submitted shop photo</a></p>`:''}${s.location.video_url?`<p>Video: <a href="${escapeMarket(s.location.video_url)}" target="_blank" rel="noopener noreferrer">Review submitted shop video</a></p>`:''}<label><input name="locationVerified" type="checkbox" ${Number(s.location_verified)===1?'checked':''}> I checked the shop address and map pin. Record evidence below.</label></div>`:''}<label class="field">Decision<select name="decision"><option value="APPROVED" ${s.status==='APPROVED'?'selected':''}>Approve</option><option value="REJECTED" ${s.status==='REJECTED'?'selected':''}>Reject / remove approval</option></select></label><label><input name="official" type="checkbox" ${Number(s.official)===1?'checked':''}> Official store. I have checked brand ownership or written authorisation.</label><label class="field">Private review note / authorisation reference<textarea name="evidence" maxlength="1000" rows="2">${escapeMarket(s.verification_note)}</textarea></label><button class="btn" type="submit">Save review</button><p role="status"></p></form>`).join('')||'<p>No store profiles submitted yet.</p>';
  target.querySelectorAll('[data-store-review]').forEach(form=>form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await OBIT.post(`/api/admin/market/stores/${form.dataset.storeReview}/review`,{version:Number(form.dataset.version),status:form.elements.decision.value,official:form.elements.official.checked,location_verified:form.elements.locationVerified?.checked===true,verification_note:form.elements.evidence.value},{token});await refreshMarketStores(token);}catch(err){form.querySelector('[role=status]').textContent=err.message;button.disabled=false;}}));
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
 try{const rows=await OBIT.get('/api/admin/market/orders',{token});target.innerHTML=rows.map(o=>`<tr><td>${escapeMarket(o.reference)}<br><button class="text-button" type="button" data-inspect-delivery="${o.id}">Delivery details</button><br><button class="text-button" type="button" data-inspect-aftercare="${Number(o.id)}">Fulfilment / returns / refunds</button></td><td>₦${(o.total_kobo/100).toLocaleString('en-NG')}</td><td>${escapeMarket(o.destination.city)}, ${escapeMarket(o.destination.state)}</td><td>${escapeMarket(o.status)}${o.return_status?`<br>After-sales: ${escapeMarket(o.return_status)}`:""}</td><td>${escapeMarket(new Date(o.expires_ms).toLocaleString('en-NG',{timeZone:'Africa/Lagos'}))} (Nigeria time)</td></tr>`).join('')||'<tr><td colspan="5">No purchase orders yet.</td></tr>';DeliveryAdmin.bindOrders(rows,token);target.querySelectorAll('[data-inspect-aftercare]').forEach(b=>b.addEventListener('click',()=>AftercareUI.openAdmin(Number(b.dataset.inspectAftercare),document.getElementById('opsDeliveryPanel'),token)));}catch(e){target.textContent=e.message;}
}
document.getElementById('refreshMarketOrders').addEventListener('click',()=>refreshMarketOrders(OBIT.getSession('staff')));

async function refreshMarketPayments(token){
 refreshBankPayments(token);
 const target=document.getElementById('marketPaymentsBody');
 try{const [rows,caps]=await Promise.all([OBIT.get('/api/admin/market/payments',{token}),OBIT.get('/api/market/capabilities')]);
 document.getElementById('marketPaymentReadiness').textContent=caps.test_checkout_available?'Monnify sandbox only. Reconciliation queries the provider and cannot initiate a refund or dispatch.':'Monnify sandbox is separate from internal bank transfers. Check internal transfer notifications above.';
 target.innerHTML=rows.map(p=>`<tr><td>${escapeMarket(p.order_reference)}<br>${escapeMarket(p.reference)}<br>Monnify · ${escapeMarket(p.mode)}</td><td>₦${(p.amount_kobo/100).toLocaleString('en-NG')}</td><td>${escapeMarket(p.status)}</td><td>${escapeMarket(p.review_reason)}</td><td><button class="btn btn-secondary" type="button" data-reconcile-market="${p.order_id}" ${caps.test_checkout_available?'':'disabled'}>Check Monnify status</button></td></tr>`).join('')||'<tr><td colspan="5">No marketplace payment attempts.</td></tr>';
 target.querySelectorAll('[data-reconcile-market]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const result=await OBIT.post(`/api/admin/market/orders/${button.dataset.reconcileMarket}/payment/reconcile`,{},{token});document.getElementById('marketPaymentAlert').textContent='Provider status: '+result.status;await refreshMarketPayments(token);await refreshMarketOrders(token);}catch(e){document.getElementById('marketPaymentAlert').textContent=e.message;button.disabled=false;}}));
 }catch(e){target.textContent=e.message;}
}
document.getElementById('refreshMarketPayments').addEventListener('click',()=>refreshMarketPayments(OBIT.getSession('staff')));

async function refreshBankPayments(token){
 let root=document.getElementById('bankTransferAdmin');
 if(!root){root=document.createElement('section');root.id='bankTransferAdmin';document.getElementById('marketPaymentReadiness').before(root);}
 try{const rows=await OBIT.get('/api/admin/market/bank-transfers',{token});
 root.innerHTML='<h3>Internal bank-transfer verification</h3><p>Verify the actual bank credit before confirming. A customer notification is not proof of payment. Follow up on delivery through WhatsApp.</p>'+rows.map(p=>`<article class="card"><h4>${escapeMarket(p.order_reference)}</h4><p>₦${(Number(p.amount_kobo)/100).toLocaleString('en-NG')} · ${escapeMarket(p.status)}</p><p>${escapeMarket(p.bank_name)} · ${escapeMarket(p.account_name)} · ${escapeMarket(p.account_number)}</p>${['CLAIMED','REVIEW'].includes(p.status)&&!p.confirmed_ms?`<form data-confirm-bank="${Number(p.order_id)}" data-amount="${Number(p.amount_kobo)}"><label class="field">Actual bank transaction reference<input name="bank_reference" minlength="6" maxlength="120" required></label><label><input type="checkbox" name="checked" required> I verified this exact amount as a credit in the receiving bank account.</label><button class="btn" type="submit">Confirm bank credit &amp; issue receipt</button><button class="btn btn-secondary" type="button" data-credit-refund-review>Verify credit for refund review only</button><p class="muted-note">Use refund review when goods cannot be allocated, including late payments. This releases the stock hold and cannot authorise dispatch.</p><p role="status"></p></form>`:p.status==='CONFIRMED'?'<p>Payment confirmed. Receipt available in the buyer account.</p>':p.confirmed_ms?'<p>Credit verified for refund review. Open Fulfilment / returns / refunds on the order. Dispatch is blocked.</p>':'<p>Customer has not clicked I Have Paid.</p>'}</article>`).join('');
 root.querySelectorAll('[data-confirm-bank]').forEach(f=>{f.querySelector('[data-credit-refund-review]').addEventListener('click',async()=>{if(!f.reportValidity())return;const buttons=[...f.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await OBIT.post(`/api/admin/market/orders/${f.dataset.confirmBank}/bank-transfer/refund-review`,{bank_reference:f.elements.bank_reference.value,amount_kobo:Number(f.dataset.amount),bank_credit_checked:f.elements.checked.checked},{token});await refreshBankPayments(token);await refreshMarketOrders(token);}catch(err){f.querySelector('[role=status]').textContent=err.message;buttons.forEach(b=>b.disabled=false);}});f.addEventListener('submit',async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;try{await OBIT.post(`/api/admin/market/orders/${f.dataset.confirmBank}/bank-transfer/confirm`,{bank_reference:f.elements.bank_reference.value,amount_kobo:Number(f.dataset.amount),bank_credit_checked:f.elements.checked.checked},{token});await refreshBankPayments(token);await refreshMarketOrders(token);}catch(err){f.querySelector('[role=status]').textContent=err.message;b.disabled=false;}});});
 }catch(e){root.textContent=e.message;}
}

async function refreshMemberFinanceRequests(token) {
  const rows = await OBIT.get('/api/admin/finance-requests', { token });
  const box = document.getElementById('memberFinanceRequests');
  box.innerHTML = rows.map(r => `<article class="card"><h3>${escapeMarket(r.kind)} · ₦${(Number(r.amount_kobo)/100).toLocaleString('en-NG')}</h3><p>${escapeMarket(r.full_legal_name)} · ${escapeMarket(r.member_code)} · ${escapeMarket(r.phone)}</p><p>${escapeMarket(r.reference)} · ${escapeMarket(r.status)}</p>${r.kind==='WITHDRAWAL'&&r.payout_kobo!=null?`<p>Withdrawal debit: ₦${(Number(r.amount_kobo)/100).toLocaleString('en-NG')} · Charge (10%): ₦${(Number(r.fee_kobo)/100).toLocaleString('en-NG')} · Pay recipient: ₦${(Number(r.payout_kobo)/100).toLocaleString('en-NG')}</p>`:''}<p>${escapeMarket(r.bank_name)} · ${escapeMarket(r.account_name)} · ${escapeMarket(r.account_number)} · ${escapeMarket(r.designation)}</p>${r.status === 'REPORTED' ? `<form data-finance-request="${r.id}"><label>Bank transaction reference<input name="reference" minlength="6" maxlength="120" required autocomplete="off"></label><label><input type="checkbox" name="checked" required> ${r.kind === 'DEPOSIT' ? 'Bank credit confirmed' : 'Withdrawal paid to the recipient shown above'}</label><button class="btn" type="submit">${r.kind === 'DEPOSIT' ? 'Confirm Deposit' : 'Record Paid Withdrawal'}</button><p role="status"></p><label>Reason if rejecting<input name="rejection" maxlength="300"></label><button class="btn btn-secondary" type="button" data-finance-reject="${r.id}">Reject unconfirmed request</button></form>` : ''}</article>`).join('') || '<p>No deposit or manual withdrawal requests.</p>';
  box.querySelectorAll('[data-finance-request]').forEach(form => form.addEventListener('submit', async e => {
    e.preventDefault(); const row = rows.find(r => String(r.id) === form.dataset.financeRequest); const button = form.querySelector('button'); button.disabled = true;
    try { await OBIT.post(`/api/admin/finance-requests/${row.id}/confirm`, {amount_kobo:Number(row.amount_kobo), bank_reference:form.elements.reference.value.trim(),confirmed:form.elements.checked.checked}, {token}); await refreshWithdrawals(token); }
    catch (err) { form.querySelector('[role="status"]').textContent=err.message; button.disabled=false; }
  }));
}

document.getElementById('memberFinanceRequests').addEventListener('click', async e => {
  const button=e.target.closest('[data-finance-reject]');if(!button)return;
  const form=button.closest('form');button.disabled=true;
  try {const token=OBIT.getSession('staff');await OBIT.post(`/api/admin/finance-requests/${button.dataset.financeReject}/reject`,{note:form.elements.rejection.value.trim()},{token});await refreshWithdrawals(token);}
  catch(err){form.querySelector('[role="status"]').textContent=err.message;button.disabled=false;}
});

async function refreshMarketTrials(token){const target=document.getElementById('marketTrialReviews');if(!target)return;try{const rows=await OBIT.get('/api/admin/market/trials',{token});target.innerHTML=rows.map(r=>`<form class="card" data-trial-review="${r.id}" data-version="${r.version}"><h3>${escapeMarket(r.profile?.name||'Unsubmitted trial')}</h3><p>${escapeMarket(r.email)} · ${escapeMarket(r.phone)} · ${escapeMarket(r.status)} / ${escapeMarket(r.review_status)}</p><p>Existing cooperatives (private): ${escapeMarket(r.other_cooperatives||'Not supplied')} · Eligibility assistance requested: ${r.loan_interest?'Yes':'No'}</p><p>Trial start: ${r.starts_ms?escapeMarket(new Date(r.starts_ms).toISOString()):'Not started'} · Ends: ${r.expires_ms?escapeMarket(new Date(r.expires_ms).toISOString()):'Not set'}</p><p>${escapeMarket(r.profile?.description||'')}</p><p>${escapeMarket(r.profile?.location?Object.entries(r.profile.location).filter(([k])=>!['image_url','video_url','content_authorised'].includes(k)).map(([k,v])=>k+': '+v).join(' · '):'No submitted shop location')}</p>${r.profile?.location?.image_url?`<a href="${escapeMarket(r.profile.location.image_url)}" target="_blank" rel="noopener noreferrer">Review shop photo</a>`:''} ${r.profile?.location?.video_url?`<a href="${escapeMarket(r.profile.location.video_url)}" target="_blank" rel="noopener noreferrer">Review shop video</a>`:''}<ul>${(r.profile?.products||[]).map(p=>`<li>${escapeMarket(p.title)} · ${p.price_kobo?'₦'+(p.price_kobo/100).toLocaleString('en-NG'):'No price supplied'} · ${escapeMarket(p.description)} ${p.image_url?`<a href="${escapeMarket(p.image_url)}" target="_blank" rel="noopener noreferrer">Review goods photo</a>`:''}</li>`).join('')}</ul><label class="field">Decision<select name="decision"><option value="APPROVED">Approve / publish</option><option value="REJECTED">Reject</option><option value="SUSPENDED">Suspend</option></select></label><label><input name="locationVerified" type="checkbox" ${r.location_verified?'checked':''}> I checked the shop location.</label><label class="field">Active membership ID to link (optional)<input name="memberId" type="number" min="1" value="${r.converted_member_id||''}"></label><label class="field">Private verification evidence and review note<textarea name="note" minlength="10" maxlength="1000" required rows="3">${escapeMarket(r.review_note)}</textarea></label><button type="submit" class="btn">Save trial review</button><p role="status"></p></form>`).join('')||'<p>No trial sellers registered.</p>';for(const f of target.querySelectorAll('[data-trial-review]'))f.addEventListener('submit',async e=>{e.preventDefault();const button=f.querySelector('button[type=submit]');button.disabled=true;try{await OBIT.post('/api/admin/market/trials/'+f.dataset.trialReview+'/review',{version:Number(f.dataset.version),status:f.elements.decision.value,location_verified:f.elements.locationVerified.checked,member_id:f.elements.memberId.value||undefined,review_note:f.elements.note.value},{token});await refreshMarketTrials(token);}catch(err){f.querySelector('[role=status]').textContent=err.message;button.disabled=false;}});}catch{target.textContent='Trial reviews could not be loaded. Refresh to retry.';}}
