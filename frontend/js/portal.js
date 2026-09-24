// portal.js

function showAlert(message, type = 'error') {
  document.getElementById('alertBox').innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}
function clearAlert() { const el = document.getElementById('alertBox'); if (el) el.innerHTML = ''; }

document.getElementById('tabLogin').addEventListener('click', () => switchTab('login'));
document.getElementById('tabSetup').addEventListener('click', () => switchTab('setup'));
function switchTab(which) {
  document.getElementById('tabLogin').classList.toggle('active', which === 'login');
  document.getElementById('tabSetup').classList.toggle('active', which === 'setup');
  document.getElementById('loginForm').style.display = which === 'login' ? '' : 'none';
  document.getElementById('setupForm').style.display = which === 'setup' ? '' : 'none';
  clearAlert();
}

document.getElementById('btnRequestSetup').addEventListener('click', async () => {
  clearAlert();
  const identifier = document.getElementById('setupIdentifier').value.trim();
  if (!identifier) return showAlert('Enter your registered email address.');
  try {
    const res = await OBIT.post('/api/auth/request-portal-setup', { identifier });
    document.getElementById('setupUserId').value = res.user_id;
    showAlert(res.message || 'Verification code sent. Check your email.', 'success');
  } catch (err) { showAlert(err.message); }
});

document.getElementById('btnSetPassword').addEventListener('click', async () => {
  clearAlert();
  const user_id = Number(document.getElementById('setupUserId').value);
  const setup_code = document.getElementById('setupCode').value;
  const password = document.getElementById('setupPassword').value;
  if (!user_id || !setup_code || !password) return showAlert('Fill in all fields.');
  try {
    await OBIT.post('/api/auth/set-password', { user_id, setup_code, password });
    showAlert('Password set. You can log in now.', 'success');
    switchTab('login');
  } catch (err) { showAlert(err.message); }
});

document.getElementById('btnLogin').addEventListener('click', async () => {
  clearAlert();
  const identifier = document.getElementById('loginIdentifier').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await OBIT.post('/api/auth/login', { identifier, password });
    if (res.role !== 'member') throw new Error('This login is for members. Staff should use the admin console.');
    OBIT.saveSession('member', res.token);
    await loadDashboard();
  } catch (err) { showAlert(err.message); }
});

document.getElementById('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const token = OBIT.getSession('member');
  try { if (token) await OBIT.post('/api/auth/logout', {}, { token }); } catch {}
  OBIT.clearSession('member');
  document.getElementById('loggedInView').style.display = 'none';
  document.getElementById('loggedOutView').style.display = '';
  document.getElementById('logoutLink').style.display = 'none';
});

function badge(status) {
  const cls = ['ACTIVE', 'KYC_VERIFIED', 'PAYMENT_VERIFIED'].includes(status) ? 'ok'
    : status && status.includes('FAILED') ? 'fail'
    : status ? 'pending' : 'neutral';
  return `<span class="status-badge ${cls}">${status || 'N/A'}</span>`;
}

async function loadDashboard() {
  const token = OBIT.getSession('member');
  if (!token) return;
  try {
    const membership = await OBIT.get('/api/me/membership', { token });
    document.getElementById('digitalMemberName').textContent = membership.full_legal_name || 'Member';
    document.getElementById('digitalMemberId').textContent = membership.digital_membership_id || membership.member_code;
    document.getElementById('digitalMemberStatus').innerHTML = badge(membership.status);
    document.getElementById('membershipSummary').innerHTML = `
      <dt>Member ID</dt><dd><span class="member-code">${membership.member_code}</span></dd>
      <dt>Name</dt><dd>${membership.full_legal_name || '—'}</dd>
      <dt>Status</dt><dd>${badge(membership.status)}</dd>
      <dt>KYC</dt><dd>${badge(membership.kyc_status)}</dd>
      <dt>Membership fee</dt><dd>${badge(membership.membership_payment?.status)} ₦${membership.membership_payment?.amount ?? '—'}</dd>
      <dt>WhatsApp community</dt><dd>${membership.community_onboarding.whatsapp_joined ? 'Joined' : 'Not yet joined'}</dd>
      <dt>Orientation</dt><dd>${membership.community_onboarding.orientation_completed ? 'Completed' : 'Pending'}</dd>
    `;

    document.getElementById('statusTile').innerHTML = badge(membership.status);
    const statement = await OBIT.get('/api/me/statement', { token });
    document.getElementById('balanceTile').textContent = `₦${Number(statement.balance || 0).toLocaleString()}`;
    document.getElementById('statementSummary').innerHTML = `
      <dt>Balance</dt><dd>₦${statement.balance} ${statement.currency}</dd>
      <dt>Note</dt><dd class="muted-note" style="font-weight:400">${statement.sandbox_note || ''}</dd>
    `;

    await refreshPlans(token);
    await refreshTransactions(token);
    await refreshReceipts(token);
    await refreshWithdrawals(token);
    await refreshBankAccounts(token);
    await loadBanks(token);

    document.getElementById('loggedOutView').style.display = 'none';
    document.getElementById('loggedInView').style.display = '';
    document.getElementById('logoutLink').style.display = '';
  } catch (err) {
    OBIT.clearSession('member');
    showAlert(err.message);
  }
}

