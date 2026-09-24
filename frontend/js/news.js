// Public previews are available to everyone. Full opportunity details are
// returned by the API only after login and account-bound member-code verification.

const list = document.getElementById('opportunityList');
const memberPanel = document.getElementById('memberAccessPanel');
const accessAlert = document.getElementById('accessAlert');

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function formatDeadline(value) {
  if (!value) return 'No closing date stated';
  const date = new Date(value + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

function safeLink(url, label) {
  const a = node('a', 'opportunity-source', label);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error();
    a.href = parsed.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  } catch {
    a.href = '#';
    a.textContent = 'Source unavailable';
  }
  return a;
}

function renderPublic(items) {
  list.replaceChildren();
  if (!items.length) {
    list.append(node('div', 'card muted-note', 'No verified opportunities are currently published.'));
    return;
  }
  items.forEach((item) => {
    const card = node('article', 'card opportunity-card');
    const top = node('div', 'opportunity-topline');
    top.append(node('span', 'opportunity-category', item.category));
    top.append(node('span', 'status-badge ' + (item.status === 'CONFIRMED' ? 'ok' : item.status === 'CLOSED' ? 'fail' : 'pending'), item.status));
    card.append(top, node('h2', '', item.headline), node('p', '', item.public_summary));

    const meta = node('div', 'opportunity-meta');
    meta.append(node('span', '', 'Deadline: ' + formatDeadline(item.deadline)));
    meta.append(node('span', '', 'Location: ' + (item.location || 'Nigeria')));
    if (item.fit_score !== null && item.fit_score !== undefined) meta.append(node('span', '', 'Fit score: ' + item.fit_score + '/100'));
    card.append(meta, safeLink(item.source_url, 'Verify on ' + item.source_name));

    if (item.members_only) {
      const lock = node('div', 'member-lock');
      lock.append(node('strong', '', 'Member briefing locked'), node('span', '', ' Login to see eligibility, application steps, required documents, risks and the recommended action.'));
      card.append(lock);
    }
    list.append(card);
  });
}

function detail(label, value) {
  if (!value) return null;
  const wrap = node('div', 'opportunity-detail');
  wrap.append(node('h3', '', label), node('p', '', value));
  return wrap;
}

function renderMember(items) {
  list.replaceChildren();
  items.forEach((item) => {
    const card = node('article', 'card opportunity-card opportunity-full');
    const top = node('div', 'opportunity-topline');
    top.append(node('span', 'opportunity-category', item.category));
    top.append(node('span', 'status-badge ' + (item.status === 'CONFIRMED' ? 'ok' : item.status === 'CLOSED' ? 'fail' : 'pending'), item.status));
    card.append(top, node('h2', '', item.headline), node('p', '', item.full_summary || item.public_summary));

    const fields = [
      ['Why it matters', item.why_it_matters],
      ['Eligibility', item.eligibility],
      ['Funding or benefit', item.funding_benefit],
      ['Required contribution', item.required_contribution],
      ['Major conditions', item.conditions],
      ['Exactly how to access it', item.application_steps],
      ['Documents and evidence required', item.documents_required],
      ['Risks and reasons not to pursue', item.risks],
      ['Obit fit verdict', item.fit_verdict],
      ['Next action', item.next_action ? item.next_action.replaceAll('_', ' ') : null],
      ['Deadline', formatDeadline(item.deadline)],
    ];
    fields.forEach(([label, value]) => {
      const block = detail(label, value);
      if (block) card.append(block);
    });
    card.append(safeLink(item.source_url, 'Open official source: ' + item.source_name));
    list.append(card);
  });
}

async function loadPublic() {
  try {
    const items = await OBIT.get('/api/opportunities');
    renderPublic(items);
  } catch (err) {
    list.replaceChildren(node('div', 'alert alert-error', 'Opportunities could not be loaded: ' + err.message));
  }
}

function refreshAccessState() {
  const token = OBIT.getSession('member');
  document.getElementById('memberLoggedOut').style.display = token ? 'none' : '';
  document.getElementById('memberLoggedIn').style.display = token ? '' : 'none';
}

document.getElementById('btnUnlockOpportunities').addEventListener('click', async () => {
  const token = OBIT.getSession('member');
  if (!token) {
    window.location.href = 'portal.html';
    return;
  }
  const accessCode = document.getElementById('memberAccessCode').value.trim();
  accessAlert.replaceChildren();
  if (!accessCode) {
    accessAlert.append(node('div', 'alert alert-error', 'Enter the member code assigned to your account.'));
    return;
  }
  const button = document.getElementById('btnUnlockOpportunities');
  button.disabled = true;
  button.textContent = 'Verifying…';
  try {
    const result = await OBIT.post('/api/me/opportunities/unlock', { access_code: accessCode }, { token });
    renderMember(result.opportunities);
    memberPanel.classList.add('unlocked');
    accessAlert.append(node('div', 'alert alert-success', 'Member Opportunity Hub unlocked for ' + result.member_code + '.'));
  } catch (err) {
    if (/session token|account is not active/i.test(err.message)) OBIT.clearSession('member');
    accessAlert.append(node('div', 'alert alert-error', err.message));
    refreshAccessState();
  } finally {
    button.disabled = false;
    button.textContent = 'Unlock Member Briefings';
  }
});

refreshAccessState();
loadPublic();
