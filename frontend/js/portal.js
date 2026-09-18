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

document.getElementById('logoutLink').addEventListener('click', (e) => {
  e.preventDefault();
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
    document.getElementById('membershipSummary').innerHTML = `
      <dt>Member ID</dt><dd><span class="member-code">${membership.member_code}</span></dd>
      <dt>Name</dt><dd>${membership.full_legal_name || '—'}</dd>
      <dt>Status</dt><dd>${badge(membership.status)}</dd>
      <dt>KYC</dt><dd>${badge(membership.kyc_status)}</dd>
      <dt>Membership fee</dt><dd>${badge(membership.membership_payment?.status)} ₦${membership.membership_payment?.amount ?? '—'}</dd>
      <dt>WhatsApp community</dt><dd>${membership.community_onboarding.whatsapp_joined ? 'Joined' : 'Not yet joined'}</dd>
      <dt>Orientation</dt><dd>${membership.community_onboarding.orientation_completed ? 'Completed' : 'Pending'}</dd>
    `;

    const statement = await OBIT.get('/api/me/statement', { token });
    document.getElementById('statementSummary').innerHTML = `
      <dt>Balance</dt><dd>₦${statement.balance} ${statement.currency}</dd>
      <dt>Note</dt><dd class="muted-note" style="font-weight:400">${statement.sandbox_note || ''}</dd>
    `;

    await refreshPlans(token);

    document.getElementById('loggedOutView').style.display = 'none';
    document.getElementById('loggedInView').style.display = '';
    document.getElementById('logoutLink').style.display = '';
  } catch (err) {
    OBIT.clearSession('member');
    showAlert(err.message);
  }
}

async function refreshPlans(token) {
  const plans = await OBIT.get('/api/me/contribution-plans', { token });
  document.getElementById('plansBody').innerHTML = plans.length
    ? plans.map((p) => `<tr><td>₦${p.amount}</td><td>${p.frequency}</td><td>${p.purpose}</td><td>${badge(p.status)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted-note">No contribution plans proposed yet.</td></tr>`;
}

document.getElementById('btnCreatePlan').addEventListener('click', async () => {
  const token = OBIT.getSession('member');
  const amount = Number(document.getElementById('planAmount').value);
  const frequency = document.getElementById('planFrequency').value;
  const purpose = document.getElementById('planPurpose').value;
  const target_amount = document.getElementById('planTarget').value ? Number(document.getElementById('planTarget').value) : undefined;
  if (!amount) return alert('Enter an amount.');
  try {
    await OBIT.post('/api/me/contribution-plans', { amount, frequency, purpose, target_amount }, { token });
    await refreshPlans(token);
  } catch (err) { alert(err.message); }
});

if (OBIT.getSession('member')) loadDashboard();
