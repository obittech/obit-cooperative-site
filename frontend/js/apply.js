// apply.js — walks a visitor through:
// LEAD/APPLICATION_STARTED -> APPLICATION_SUBMITTED -> KYC_PENDING/VERIFIED
// -> PAYMENT_PENDING/VERIFIED -> UNDER_REVIEW
// exactly mirroring the backend's member_applications.status column, so this
// page is always just reflecting server state, never inventing its own.

const STEPS = ['profile', 'review', 'kyc', 'payment', 'done'];
const STATUS_TO_STEP = {
  LEAD: 'profile', APPLICATION_STARTED: 'profile', NEEDS_INFORMATION: 'profile',
  APPLICATION_SUBMITTED: 'kyc',
  KYC_PENDING: 'kyc', KYC_FAILED: 'kyc',
  KYC_VERIFIED: 'payment', PAYMENT_FAILED: 'payment', PAYMENT_PENDING: 'payment',
  PAYMENT_VERIFIED: 'done', UNDER_REVIEW: 'done', ACTIVE: 'done',
  REJECTED: 'review', SUSPENDED: 'done', CLOSED: 'done',
};

// Allow a clean test/application start without manually clearing browser storage.
// Example: apply.html?new=1
const launchParams = new URLSearchParams(window.location.search);
if (launchParams.has('new')) {
  localStorage.removeItem('obit_application_id');
  localStorage.removeItem('obit_kyc_session_ref');
  localStorage.removeItem('obit_payment_reference');
}

const state = {
  applicationId: localStorage.getItem('obit_application_id') || null,
  application: null,
  kycSessionRef: localStorage.getItem('obit_kyc_session_ref') || null,
};

function showAlert(message, type = 'error') {
  document.getElementById('alertBox').innerHTML =
    `<div class="alert alert-${type === 'error' ? 'error' : 'success'}">${message}</div>`;
}
function clearAlert() { document.getElementById('alertBox').innerHTML = ''; }

function goToStep(stepName) {
  STEPS.forEach((s) => {
    document.getElementById(`panel-${s}`).style.display = s === stepName ? '' : 'none';
  });
  const idx = STEPS.indexOf(stepName);
  document.querySelectorAll('#stepper .step').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', i < idx);
  });
}

function fieldIds() {
  return [
    'full_legal_name', 'date_of_birth', 'gender', 'membership_type', 'phone', 'whatsapp',
    'email', 'occupation_category', 'state', 'lga', 'address', 'next_of_kin_name',
    'next_of_kin_phone', 'intended_savings_amount', 'intended_savings_frequency',
  ];
}

function collectProfileFields() {
  const data = {};
  fieldIds().forEach((id) => {
    const el = document.getElementById(id);
    if (!el.value) return;
    data[id] = el.type === 'number' ? Number(el.value) : el.value;
  });
  const interests = Array.from(document.getElementById('interests').selectedOptions).map((o) => o.value);
  if (interests.length) data.interests = interests;
  return data;
}

