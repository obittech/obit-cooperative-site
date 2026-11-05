// Text fields avoid the different iPhone and Android calendar pickers.
(function (root) {
  function isoDate(day, month, year, now = new Date()) {
    if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year)) return '';
    const d = Number(day), m = Number(month), y = Number(year);
    if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return '';
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return iso < now.toISOString().slice(0, 10) ? iso : '';
  }
  let fields, hidden, error;
  function sync(showError) {
    hidden.value = isoDate(...fields.map(f => f.value));
    fields.forEach(f => { f.setCustomValidity(''); f.removeAttribute('aria-invalid'); });
    error.textContent = '';
    if (showError && !hidden.value) {
      const incomplete = fields.find(f => !f.value || (f.id === 'dobYear' && f.value.length !== 4));
      const target = incomplete || fields[0];
      const message = incomplete ? 'Enter your day, month and four-digit birth year.' : 'Enter a real date of birth in the past.';
      error.textContent = message;
      target.setCustomValidity(message);
      target.setAttribute('aria-invalid', 'true');
      target.focus();
      target.reportValidity();
    }
    return Boolean(hidden.value);
  }
  function restore() {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(hidden.value);
    if (match) { fields[0].value = match[3]; fields[1].value = match[2]; fields[2].value = match[1]; }
    sync(false);
  }
  function init() {
    fields = ['dobDay', 'dobMonth', 'dobYear'].map(id => document.getElementById(id));
    hidden = document.getElementById('date_of_birth');
    error = document.getElementById('dobError');
    fields.forEach((field, index) => {
      field.addEventListener('input', event => {
        field.value = field.value.replace(/\D/g, '').slice(0, index === 2 ? 4 : 2);
        sync(false);
        if (index < 2 && field.value.length === 2 && event.inputType !== 'deleteContentBackward') {
          fields[index + 1].focus();
          fields[index + 1].select();
        }
      });
      field.addEventListener('blur', () => {
        if (index < 2 && /^\d$/.test(field.value)) field.value = field.value.padStart(2, '0');
        sync(false);
      });
      field.addEventListener('keydown', event => {
        if (event.key === 'Backspace' && !field.value && index > 0) { fields[index - 1].focus(); fields[index - 1].select(); }
        if (event.key === '/' && index < 2) { event.preventDefault(); fields[index + 1].focus(); }
      });
      field.addEventListener('paste', event => {
        const text = event.clipboardData?.getData('text').trim() || '';
        const parts = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(text);
        if (!parts) return;
        event.preventDefault();
        fields.forEach((f, i) => { f.value = parts[i + 1]; });
        sync(false);
        fields[2].focus();
      });
    });
    restore();
  }
  root.ObitDOB = { init, restore, validate: () => sync(true), isoDate };
})(typeof window === 'undefined' ? globalThis : window);
