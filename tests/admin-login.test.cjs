const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(post) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: id === 'adminMfaForm', disabled: false, style: {}, textContent: '', innerHTML: '',
      listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; },
      reportValidity() { return true; }, focus() { this.focused = true; }
    });
    return nodes.get(id);
  };
  const sessions = [];
  const ctx = vm.createContext({
    document: {getElementById: node, querySelectorAll: () => []},
    OBIT: {post, getSession: () => null, saveSession: (...args) => sessions.push(args)},
    prompt() { throw new Error('Login must never open a browser prompt'); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/js/admin.js'), 'utf8'), ctx);
  vm.runInContext('loadAll = async function () {};', ctx);
  node('loginIdentifier').value = 'admin@example.test';
  node('loginPassword').value = 'test-only-password';
  const fire = (id, event = 'click') => node(id).listeners[event]({preventDefault() {}});
  return {node, fire, sessions};
}

test('admin code stays on the page after rejection, retries without a new login, then creates session', async () => {
  const calls = [];
  const ui = setup(async (path, body) => {
    calls.push({path, body});
    if (path.endsWith('/login')) return {role: 'admin', mfa_required: true, user_id: 23};
    if (body.code === '111111') throw new Error('Invalid or expired admin login code');
    return {token: 'verified-test-token'};
  });
  await ui.fire('adminLoginForm', 'submit');
  assert.equal(ui.node('adminMfaForm').hidden, false);
  assert.equal(ui.node('adminLoginForm').hidden, true);
  assert.equal(ui.node('adminMfaCode').focused, true);
  assert.equal(ui.sessions.length, 0);
  ui.node('adminMfaCode').value = '111111';
  await ui.fire('adminMfaForm', 'submit');
  assert.equal(ui.node('adminMfaForm').hidden, false);
  assert.match(ui.node('alertBox').innerHTML, /not accepted/);
  assert.equal(ui.node('btnVerifyAdminCode').disabled, false);
  ui.node('adminMfaCode').value = '222222';
  await ui.fire('adminMfaForm', 'submit');
  assert.deepEqual(calls.map(c => c.path), ['/api/auth/login', '/api/auth/admin-mfa', '/api/auth/admin-mfa']);
  assert.equal(calls[1].body.user_id, 23);
  assert.equal(ui.sessions[0][1], 'verified-test-token');
  assert.equal(ui.node('loginPassword').value, '');
  assert.equal(ui.node('adminMfaCode').value, '');
});

test('resend clears the old code and uses the new challenge, back clears credentials', async () => {
  let login = 0;
  const calls = [];
  const ui = setup(async (path, body) => {
    calls.push({path, body});
    return path.endsWith('/login') ? {role: 'admin', mfa_required: true, user_id: ++login} : {token: 'test-token'};
  });
  await ui.fire('adminLoginForm', 'submit');
  ui.node('adminMfaCode').value = '111111';
  await ui.fire('btnResendAdminCode');
  assert.equal(ui.node('adminMfaCode').value, '');
  ui.node('adminMfaCode').value = '222222';
  await ui.fire('adminMfaForm', 'submit');
  assert.equal(calls[2].body.user_id, 2);
  ui.node('loginPassword').value = 'test-only-password';
  await ui.fire('adminLoginForm', 'submit');
  await ui.fire('btnChangeAdminLogin');
  assert.equal(ui.node('adminLoginForm').hidden, false);
  assert.equal(ui.node('adminMfaForm').hidden, true);
  assert.equal(ui.node('loginPassword').value, '');
});

test('invalid code and duplicate submission never send extra verification requests', async () => {
  let release;
  const calls = [];
  const ui = setup(async (path, body) => {
    calls.push({path, body});
    if (path.endsWith('/login')) return {role: 'admin', mfa_required: true, user_id: 23};
    return new Promise(resolve => { release = resolve; });
  });
  await ui.fire('adminLoginForm', 'submit');
  ui.node('adminMfaCode').value = '123';
  await ui.fire('adminMfaForm', 'submit');
  assert.equal(calls.length, 1);
  ui.node('adminMfaCode').value = '222222';
  const first = ui.fire('adminMfaForm', 'submit');
  await ui.fire('adminMfaForm', 'submit');
  await ui.fire('btnResendAdminCode');
  assert.equal(calls.length, 2);
  release({token: 'test-token'});
  await first;
});

test('staff login still works without an admin challenge and failed resend returns to login', async () => {
  const staff = setup(async () => ({role: 'staff', token: 'staff-test-token'}));
  await staff.fire('adminLoginForm', 'submit');
  assert.equal(staff.sessions[0][1], 'staff-test-token');
  let count = 0;
  const admin = setup(async () => {
    if (count++) throw new Error('We could not send the admin login code.');
    return {role: 'admin', mfa_required: true, user_id: 23};
  });
  await admin.fire('adminLoginForm', 'submit');
  await admin.fire('btnResendAdminCode');
  assert.equal(admin.node('adminLoginForm').hidden, false);
  assert.equal(admin.node('adminMfaForm').hidden, true);
  assert.match(admin.node('alertBox').innerHTML, /could not send/);
  assert.equal(admin.node('btnLogin').disabled, false);
});
