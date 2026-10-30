// apply.js — walks a visitor through:
// LEAD/APPLICATION_STARTED -> APPLICATION_SUBMITTED -> KYC_PENDING/VERIFIED
// -> PAYMENT_PENDING/VERIFIED -> savings draft while membership is under review
// exactly mirroring the backend's member_applications.status column, so this
// page is always just reflecting server state, never inventing its own.

const STEPS = ['profile', 'review', 'kyc', 'payment', 'done'];
const MEMBERSHIP_PATHS = {
  salary: { label: 'Salary earner', membership_type: 'Individual', occupation_category: 'Salary Earner', interests: ['Savings'] },
  msme: { label: 'Trader / MSME', membership_type: 'MSME / Business', occupation_category: 'MSME Owner', interests: ['Business Support'] },
  artisan: { label: 'Artisan / professional', membership_type: 'Individual', occupation_category: 'Artisan', interests: ['Training', 'Business Support'] },
  transport: { label: 'Transport worker', membership_type: 'Individual', occupation_category: 'Driver', interests: ['Savings'] },
  farmer: { label: 'Farmer / agribusiness', membership_type: 'MSME / Business', occupation_category: 'Farmer / Agribusiness', interests: ['Agriculture'] },
  guided: { label: 'Guided membership', membership_type: 'Individual', occupation_category: '', interests: [] },
};

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

  // The clean-start flag is one-time only. Remove it immediately so a refresh
  // restores the newly created application instead of clearing it again.
  launchParams.delete('new');
  const cleanQuery = launchParams.toString();
  const cleanUrl = window.location.pathname + (cleanQuery ? `?${cleanQuery}` : '') + window.location.hash;
  window.history.replaceState({}, document.title, cleanUrl);
}

function applyMembershipPathPreset() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('path');
  const preset = MEMBERSHIP_PATHS[key];
  if (!preset || localStorage.getItem('obit_application_id')) return;
  const type = document.getElementById('membership_type');
  const occupation = document.getElementById('occupation_category');
  if (type && preset.membership_type) type.value = preset.membership_type;
  if (occupation && preset.occupation_category) occupation.value = preset.occupation_category;
  setInterestChoices(preset.interests);
  const alert = document.getElementById('alertBox');
  if (alert) alert.innerHTML = `<div class="alert alert-success">Selected path: <strong>${preset.label}</strong>. We have pre-filled the closest membership options. You can change them before continuing.</div>`;
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
  if (stepName === 'done' && state.application) renderSavingsStep();
}

function savingsDraftKey() { return `obit_savings_draft_${state.applicationId}`; }
function renderSavingsStep() {
  const active = state.application.status === 'ACTIVE';
  document.getElementById('savingsReviewNote').textContent = active
    ? 'Your membership is active. Prepare a savings goal here, then log in to your Member Portal to review and save it.'
    : 'Your membership fee has been confirmed. Your membership is under review. You can prepare a savings goal now and submit it after your membership is approved.';
  try {
    const draft = JSON.parse(localStorage.getItem(savingsDraftKey()) || 'null');
    if (!draft) return;
    document.getElementById('draftPlanAmount').value = draft.amount;
    document.getElementById('draftPlanFrequency').value = draft.frequency;
    document.getElementById('draftPlanPurpose').value = draft.purpose;
    document.getElementById('draftPlanTarget').value = draft.target_amount || '';
    document.getElementById('savingsDraftStatus').textContent = 'Your plan draft is saved on this device.';
  } catch { /* Ignore an invalid local draft. */ }
}
function saveSavingsDraft() {
  const status = document.getElementById('savingsDraftStatus');
  if (!state.application || !['PAYMENT_VERIFIED', 'UNDER_REVIEW', 'ACTIVE'].includes(state.application.status)) {
    status.textContent = 'Wait for your membership fee to be confirmed before planning savings.';
    return;
  }
  const amount = Number(document.getElementById('draftPlanAmount').value);
  const targetValue = document.getElementById('draftPlanTarget').value;
  const target_amount = targetValue ? Number(targetValue) : null;
  if (!Number.isFinite(amount) || amount <= 0 || (targetValue && (!Number.isFinite(target_amount) || target_amount <= 0))) {
    status.textContent = 'Enter a valid contribution amount and target amount.';
    return;
  }
  const draft = {
    amount,
    frequency: document.getElementById('draftPlanFrequency').value,
    purpose: document.getElementById('draftPlanPurpose').value,
    target_amount,
  };
  localStorage.setItem(savingsDraftKey(), JSON.stringify(draft));
  status.textContent = 'Draft saved on this device. After approval, log in to your portal to review and save it. No money was collected.';
}

function fieldIds() {
  return [
    'full_legal_name', 'date_of_birth', 'gender', 'membership_type', 'phone', 'whatsapp',
    'email', 'occupation_category', 'state', 'lga', 'address', 'next_of_kin_name',
    'next_of_kin_phone',
  ];
}

function setInterestChoices(values) {
  document.querySelectorAll('#interests input[type="checkbox"]').forEach(input => {
    input.checked = Array.isArray(values) && values.includes(input.value);
  });
}

function restoreInterestChoices(app) {
  let values = app.interests_json;
  try { if (typeof values === 'string') values = JSON.parse(values); } catch { values = []; }
  setInterestChoices(values);
}