async function refreshReceipts(token) {
  const rows = await OBIT.get('/api/me/receipts', { token });
  document.getElementById('receiptsBody').innerHTML = rows.length
    ? rows.map(r => `<tr><td><span class="member-code">${r.receipt_number}</span></td><td>${r.issued_at || '—'}</td><td>₦${Number(r.amount).toLocaleString()}</td><td>${badge(r.status)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted-note">No receipts yet.</td></tr>';
}

async function loadBanks(token) {
  const select = document.getElementById('verifyBank');
  if (select.dataset.loaded) return;
  const banks = await OBIT.get('/api/me/banks', { token });
  select.innerHTML = '<option value="">Select bank</option>' + banks.map(b => `<option value="${b.code}" data-name="${b.name}">${b.name}</option>`).join('');
  select.dataset.loaded = '1';
}

async function refreshBankAccounts(token) {
  const rows = await OBIT.get('/api/me/bank-accounts', { token });
  document.getElementById('withdrawBankAccount').innerHTML = '<option value="">Select verified account</option>' +
    rows.map(r => `<option value="${r.id}">${r.bank_name} • ${r.account_number_masked || r.account_number} • ${r.account_name}</option>`).join('');
}

async function refreshWithdrawals(token) {
  const rows = await OBIT.get('/api/me/withdrawals', { token });
  document.getElementById('withdrawalsBody').innerHTML = rows.length
    ? rows.map(r => `<tr><td>${r.created_at || '—'}</td><td>₦${Number(r.amount).toLocaleString()}</td><td>${r.bank_name}</td><td>${badge(r.status)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted-note">No withdrawal requests.</td></tr>';
}

async function refreshTransactions(token) {
  const txns = await OBIT.get('/api/me/transactions', { token });
  const body = document.getElementById('transactionsBody');
  body.innerHTML = txns.length
    ? txns.map((t) => `<tr><td>${t.created_at || '—'}</td><td>${t.type || t.transaction_type || 'Transaction'}</td><td>₦${Number(t.amount || 0).toLocaleString()}</td><td>${badge(t.status)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted-note">No financial transactions yet.</td></tr>`;
}

async function refreshPlans(token) {
  const plans = await OBIT.get('/api/me/contribution-plans', { token });
  const current = plans.filter(p => p.status !== 'CLOSED');
  document.getElementById('plansBody').innerHTML = current.length
    ? current.map((p) => `<tr><td>₦${p.amount}</td><td>${p.frequency}</td><td>${p.purpose}</td><td>${badge(p.status)}</td><td>${p.status === 'PROPOSED' ? `<button type="button" class="btn btn-ghost" data-cancel-plan="${Number(p.id)}">Cancel</button>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted-note">No contribution plans proposed yet.</td></tr>`;
}

document.getElementById('plansBody').addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-cancel-plan]');
  if (!btn || btn.disabled || !confirm('Cancel this proposed savings goal? No money will move.')) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  const box = document.getElementById('planAlert');
  try {
    await OBIT.patch(`/api/me/contribution-plans/${btn.dataset.cancelPlan}/cancel`, {}, { token: OBIT.getSession('member') });
    box.textContent = 'Plan cancelled. No money was moved.';
    await refreshPlans(OBIT.getSession('member'));
  } catch (err) {
    box.textContent = `Could not cancel the plan: ${err.message}`;
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
});

document.getElementById('btnSaveNow').addEventListener('click', async () => {
  const token = OBIT.getSession('member');
  const amount = Number(document.getElementById('saveAmount').value);
  const box = document.getElementById('savingsAlert');
  box.innerHTML = '';
  if (!Number.isFinite(amount) || amount < 100) {
    box.innerHTML = '<div class="alert alert-error">Enter at least ₦100.</div>';
    return;
  }
  const btn = document.getElementById('btnSaveNow');
  btn.disabled = true;
  btn.textContent = 'Opening secure checkout…';
  try {
    const res = await OBIT.post('/api/payments/contributions/initialize', { amount }, { token });
    if (!res.checkout_url || !res.checkout_url.startsWith('https://')) throw new Error('Secure checkout could not be created.');
    window.location.href = res.checkout_url;
  } catch (err) {
    box.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
    btn.disabled = false;
    btn.textContent = 'Save Now with Paystack';
  }
});

let bankVerifyTimer;
let lastBankVerification = '';

async function verifyBankAccountAutomatically() {
  const token = OBIT.getSession('member');
  const select = document.getElementById('verifyBank');
  const input = document.getElementById('verifyAccountNumber');
  const option = select.options[select.selectedIndex];
  const box = document.getElementById('bankVerifyAlert');
  const accountNumber = input.value.trim();

  if (!select.value || !/^\d{10}$/.test(accountNumber)) {
    box.innerHTML = '';
    return;
  }
  const fingerprint = select.value + ':' + accountNumber;
  if (fingerprint === lastBankVerification) return;
  box.innerHTML = '<div class="muted-note">Verifying account…</div>';
  try {
    const r = await OBIT.post('/api/me/bank-accounts/verify', {
      bank_code: select.value, bank_name: option?.dataset?.name || option?.text || '',
      account_number: accountNumber
    }, { token });
    lastBankVerification = fingerprint;
    box.innerHTML = `<div class="alert alert-success">✓ Verified: ${r.account_name} • ${r.bank_name} • ${r.account_number}</div>`;
    await refreshBankAccounts(token);
    document.getElementById('withdrawBankAccount').value = String(r.id);
  } catch (err) {
    lastBankVerification = '';
    box.innerHTML = `<div class="alert alert-error">${err.message}</div>`;
  }
}

document.getElementById('verifyAccountNumber').addEventListener('input', () => {
  clearTimeout(bankVerifyTimer);
  const digits = document.getElementById('verifyAccountNumber').value.replace(/\D/g, '').slice(0, 10);
  document.getElementById('verifyAccountNumber').value = digits;
  if (digits.length === 10) bankVerifyTimer = setTimeout(verifyBankAccountAutomatically, 350);
  else document.getElementById('bankVerifyAlert').innerHTML = '';
});
document.getElementById('verifyBank').addEventListener('change', () => {
  lastBankVerification = '';
  if (document.getElementById('verifyAccountNumber').value.length === 10) verifyBankAccountAutomatically();
});

document.getElementById('btnWithdraw').addEventListener('click', async () => {
  const token = OBIT.getSession('member');
  const payload = {
    amount: Number(document.getElementById('withdrawAmount').value),
    bank_account_id: Number(document.getElementById('withdrawBankAccount').value)
  };
  const box = document.getElementById('withdrawAlert');
  try {
    const r = await OBIT.post('/api/me/withdrawals', payload, { token });
    box.innerHTML = `<div class="alert alert-success">Withdrawal request submitted. Status: ${r.status}.</div>`;
    await refreshWithdrawals(token);
  } catch (err) { box.innerHTML = `<div class="alert alert-error">${err.message}</div>`; }
});

document.getElementById('btnCreatePlan').addEventListener('click', async () => {
  const btn = document.getElementById('btnCreatePlan');
  if (btn.disabled) return;
  const token = OBIT.getSession('member');
  const amountInput = document.getElementById('planAmount');
  const amount = Number(amountInput.value);
  const frequency = document.getElementById('planFrequency').value;
  const purpose = document.getElementById('planPurpose').value;
  const targetInput = document.getElementById('planTarget');
  const target_amount = targetInput.value ? Number(targetInput.value) : undefined;
  const box = document.getElementById('planAlert');
  box.textContent = '';
  if (!amountInput.value || !Number.isFinite(amount) || amount <= 0) {
    box.textContent = 'Enter an amount greater than zero.';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Saving plan…';
  box.textContent = 'Saving your plan…';
  try {
    await OBIT.post('/api/me/contribution-plans', { amount, frequency, purpose, target_amount }, { token });
    amountInput.value = '';
    targetInput.value = '';
    box.textContent = 'Plan saved. No money was collected.';
    await refreshPlans(token);
  } catch (err) {
    if (amountInput.value) box.textContent = `Plan could not be saved: ${err.message}`;
    else box.textContent = 'Plan saved, but the list could not be refreshed. Reload the page to see it.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Plan';
  }
});

// A page refresh must not briefly expose the login form while an existing
// authenticated session is being restored.
if (OBIT.getSession('member')) {
  document.getElementById('loggedOutView').style.display = 'none';
  document.getElementById('loggedInView').style.display = '';
  loadDashboard();
}
