// api.js — thin fetch wrapper used by apply.js / portal.js / admin.js.
// Session tokens are kept in sessionStorage so they disappear when the browser
// session closes. This reduces persistence while the API/frontend remain on
// separate origins. The final same-origin deployment should use HttpOnly cookies.

const OBIT = {
  base: () => window.OBIT_API_BASE,

  async request(method, path, { body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const applicationPath = /^\/api\/(?:applications\/\d+(?:\/submit)?|kyc\/.*|payments\/membership\/(?:initialize|bank-transfer)(?:\/.*)?)$/.test(path);
    const accessToken = token || (applicationPath ? OBIT.getSession('application') || OBIT.getSession('member') : null);
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    const res = await fetch(`${OBIT.base()}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      const error = new Error(message);
      error.status = res.status;
      if (applicationPath && [401, 403].includes(res.status)) {
        if (!token) OBIT.clearSession('application');
        window.dispatchEvent(new CustomEvent('obit-application-access-required'));
      }
      throw error;
    }
    return data;
  },

  get(path, opts) { return OBIT.request('GET', path, opts); },
  post(path, body, opts = {}) { return OBIT.request('POST', path, { ...opts, body }); },
  patch(path, body, opts = {}) { return OBIT.request('PATCH', path, { ...opts, body }); },

  saveSession(role, token) {
    localStorage.removeItem(`obit_${role}_token`);
    sessionStorage.setItem(`obit_${role}_token`, token);
  },
  getSession(role) {
    // One-time compatibility migration removes persistent legacy tokens.
    const legacy = localStorage.getItem(`obit_${role}_token`);
    if (legacy) localStorage.removeItem(`obit_${role}_token`);
    return sessionStorage.getItem(`obit_${role}_token`);
  },
  clearSession(role) {
    sessionStorage.removeItem(`obit_${role}_token`);
    localStorage.removeItem(`obit_${role}_token`);
  },
};
