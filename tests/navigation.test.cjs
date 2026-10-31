const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
function element() {
  const classes = new Set(), handlers = {}, attrs = {};
  const el = { handlers, attrs, hidden: true, textContent: '', focus() { this.focused = true; },
    setAttribute(name, value) { attrs[name] = value; },
    addEventListener(name, handler) { handlers[name] = handler; },
    contains(target) { return target === el || target?.parent === el; },
    classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
  };
  return el;
}
function navigation() {
  const toggle = element(), nav = element(), body = element(), link = element();
  link.parent = nav;
  const events = {}, media = {};
  let backdrop;
  body.append = el => { backdrop = el; };
  const document = {
    body, createElement: element,
    querySelector: s => s === '.nav-toggle' ? toggle : s === '.main-nav' ? nav : null,
    querySelectorAll: s => s === '.main-nav a' ? [link] : [],
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/js/nav.js'), 'utf8'), {
    document, window: { matchMedia: () => ({ addEventListener(name, handler) { media[name] = handler; } }) },
    IntersectionObserver: class { observe() {} unobserve() {} },
  });
  return { toggle, nav, body, link, events, media, backdrop };
}
test('menu opens with an explicit close control and tapping outside dismisses it', () => {
  const n = navigation();
  n.toggle.handlers.click();
  assert.equal(n.toggle.attrs['aria-expanded'], 'true');
  assert.equal(n.toggle.attrs['aria-label'], 'Close navigation');
  assert.equal(n.backdrop.hidden, false);
  n.events.pointerdown({ target: { parent: n.nav } });
  assert.equal(n.nav.classList.contains('open'), true);
  n.events.pointerdown({ target: {} });
  assert.equal(n.nav.classList.contains('open'), false);
  assert.equal(n.backdrop.hidden, true);
  assert.equal(n.body.classList.contains('nav-open'), false);
  assert.equal(n.toggle.attrs['aria-expanded'], 'false');
});
test('close control, backdrop, Escape, destination selection and desktop resize all dismiss navigation', () => {
  const n = navigation();
  for (const close of [() => n.toggle.handlers.click(), () => n.backdrop.handlers.click(), () => n.events.keydown({ key: 'Escape' }), () => n.link.handlers.click(), () => n.media.change({ matches: true })]) {
    n.toggle.handlers.click();
    close();
    assert.equal(n.nav.classList.contains('open'), false);
    assert.equal(n.toggle.attrs['aria-expanded'], 'false');
    assert.equal(n.backdrop.hidden, true);
  }
});
test('Membership always targets the cooperative and Marketplace has a separate subdomain link', () => {
  for (const page of ['index.html', 'apply.html', 'portal.html', 'news.html']) {
    const html = fs.readFileSync(path.join(root, 'frontend', page), 'utf8');
    const nav = html.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)[0];
    assert.match(nav, /href="https:\/\/obitcooperative.com\/#membership">Membership</);
    assert.match(nav, /href="https:\/\/marketplace.obitcooperative.com\/">Marketplace</);
  }
});
test('marketplace root opens the role entry page and legacy membership links return to the cooperative', () => {
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  const routing = html.match(/<script>(if\(location.hostname[\s\S]*?)<\/script>/)[1];
  for (const [host, hash, expected] of [
    ['marketplace.obitcooperative.com', '', '/market-entry.html'],
    ['marketplace.obitcooperative.com', '#membership', 'https://obitcooperative.com/#membership'],
    ['obitcooperative.com', '#membership', null],
  ]) {
    let destination = null;
    vm.runInNewContext(routing, { location: { hostname: host, search: '', hash, replace(url) { destination = url; } } });
    assert.equal(destination, expected);
  }
  const entry = fs.readFileSync(path.join(root, 'frontend/market-entry.html'), 'utf8');
  assert.match(entry, /href="market.html">Continue as a buyer/);
  assert.match(entry, /name="membership_code"/);
  assert.match(entry, /name="password" type="password"/);
});
