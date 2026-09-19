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
  const identifier = document.getElementById('loginIdentifier').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await OBIT.post('/api/auth/login', { identifier, password });
    if (!['staff', 'admin'].includes(res.role)) throw new Error('This login is for staff/admin accounts only.');
    if (res.mfa_required) {
      const code = prompt('A 6-digit Admin login code was sent to your authorized email. Enter it here.');
      if (code === null) return;
      const verified = await OBIT.post('/api/auth/admin-mfa', { user_id: res.user_id, code: code.trim() });
      OBIT.saveSession('staff', verified.token);
    } else {
      OBIT.saveSession('staff', res.token);
    }
    await loadAll();
  } catch (err) { showAlert(err.message); }
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
    ['queue', 'withdrawals', 'reconciliation', 'audit'].forEach((name) => {
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
