const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/apply.js'), 'utf8');
// Execute the real status/restore/verify functions with a minimal synthetic DOM.
const code = source.slice(source.indexOf('function renderKycStatus('), source.indexOf('async function initPayment('))
  + source.slice(source.indexOf('async function restoreExistingApplication('), source.indexOf('function showApplicationResume('));
const note = 'No matching identity record was returned. Your application is still awaiting verification. This product cannot be retried within 24 hours. Contact support if you need help.';
function setup(message = note, restart = false) {
  const nodes = {}, steps = [], alerts = [], calls = [];
  const node = id => nodes[id] ||= { style: {}, innerHTML: '', value: '', disabled: false };
  node('kycIdType').value = 'nin';
  node('kycIdNumber').value = '11111111111';
  const check = { status: 'KYC_PENDING', session_ref: 'youverify_live_synthetic', environment: 'live', message, restart_required: restart };
  const context = vm.createContext({
    document: { getElementById: node },
    window: { ObitLocations: { restore() {} } },
    state: { applicationId: 1, kycSessionRef: check.session_ref },
    STATUS_TO_STEP: { KYC_PENDING: 'kyc' }, STEPS: ['profile', 'review', 'kyc', 'payment', 'done'],
    fieldIds: () => [], restoreInterestChoices() {}, fillReviewSummary() {}, showKycProvider() {},
    goToStep: step => steps.push(step), clearAlert() {}, showAlert: text => alerts.push(text), showApplicationResume() {},
    localStorage: { setItem() {}, removeItem() {} },
    setTimeout: callback => callback(),
    OBIT: {
      async get(url) { calls.push(['get', url]); return url.includes('/api/kyc/') ? check : { status: 'KYC_PENDING' }; },
      async post(url) { calls.push(['post', url]); return check; },
    },
  });
  vm.runInContext(code, context);
  return { nodes, steps, alerts, calls, restore: () => context.restoreExistingApplication(), verify: () => context.verifyYouverifyKyc(), simulate: () => context.simulateKycVerified() };
}
test('reloading a pending application renders its saved not-found note without dispatch or payment advance', async () => {
  const page = setup();
  await page.restore();
  assert.match(page.nodes.kycStatusBox.innerHTML, /KYC_PENDING/);
  assert.ok(page.nodes.kycStatusBox.innerHTML.includes(note));
  assert.deepEqual(page.steps, ['kyc']);
  assert.equal(page.calls.filter(([method]) => method === 'post').length, 0);
});
test('fresh terminal response clears identity input, displays pending message and does not advance', async () => {
  const page = setup();
  await page.verify();
  assert.ok(page.nodes.kycStatusBox.innerHTML.includes(note));
  assert.equal(page.nodes.kycIdNumber.value, '');
  assert.equal(page.nodes.btnVerifyYouverify.disabled, false);
  assert.deepEqual(page.alerts, [note]);
  assert.deepEqual(page.steps, []);
  assert.equal(page.calls.length, 1);
});
test('generic pending and retired-provider restart messages retain their existing behavior', async () => {
  // Missing server note should not produce an undefined string or false verdict.
  const noNote = setup('');
  await noNote.restore();
  assert.match(noNote.nodes.kycStatusBox.innerHTML, /KYC_PENDING/);
  assert.doesNotMatch(noNote.nodes.kycStatusBox.innerHTML, /undefined|verified|not found/);
  const retired = setup(note, true);
  await retired.restore();
  assert.match(retired.nodes.kycStatusBox.innerHTML, /Start a new Youverify verification session/);
  assert.equal(retired.nodes.btnVerifyYouverify.style.display, 'none');
  assert.equal(retired.nodes.btnStartKyc.style.display, '');
});