function fillReviewSummary(app) {
  const dl = document.getElementById('reviewSummary');
  const rows = [
    ['Name', app.full_legal_name], ['Phone', app.phone], ['Email', app.email],
    ['Membership type', app.membership_type], ['State', app.state], ['LGA', app.lga],
    ['Address', app.address], ['Occupation', app.occupation_category],
  ];
  dl.innerHTML = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

async function saveProfileAndContinue() {
  clearAlert();
  const required = ['full_legal_name', 'phone', 'email', 'address', 'state', 'membership_type'];
  const missing = required.filter((id) => !document.getElementById(id).value);
  if (missing.length) return showAlert('Please fill in all required fields before continuing.');

  try {
    if (!state.applicationId) {
      const params = new URLSearchParams(window.location.search);
      const created = await OBIT.post('/api/applications', {
        referral_source: params.get('ref') || undefined,
        campaign: params.get('campaign') || undefined,
      });
      state.applicationId = created.id;
      localStorage.setItem('obit_application_id', created.id);
    }
    const updated = await OBIT.patch(`/api/applications/${state.applicationId}`, collectProfileFields());
    state.application = updated;
    fillReviewSummary(updated);
    goToStep('review');
  } catch (err) {
    showAlert(err.message);
  }
}

async function submitApplication() {
  clearAlert();
  const consents = {
    terms: document.getElementById('consent_terms').checked,
    privacy: document.getElementById('consent_privacy').checked,
    marketing: document.getElementById('consent_marketing').checked,
  };
  if (!consents.terms || !consents.privacy) return showAlert('Terms and Privacy consent are both required.');

  try {
    const updated = await OBIT.post(`/api/applications/${state.applicationId}/submit`, { consents });
    state.application = updated;
    goToStep('kyc');
  } catch (err) {
    showAlert(err.message);
  }
}

async function startKyc() {
  clearAlert();
  try {
    const session = await OBIT.post('/api/kyc/session', { application_id: state.applicationId });
    state.kycSessionRef = session.session_ref;
    localStorage.setItem('obit_kyc_session_ref', session.session_ref);
    renderKycStatus('KYC_PENDING', session.message);
    document.getElementById('kycIdentityFields').style.display = '';
    document.getElementById('btnVerifyDojah').style.display = '';
    document.getElementById('btnStartKyc').style.display = 'none';
  } catch (err) {
    showAlert(err.message);
  }
}

function renderKycStatus(status, note) {
  const badgeClass = status === 'KYC_VERIFIED' ? 'ok' : status === 'KYC_FAILED' ? 'fail' : 'pending';
  document.getElementById('kycStatusBox').innerHTML =
    `<p><span class="status-badge ${badgeClass}">${status}</span></p>` +
    (note ? `<p class="muted-note">${note}</p>` : '');
}

async function verifyDojahKyc() {
  clearAlert();
  if (!state.kycSessionRef) return showAlert('Start identity verification first.');

  const type = document.getElementById('kycIdType').value;
  const input = document.getElementById('kycIdNumber');
  const idNumber = input.value.trim();

  if (!/^[0-9]{11}$/.test(idNumber)) {
    return showAlert('Enter the 11-digit Dojah sandbox NIN or BVN test number.');
  }

  const button = document.getElementById('btnVerifyDojah');
  button.disabled = true;
  button.textContent = 'Verifying…';

  try {
    const result = await OBIT.post(`/api/kyc/session/${state.kycSessionRef}/verify`, {
      type,
      id_number: idNumber,
    });
    input.value = '';
    renderKycStatus(result.status, result.message);

    if (result.status === 'KYC_VERIFIED') {
      state.application = await OBIT.get(`/api/applications/${state.applicationId}`);
      setTimeout(() => goToStep('payment'), 700);
    } else {
      showAlert(result.message || 'Identity verification was not successful.');
    }
  } catch (err) {
    input.value = '';
    showAlert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Verify with Dojah';
  }
}

async function simulateKycVerified() {
  clearAlert();
  try {
    await OBIT.post(`/api/kyc/session/${state.kycSessionRef}/simulate`, { outcome: 'VERIFIED' });
    const check = await OBIT.get(`/api/kyc/${state.kycSessionRef}/status`);
    renderKycStatus(check.status);
    if (check.status === 'KYC_VERIFIED') {
      setTimeout(() => goToStep('payment'), 700);
    }
  } catch (err) {
    showAlert(err.message);
  }
}

async function initPayment() {
  clearAlert();
  const provider = document.getElementById('providerSelect').value;
  try {
    const payment = await OBIT.post('/api/payments/membership/initialize', {
      application_id: state.applicationId, provider,
    });
    localStorage.setItem('obit_payment_reference', payment.reference);
    document.getElementById('paymentStatusBox').innerHTML = `
      <p><span class="status-badge pending">PAYMENT_PENDING</span></p>
      <p class="muted-note">Reference: <span class="member-code">${payment.reference}</span> — ₦${payment.amount}</p>
      ${payment.sandbox_note ? `<div class="sandbox-banner">${payment.sandbox_note}<br><br>To test the full flow locally, run on the backend:<br><code>node scripts/simulate-webhook.js ${payment.reference} ${payment.amount} success</code></div>` : `<p><a class="btn btn-primary" href="${payment.checkout_url}" target="_blank" rel="noopener">Continue to secure checkout</a></p>`}
      <button class="btn btn-secondary" id="btnCheckPayment" style="margin-top:12px">I've paid — check status</button>
    `;
    document.getElementById('btnCheckPayment').addEventListener('click', pollApplicationStatus);
  } catch (err) {
    showAlert(err.message);
  }
}

async function pollApplicationStatus() {
  clearAlert();
  try {
    const app = await OBIT.get(`/api/applications/${state.applicationId}`);
    state.application = app;
    const target = STATUS_TO_STEP[app.status] || 'profile';
    if (target === 'done') {
      goToStep('done');
    } else if (app.status === 'PAYMENT_FAILED') {
      showAlert('Payment was not verified. Please try again.');
    } else {
      showAlert('Payment not verified yet. This updates automatically once the provider webhook fires.', 'success');
    }
  } catch (err) {
    showAlert(err.message);
  }
}

async function restoreExistingApplication() {
  if (!state.applicationId) { goToStep('profile'); return; }
  try {
    const app = await OBIT.get(`/api/applications/${state.applicationId}`);
    state.application = app;
    fieldIds().forEach((id) => {
      const el = document.getElementById(id);
      if (app[id] !== undefined && app[id] !== null) el.value = app[id];
    });
    fillReviewSummary(app);
    const target = STATUS_TO_STEP[app.status] || 'profile';
    goToStep(target);
    if (target === 'kyc' && state.kycSessionRef) {
      const check = await OBIT.get(`/api/kyc/${state.kycSessionRef}/status`);
      renderKycStatus(check.status);
      if (check.status !== 'KYC_VERIFIED') {
        document.getElementById('kycIdentityFields').style.display = '';
        document.getElementById('btnVerifyDojah').style.display = '';
        document.getElementById('btnStartKyc').style.display = 'none';
      }
    }
  } catch {
    // Application id is stale (e.g. different backend/DB) — start fresh.
    localStorage.removeItem('obit_application_id');
    state.applicationId = null;
    goToStep('profile');
  }
}

document.getElementById('btnStartOrSave').addEventListener('click', saveProfileAndContinue);
document.getElementById('btnBackToProfile').addEventListener('click', () => goToStep('profile'));
document.getElementById('btnSubmitApplication').addEventListener('click', submitApplication);
document.getElementById('btnStartKyc').addEventListener('click', startKyc);
document.getElementById('btnVerifyDojah').addEventListener('click', verifyDojahKyc);
document.getElementById('btnInitPayment').addEventListener('click', initPayment);

restoreExistingApplication();
