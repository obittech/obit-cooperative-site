document.getElementById('sellerEntryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const status = document.getElementById('sellerEntryStatus');
  status.textContent = '';
  button.disabled = true;
  try {
    const result = await OBIT.post('/api/auth/login', {
      identifier: form.elements.membership_code.value.trim().toUpperCase(),
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