function collectProfileFields() {
  const data = {};
  fieldIds().forEach((id) => {
    const el = document.getElementById(id);
    if (!el.value) return;
    data[id] = el.type === 'number' ? Number(el.value) : el.value;
  });
  data.interests = Array.from(document.querySelectorAll('#interests input[type="checkbox"]:checked')).map(input => input.value);
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
  const required = ['full_legal_name', 'phone', 'email', 'address', 'state', 'lga', 'membership_type'];
  const missing = required.filter((id) => !document.getElementById(id).value);
  if (missing.length) return showAlert('Please fill in all required fields before continuing.');

  try {
    if (!state.applicationId) {
      const params = new URLSearchParams(window.location.search);
      const created = await OBIT.post('/api/applications', {
        referral_source: params.get('ref') || undefined,
        campaign: params.get('campaign') || (params.get('path') ? `membership-path:${params.get('path')}` : undefined),
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
    showKycProvider(session);
    state.kycSessionRef = session.session_ref;
    localStorage.setItem('obit_kyc_session_ref', session.session_ref);
    renderKycStatus('KYC_PENDING', session.message);
    document.getElementById('kycIdentityFields').style.display = '';
    document.getElementById('btnVerifyYouverify').style.display = '';
    document.getElementById('btnStartKyc').style.display = 'none';
  } catch (err) {
    showAlert(err.message);
  }
}

function showKycProvider(session) {
  const name = 'Youverify';
  document.getElementById('modeBanner').textContent = session.environment === 'live'
    ? `Identity verification is provided by ${name}.`
    : `${name} sandbox verification. Use synthetic test data only.`;
}

function renderKycStatus(status, note) {
  const badgeClass = status === 'KYC_VERIFIED' ? 'ok' : status === 'KYC_FAILED' ? 'fail' : 'pending';
  document.getElementById('kycStatusBox').innerHTML =
    `<p><span class="status-badge ${badgeClass}">${status}</span></p>` +
    (note ? `<p class="muted-note">${note}</p>` : '');
}

async function verifyYouverifyKyc() {
  clearAlert();
  if (!state.kycSessionRef) return showAlert('Start identity verification first.');

  const type = document.getElementById('kycIdType').value;
  const input = document.getElementById('kycIdNumber');
  const idNumber = input.value.trim();

  if (!/^[0-9]{11}$/.test(idNumber)) {
    return showAlert('Enter a valid 11-digit NIN or BVN. In sandbox mode, use Youverify synthetic test data.');
  }

  const button = document.getElementById('btnVerifyYouverify');
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
      const diagnostic = result.sandbox_match
        ? ` Sandbox check: name ${result.sandbox_match.name_match ? 'matched' : 'did not match'}, date of birth ${result.sandbox_match.dob_match ? 'matched' : 'did not match'}.`
        : '';
      showAlert((result.message || 'Identity verification was not successful.') + diagnostic);
    }
  } catch (err) {
    input.value = '';
    showAlert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Verify with Youverify';
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
      if (!['state', 'lga'].includes(id) && app[id] !== undefined && app[id] !== null) el.value = app[id];
    });
    window.ObitLocations.restore(document.getElementById('state'), document.getElementById('lga'), app.state, app.lga);
    restoreInterestChoices(app);
    fillReviewSummary(app);
    const target = STATUS_TO_STEP[app.status] || 'profile';
    goToStep(target);
    if (target === 'kyc' && state.kycSessionRef) {
      const check = await OBIT.get(`/api/kyc/${state.kycSessionRef}/status`);
      showKycProvider(check);
      renderKycStatus(check.status);
      if (check.restart_required) {
        state.kycSessionRef = null;
        localStorage.removeItem('obit_kyc_session_ref');
        document.getElementById('kycIdentityFields').style.display = 'none';
        document.getElementById('btnVerifyYouverify').style.display = 'none';
        document.getElementById('btnStartKyc').style.display = '';
        renderKycStatus('KYC_PENDING', 'Start a new Youverify verification session. Previous unresolved requests require support reconciliation first.');
      } else if (check.status !== 'KYC_VERIFIED') {
        document.getElementById('kycIdentityFields').style.display = '';
        document.getElementById('btnVerifyYouverify').style.display = '';
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
document.getElementById('btnVerifyYouverify').addEventListener('click', verifyYouverifyKyc);
document.getElementById('btnInitPayment').addEventListener('click', initPayment);
document.getElementById('btnSaveSavingsDraft').addEventListener('click', saveSavingsDraft);

async function initializeApplicationPage() {
  const stateSelect = document.getElementById('state');
  const lgaSelect = document.getElementById('lga');
  stateSelect.addEventListener('change', () => window.ObitLocations.fillLgas(stateSelect, lgaSelect));
  window.ObitLocations.fillLgas(stateSelect, lgaSelect);
  applyMembershipPathPreset();
  await restoreExistingApplication();

  const params = new URLSearchParams(window.location.search);
  if (params.get('payment') === 'return' && state.applicationId) {
    await pollApplicationStatus();
    params.delete('payment');
    const cleanQuery = params.toString();
    const cleanUrl = window.location.pathname + (cleanQuery ? `?${cleanQuery}` : '') + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

initializeApplicationPage();
