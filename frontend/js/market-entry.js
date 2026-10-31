const sellerForm = document.getElementById('sellerEntryForm');
const passwordStep = document.getElementById('sellerPasswordStep');
const continueButton = document.getElementById('sellerContinue');
document.getElementById('sellerChangeCode').addEventListener('click', () => {
  sellerForm.elements.password.value = '';
  passwordStep.hidden = true;
  passwordStep.disabled = true;
  sellerForm.elements.membership_code.readOnly = false;
  continueButton.textContent = 'Next';
  document.getElementById('sellerStepLabel').textContent = 'Step 1 of 2: Enter your cooperative membership code.';
  document.getElementById('sellerEntryStatus').textContent = '';
  sellerForm.elements.membership_code.focus();
});
sellerForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = continueButton;
  const status = document.getElementById('sellerEntryStatus');
  status.textContent = '';
  const code = form.elements.membership_code.value.trim().toUpperCase();
  if (!/^OBT-\d{4}-\d{6,}$/.test(code)) {
    status.textContent = 'Enter your cooperative membership code, for example OBT-2026-000123.';
    form.elements.membership_code.focus();
    return;
  }
  if (passwordStep.hidden) {
    form.elements.membership_code.value = code;
    form.elements.membership_code.readOnly = true;
    passwordStep.hidden = false;
    passwordStep.disabled = false;
    document.getElementById('sellerStepLabel').textContent = 'Step 2 of 2: Enter your password.';
    button.textContent = 'Sign in as a seller';
    form.elements.password.focus();
    return;
  }
  button.disabled = true;
  try {
    const result = await OBIT.post('/api/auth/login', {
      identifier: code,
      password: form.elements.password.value,
    });
    if (result.role !== 'member' || !result.token) throw new Error('Seller sign-in requires an active cooperative membership.');
    const member = await OBIT.get('/api/me/membership', { token: result.token });
    if (member.status !== 'ACTIVE') throw new Error('Your membership must be active before you can sell.');
    OBIT.saveSession('member', result.token);
    form.elements.password.value = '';
    window.location.assign('market.html#sellerPanel');
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
