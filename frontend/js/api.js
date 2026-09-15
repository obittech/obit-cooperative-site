// api.js — thin fetch wrapper used by apply.js / portal.js / admin.js.
// Session tokens are kept in localStorage, scoped per role, purely for this
// demo front-end; a production build may prefer httpOnly cookies issued by
// the backend instead.

const OBIT = {
  base: () => window.OBIT_API_BASE,

  async request(method, path, { body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${OBIT.base()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  },

  get(path, opts) { return OBIT.request('GET', path, opts); },
  post(path, body, opts = {}) { return OBIT.request('POST', path, { ...opts, body }); },
  patch(path, body, opts = {}) { return OBIT.request('PATCH', path, { ...opts, body }); },

  saveSession(role, token) { localStorage.setItem(`obit_${role}_token`, token); },
  getSession(role) { return localStorage.getItem(`obit_${role}_token`); },
  clearSession(role) { localStorage.removeItem(`obit_${role}_token`); },
};
