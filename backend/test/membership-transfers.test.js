import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'membership-transfer-tests-only';
process.env.MARKET_TRANSFER_ENABLED = 'true';
process.env.MARKET_TRANSFER_BANK_NAME = 'Test Bank';
process.env.MARKET_TRANSFER_ACCOUNT_NAME = 'Obit Test Account';
process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
process.env.MEMBERSHIP_FEE_NGN = '3000';
const { migrate, run, get, all, atomic, closeDatabase } = await import('../src/db.js');
const { membershipTransfersRouter: router } = await import('../src/routes/membership-transfers.js');
const { paymentsRouter } = await import('../src/routes/payments.js');
const { issueToken } = await import('../src/utils/auth.js');
const { allocateBankCredit } = await import('../src/services/bank-credit.js');
const { fixtureApplicationToken } = await import('./helpers/application-session.js');
await migrate();
after(closeDatabase);
const created = await run("INSERT INTO users (email,role,status) VALUES (?, 'staff','ACTIVE')", [`transfer-staff-${crypto.randomUUID()}@example.invalid`]);
const staff = issueToken(await get('SELECT * FROM users WHERE id = ?', [created.lastInsertRowid]));
async function call(method, path, body = {}, token = '', target = router) {
  const route = target.match(method, path);
  assert.ok(route);
  if (!token) token = await fixtureApplicationToken(path, body, route.params);
  const req = { body, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
async function app(status = 'KYC_VERIFIED') {
  const r = await run('INSERT INTO member_applications (full_legal_name,status) VALUES (?,?)', ['Local Transfer Test', status]);
  return Number(r.lastInsertRowid);
}
const start = id => call('POST', '/api/payments/membership/bank-transfer', { application_id: id, amount: 1 });
const paid = p => call('POST', `/api/payments/membership/bank-transfer/${p.reference}/paid`);
const confirm = (p, ref, changes = {}, token = staff) => call('POST', `/api/admin/membership-transfers/${p.reference}/confirm`, { amount_kobo: p.amount_kobo, bank_reference: ref, bank_credit_checked: true, ...changes }, token);

test('internal membership checkout requires verified KYC and configured bank details', async () => {
  await assert.rejects(start(await app('APPLICATION_SUBMITTED')), e => e.status === 409);
  process.env.MARKET_TRANSFER_ENABLED = 'false';
  const id = await app();
  await assert.rejects(start(id), e => e.status === 503);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'KYC_VERIFIED');
  process.env.MARKET_TRANSFER_ENABLED = 'true';
});

test('checkout snapshots bank details and server fee, then resumes one reference', async () => {
  const id = await app();
  const results = await Promise.all([start(id), start(id)]);
  assert.equal(results[0].reference, results[1].reference);
  assert.equal(results[0].amount_kobo, 300000);
  assert.equal(results[0].status, 'READY');
  process.env.MEMBERSHIP_FEE_NGN = '9000';
  process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '1111111111';
  assert.equal((await start(id)).amount_kobo, 300000);
  assert.equal((await start(id)).account_number, '0000000000');
  process.env.MEMBERSHIP_FEE_NGN = '3000';
  process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
  await assert.rejects(call('POST', '/api/payments/membership/initialize', { application_id: id, provider: 'paystack' }, '', paymentsRouter), e => e.status === 409);
});

test('I Have Paid opens the correct WhatsApp message without verifying payment', async () => {
  const id = await app(), payment = await start(id);
  const claimed = await paid(payment);
  const url = new URL(claimed.whatsapp_url);
  assert.equal(url.origin, 'https://wa.me');
  assert.equal(url.pathname, '/2348030567787');
  assert.ok(url.searchParams.get('text').includes(payment.reference));
  assert.ok(url.searchParams.get('text').includes(String(id)));
  assert.ok(url.searchParams.get('text').includes('3,000'));
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(claimed.receipt_reference, null);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'PAYMENT_PENDING');
  await paid(payment);
  const audit = await all("SELECT id FROM audit_events WHERE action = 'MEMBERSHIP_TRANSFER_REPORTED' AND entity_id = ?", [id]);
  assert.equal(audit.length, 1);
});

test('staff verifies exact credit and records one receipt without activating membership', async () => {
  const id = await app(), payment = await start(id);
  await assert.rejects(confirm(payment, 'bank-ref-test'), e => e.status === 409);
  await paid(payment);
  await assert.rejects(confirm(payment, 'bank-ref-test', {}, ''), e => e.status === 401);
  await assert.rejects(confirm(payment, 'bank-ref-test', { bank_credit_checked: false }), e => e.status === 400);
  await assert.rejects(confirm(payment, 'bank-ref-test', { amount_kobo: 100 }), e => e.status === 409);
  const ref = `BANK-${crypto.randomUUID()}`;
  const result = await confirm(payment, ref);
  assert.equal(result.status, 'CONFIRMED');
  assert.ok(result.receipt_reference);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [id])).status, 'UNDER_REVIEW');
  await confirm(payment, ref);
  assert.equal((await paid(payment)).status, 'CONFIRMED');
  await assert.rejects(confirm(payment, ref + '-other'), e => e.status === 409);
  const second = await start(await app());
  await paid(second);
  await assert.rejects(confirm(second, ref), e => e.status === 409);
  assert.equal((await get('SELECT status FROM membership_bank_payments WHERE reference=?', [second.reference])).status, 'CLAIMED');
});

test('a bank credit cannot fund both marketplace and membership, even concurrently', async () => {
  const ref = `CROSS-${crypto.randomUUID()}`;
  const results = await Promise.allSettled([
    atomic(() => allocateBankCredit(ref, 'MARKET', 123)),
    atomic(() => allocateBankCredit(ref, 'MEMBERSHIP', 456)),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected' && x.reason.status === 409).length, 1);
  await migrate();
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM bank_credit_allocations WHERE bank_reference=?', [ref])).n), 1);
});

const approveTransfer = (payment, ref, changes = {}, token = staff) => call('POST', `/api/admin/membership-transfers/${payment.reference}/confirm-and-approve`, { amount_kobo: payment.amount_kobo, bank_reference: ref, bank_credit_checked: true, ...changes }, token);
async function identifiedApplication() {
  const id = await app();
  const email = `membership-${crypto.randomUUID()}@example.invalid`;
  const phone = `test-${crypto.randomUUID()}`;
  await run('UPDATE member_applications SET email=?, phone=? WHERE id=?', [email, phone, id]);
  const payment = await start(id);
  await paid(payment);
  return {id, email, phone, payment};
}

test('combined confirmation activates one membership and is safe to repeat', async () => {
  const a = await identifiedApplication(), ref = `BANK-${crypto.randomUUID()}`;
  const result = await approveTransfer(a.payment, ref);
  assert.equal(result.application.status, 'ACTIVE');
  assert.equal(result.member.status, 'ACTIVE');
  const retry = await approveTransfer(a.payment, ref);
  assert.equal(Number(retry.member.id), Number(result.member.id));
  assert.equal(retry.already_approved, true);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM members WHERE application_id=?', [a.id])).n), 1);
  await assert.rejects(approveTransfer(a.payment, ref + '-other'), e => e.status === 409);
  const { meRouter } = await import('../src/routes/me.js');
  const user = await get('SELECT * FROM users WHERE id=?', [result.member.user_id]);
  const portal = await call('GET', '/api/me/membership', {}, issueToken(user), meRouter);
  assert.equal(portal.membership_payment.status, 'PAYMENT_VERIFIED');
  assert.equal(portal.membership_payment.provider, 'bank_transfer');
  assert.equal(portal.membership_payment.amount, 3000);
});

test('contact conflicts retain verified credit for review without duplicate memberships or referrals', async () => {
  const first = await identifiedApplication();
  const active = await approveTransfer(first.payment, `BANK-${crypto.randomUUID()}`);
  for (const field of ['email', 'phone']) {
    const duplicate = await identifiedApplication();
    await run(`UPDATE member_applications SET ${field}=? WHERE id=?`, [field === 'email' ? first.email.toUpperCase() : first.phone, duplicate.id]);
    const ref = `BANK-${crypto.randomUUID()}`;
    await assert.rejects(approveTransfer(duplicate.payment, ref, { amount_kobo: 100 }), e => e.status === 409);
    assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?', [duplicate.id])).status, 'CLAIMED');
    const result = await approveTransfer(duplicate.payment, ref);
    assert.equal(result.membership_review_required, true);
    assert.equal(result.payment_confirmed, true);
    assert.equal(result.member, null);
    assert.equal(result.existing_member.member_code, active.member.member_code);
    assert.equal(result.application.status, 'UNDER_REVIEW');
    assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?', [duplicate.id])).status, 'CONFIRMED');
    assert.equal(await get('SELECT id FROM members WHERE application_id=?', [duplicate.id]), undefined);
    assert.equal(await get('SELECT id FROM referral_bonuses WHERE application_id=?', [duplicate.id]), undefined);
    assert.equal((await paid(duplicate.payment)).status, 'CONFIRMED');
    assert.equal((await approveTransfer(duplicate.payment, ref)).membership_review_required, true);
    const { applicationsRouter } = await import('../src/routes/applications.js');
    const applicant = await call('GET', `/api/applications/${duplicate.id}`, {}, '', applicationsRouter);
    assert.equal(applicant.status, 'UNDER_REVIEW');
    assert.equal(applicant.membership_review_required, true);
    assert.equal(applicant.existing_member, undefined);
    const rows = await call('GET', '/api/admin/membership-transfers', {}, staff);
    assert.equal(rows.find(p => Number(p.application_id) === duplicate.id).existing_member_code, active.member.member_code);
    const other = await identifiedApplication();
    await assert.rejects(approveTransfer(other.payment, ref), e => e.status === 409);
  }
});

test('existing membership on the same application is reused while its missing credit is confirmed', async () => {
  const a = await identifiedApplication();
  const user = await run("INSERT INTO users (email,phone,role) VALUES (?,?,'member')", [a.email, a.phone]);
  const code = `OBT-2000-${String(a.id).padStart(6, '0')}`;
  const member = await run("INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,'ACTIVE')", [a.id, user.lastInsertRowid, code]);
  // Legacy approval may already be ACTIVE even though its transfer stayed CLAIMED.
  await run("UPDATE member_applications SET status='ACTIVE' WHERE id=?", [a.id]);
  const result = await approveTransfer(a.payment, `BANK-${crypto.randomUUID()}`);
  assert.equal(result.member.member_code, code);
  assert.equal(Number(result.member.id), Number(member.lastInsertRowid));
  assert.equal(result.application.status, 'ACTIVE');
  assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?', [a.id])).status, 'CONFIRMED');
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM members WHERE user_id=?', [user.lastInsertRowid])).n), 1);
});

test('staff links a duplicate to its existing approved membership and original payment without double counting', async () => {
  const canonicalApp = await identifiedApplication();
  const active = await approveTransfer(canonicalApp.payment, `LEGACY-${crypto.randomUUID()}`);
  const duplicate = await identifiedApplication();
  await run('UPDATE member_applications SET email=?, phone=? WHERE id=?', [canonicalApp.email, canonicalApp.phone, duplicate.id]);
  // Production legacy error: the first receipt recorded the duplicate's checkout reference as its bank reference.
  await run('UPDATE membership_bank_payments SET bank_reference=? WHERE application_id=?', [duplicate.payment.reference + '.', canonicalApp.id]);
  const ref = `TRF-${crypto.randomUUID()}`;
  const body = { member_code: active.member.member_code, amount_kobo: 300000, bank_reference: ref, bank_credit_checked: true, same_member_checked: true };
  const path = `/api/admin/membership-transfers/${duplicate.payment.reference}/approve-existing`;
  await assert.rejects(call('POST', path, body), e => e.status === 401);
  await assert.rejects(call('POST', path, { ...body, same_member_checked: false }, staff), e => e.status === 400);
  await assert.rejects(call('POST', path, { ...body, amount_kobo: 100 }, staff), e => e.status === 409);
  const before = Number((await get('SELECT COUNT(*) AS n FROM members WHERE user_id=?', [active.member.user_id])).n);
  const result = await call('POST', path, body, staff);
  assert.equal(result.application.status, 'ACTIVE');
  assert.equal(result.member.member_code, active.member.member_code);
  assert.equal(result.linked_existing_membership, true);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM members WHERE user_id=?', [active.member.user_id])).n), before);
  assert.equal(Number((await get('SELECT application_id FROM members WHERE id=?', [active.member.id])).application_id), canonicalApp.id);
  assert.equal((await get('SELECT bank_reference FROM membership_bank_payments WHERE application_id=?', [canonicalApp.id])).bank_reference, ref);
  // The duplicate is an alias, never a second paid fee or referral reward.
  assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?', [duplicate.id])).status, 'CLAIMED');
  assert.equal(await get('SELECT id FROM referral_bonuses WHERE application_id=?', [duplicate.id]), undefined);
  assert.equal(Number((await get('SELECT resource_id FROM bank_credit_allocations WHERE bank_reference=?', [ref])).resource_id), Number((await get('SELECT id FROM membership_bank_payments WHERE application_id=?', [canonicalApp.id])).id));
  await call('POST', path, body, staff);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM membership_application_links WHERE application_id=?', [duplicate.id])).n), 1);
  const { applicationsRouter } = await import('../src/routes/applications.js');
  const applicant = await call('GET', `/api/applications/${duplicate.id}`, {}, '', applicationsRouter);
  assert.equal(applicant.status, 'ACTIVE');
  assert.equal(applicant.member_code, active.member.member_code);
  const resumed = await start(duplicate.id);
  assert.equal(resumed.status, 'CONFIRMED');
  assert.equal(resumed.receipt_reference, `OBIT-MEMBER-${canonicalApp.payment.reference}`);
  assert.equal((await paid(duplicate.payment)).status, 'CONFIRMED');
  const row = (await call('GET', '/api/admin/membership-transfers', {}, staff)).find(p => Number(p.application_id) === duplicate.id);
  assert.equal(row.status, 'CONFIRMED');
  assert.equal(row.application_status, 'ACTIVE');
  assert.equal(row.bank_reference, ref);
  await run("UPDATE members SET status='SUSPENDED' WHERE id=?", [active.member.id]);
  // Staff retain review access; suspended members cannot issue sessions.
  assert.equal((await call('GET', `/api/applications/${duplicate.id}`, {}, staff, applicationsRouter)).status, 'SUSPENDED');
});

test('existing membership links reject unrelated payments, contact mismatches and reused credits', async () => {
  const first = await identifiedApplication(), active = await approveTransfer(first.payment, `BANK-${crypto.randomUUID()}`);
  const duplicate = await identifiedApplication();
  const body = { member_code: active.member.member_code, amount_kobo: 300000, bank_reference: `BANK-${crypto.randomUUID()}`, bank_credit_checked: true, same_member_checked: true };
  const path = `/api/admin/membership-transfers/${duplicate.payment.reference}/approve-existing`;
  await assert.rejects(call('POST', path, body, staff), e => e.status === 409 && /does not match/.test(e.message));
  await run('UPDATE member_applications SET email=? WHERE id=?', [first.email, duplicate.id]);
  await assert.rejects(call('POST', path, body, staff), e => e.status === 409 && /not linked/.test(e.message));
  await run('UPDATE membership_bank_payments SET bank_reference=? WHERE application_id=?', [duplicate.payment.reference, first.id]);
  await atomic(() => allocateBankCredit(body.bank_reference, 'MARKET', 9999));
  await assert.rejects(call('POST', path, body, staff), e => e.status === 409 && /already assigned/.test(e.message));
  assert.equal(await get('SELECT application_id FROM membership_application_links WHERE application_id=?', [duplicate.id]), undefined);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [duplicate.id])).status, 'PAYMENT_PENDING');
});
