import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
process.env.AUTH_TOKEN_SECRET = 'referral-tests-only';
process.env.MARKET_TRANSFER_ENABLED = 'true';
process.env.MARKET_TRANSFER_BANK_NAME = 'Test Bank';
process.env.MARKET_TRANSFER_ACCOUNT_NAME = 'Obit Test Account';
process.env.MARKET_TRANSFER_ACCOUNT_NUMBER = '0000000000';
process.env.MEMBERSHIP_FEE_NGN = '3000';
const { migrate, get, run, all, atomic, closeDatabase } = await import('../src/db.js');
const { applicationsRouter } = await import('../src/routes/applications.js');
const { membershipTransfersRouter } = await import('../src/routes/membership-transfers.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { meRouter } = await import('../src/routes/me.js');
const { issueToken } = await import('../src/utils/auth.js');
const { awardReferralBonus } = await import('../src/services/member-referrals.js');
await migrate();
after(closeDatabase);
async function call(router, method, path, body = {}, token = '') {
  const route = router.match(method, path);
  assert.ok(route, path);
  const req = { body, socket: {}, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { json(status, body) { this.status = status; this.body = body; this.writableEnded = true; } };
  for (const handler of route.handlers) { await handler(req, res, route.params); if (res.writableEnded) break; }
  return res.body;
}
const staffRow = await run("INSERT INTO users (email,role,status) VALUES (?,'staff','ACTIVE')", [`referral-staff-${crypto.randomUUID()}@example.invalid`]);
const staff = issueToken(await get('SELECT * FROM users WHERE id = ?', [staffRow.lastInsertRowid]));
const phone = () => `080${crypto.randomInt(10000000, 99999999)}`;
async function member(status = 'ACTIVE') {
  const name = 'Synthetic Sponsor';
  const email = `sponsor-${crypto.randomUUID()}@example.invalid`, number = phone();
  const a = await run('INSERT INTO member_applications (status,full_legal_name,email,phone) VALUES (?,?,?,?)', [status, name, email, number]);
  const u = await run("INSERT INTO users (email,phone,role) VALUES (?,?,'member')", [email, number]);
  const code = `OBT-2026-${crypto.randomInt(100000, 999999)}`;
  const m = await run('INSERT INTO members (application_id,user_id,member_code,status) VALUES (?,?,?,?)', [a.lastInsertRowid, u.lastInsertRowid, code, status]);
  await run('INSERT INTO ledger_accounts (member_id) VALUES (?)', [m.lastInsertRowid]);
  return { id: Number(m.lastInsertRowid), code, name, phone: number, email, applicationId: Number(a.lastInsertRowid), token: issueToken(await get('SELECT * FROM users WHERE id = ?', [u.lastInsertRowid])) };
}
async function draft(sponsor) {
  const a = await call(applicationsRouter, 'POST', '/api/applications');
  return call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, {
    full_legal_name: 'Synthetic New Member', email: `new-${crypto.randomUUID()}@example.invalid`, phone: phone(),
    date_of_birth: '1990-01-01', membership_type: 'Individual', state: 'FCT', lga: 'Abuja Municipal', address: 'Local test only',
    ...(sponsor ? { sponsor_code: sponsor.code.toLowerCase(), sponsor_name: 'Spoofed name', sponsor_phone: '123' } : {}),
  });
}
async function checkout(a) {
  await call(applicationsRouter, 'POST', `/api/applications/${a.id}/submit`, { consents: { terms: true, privacy: true } });
  // Provider verification is simulated only inside this isolated test database.
  await run("UPDATE member_applications SET status='KYC_VERIFIED' WHERE id=?", [a.id]);
  return call(membershipTransfersRouter, 'POST', '/api/payments/membership/bank-transfer', { application_id: a.id });
}
async function paid(payment) {
  return call(membershipTransfersRouter, 'POST', `/api/payments/membership/bank-transfer/${payment.reference}/paid`);
}
async function confirm(payment) {
  return call(membershipTransfersRouter, 'POST', `/api/admin/membership-transfers/${payment.reference}/confirm`, { bank_credit_checked: true, amount_kobo: payment.amount_kobo, bank_reference: `BANK-${crypto.randomUUID()}` }, staff);
}
async function approve(id) {
  return call(adminRouter, 'POST', `/api/admin/applications/${id}/decision`, { decision: 'APPROVE' }, staff);
}

test('sponsor codes validate active membership, reject self-referrals, and preserve marketing attribution', async () => {
  const s = await member(), inactive = await member('SUSPENDED');
  const a = await draft();
  for (const code of ['invalid', 'OBT-2026-99999999999', inactive.code, 1]) {
    await assert.rejects(call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: code, full_legal_name: 'Do not save this' }), e => e.status === 422);
    assert.equal((await get('SELECT full_legal_name FROM member_applications WHERE id=?', [a.id])).full_legal_name, 'Synthetic New Member');
  }
  await assert.rejects(call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: s.code, phone: `+234${s.phone.slice(1)}` }), e => e.status === 422);
  await assert.rejects(call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: s.code, email: s.email.toUpperCase() }), e => e.status === 422);
  const marker = `ROLLBACK-${crypto.randomUUID()}`;
  await assert.rejects(call(applicationsRouter, 'POST', '/api/applications', { sponsor_code: 'bad', campaign: marker }), e => e.status === 422);
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM member_applications WHERE campaign=?', [marker])).n), 0);
  const saved = await call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: ` ${s.code.toLowerCase()} `, referral_source: 'launch-campaign' });
  assert.equal(saved.sponsor_code, s.code);
  assert.equal(saved.referral_source, 'launch-campaign');
  const restored = await call(applicationsRouter, 'GET', `/api/applications/${a.id}`);
  assert.equal(restored.sponsor_code, s.code);
  assert.equal(restored.sponsor_phone, undefined);
  await call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: '' });
  assert.equal(await get('SELECT * FROM application_sponsors WHERE application_id=?', [a.id]), undefined);
});

test('paid WhatsApp message uses registered sponsor details and freezes attribution once checkout starts', async () => {
  const s = await member(), other = await member(), a = await draft(s);
  const payment = await checkout(a);
  assert.deepEqual({ ...payment.sponsor }, { member_code: s.code, full_legal_name: s.name, phone: s.phone });
  const result = await paid(payment), message = new URL(result.whatsapp_url).searchParams.get('text');
  for (const value of [s.code, s.name, s.phone, payment.reference, '₦500']) assert.ok(message.includes(value));
  assert.equal(message.includes('Spoofed name'), false);
  assert.equal(message.includes('1990-01-01'), false);
  assert.equal(await get('SELECT * FROM referral_bonuses WHERE application_id=?', [a.id]), undefined);
  await run("UPDATE member_applications SET status='NEEDS_INFORMATION' WHERE id=?", [a.id]);
  await assert.rejects(call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: other.code }), e => e.status === 409);
  await call(applicationsRouter, 'PATCH', `/api/applications/${a.id}`, { sponsor_code: s.code, address: 'Corrected test address' });
  assert.equal((await get('SELECT member_code FROM application_sponsors WHERE application_id=?', [a.id])).member_code, s.code);
  const direct = await checkout(await draft());
  assert.equal(direct.sponsor, null);
  assert.ok(new URL(direct.whatsapp_url).searchParams.get('text').includes('no member referral'));
});

test('one ₦500 bonus is earned after confirmed payment and approval, and payout is recorded separately from savings', async () => {
  const s = await member(), a = await draft(s), payment = await checkout(a);
  await paid(payment);
  await atomic(() => awardReferralBonus(a.id, staffRow.lastInsertRowid));
  assert.equal(await get('SELECT * FROM referral_bonuses WHERE application_id=?', [a.id]), undefined);
  await confirm(payment);
  assert.equal(await get('SELECT * FROM referral_bonuses WHERE application_id=?', [a.id]), undefined);
  const approvals = await Promise.allSettled([approve(a.id), approve(a.id)]);
  assert.equal(approvals.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(approvals.filter(r => r.status === 'rejected' && r.reason.status === 409).length, 1);
  await Promise.all([atomic(() => awardReferralBonus(a.id, staffRow.lastInsertRowid)), atomic(() => awardReferralBonus(a.id, staffRow.lastInsertRowid))]);
  const bonuses = await all('SELECT * FROM referral_bonuses WHERE application_id=?', [a.id]);
  assert.equal(bonuses.length, 1);
  assert.equal(Number(bonuses[0].amount_kobo), 50000);
  const dashboard = await call(meRouter, 'GET', '/api/me/referrals', {}, s.token);
  assert.equal(dashboard.referral_code, s.code);
  assert.equal(dashboard.payable_kobo, 50000);
  assert.equal(dashboard.paid_kobo, 0);
  const outsider = await member();
  assert.equal((await call(meRouter, 'GET', '/api/me/referrals', {}, outsider.token)).earned_kobo, 0);
  const path = `/api/admin/referral-bonuses/${bonuses[0].id}/paid`, payoutRef = `PAYOUT-${crypto.randomUUID()}`;
  await assert.rejects(call(adminRouter, 'POST', path, { payout_reference: payoutRef, payout_completed: true, amount_kobo: 50000 }, s.token), e => e.status === 403);
  await assert.rejects(call(adminRouter, 'POST', path, { payout_reference: payoutRef, amount_kobo: 50000 }, staff), e => e.status === 422);
  const payout = { payout_reference: payoutRef, payout_completed: true, amount_kobo: 50000 };
  await call(adminRouter, 'POST', path, payout, staff);
  await call(adminRouter, 'POST', path, payout, staff);
  await assert.rejects(call(adminRouter, 'POST', path, { ...payout, payout_reference: payoutRef + '-different' }, staff), e => e.status === 409);
  const afterPayout = await call(meRouter, 'GET', '/api/me/referrals', {}, s.token);
  assert.equal(afterPayout.payable_kobo, 0);
  assert.equal(afterPayout.paid_kobo, 50000);
  assert.equal(Number((await get('SELECT balance_kobo FROM ledger_accounts WHERE member_id=?', [s.id])).balance_kobo), 0);
  const audit = await all("SELECT id FROM audit_events WHERE action='REFERRAL_BONUS_EARNED' AND entity_id=?", [a.id]);
  assert.equal(audit.length, 1);
  await migrate();
  assert.equal(Number((await get('SELECT COUNT(*) AS n FROM referral_bonuses WHERE application_id=?', [a.id])).n), 1);
});

test('verified gateway payments also qualify and a payout reference cannot pay a second referral', async () => {
  const s = await member(), a = await draft(s);
  await run("UPDATE member_applications SET status='UNDER_REVIEW' WHERE id=?", [a.id]);
  const reference = `GATEWAY-${crypto.randomUUID()}`;
  await run("INSERT INTO membership_payments (application_id,provider,reference,amount,amount_kobo,currency,status) VALUES (?,'paystack',?,3000,300000,'NGN','PAYMENT_VERIFIED')", [a.id, reference]);
  await approve(a.id);
  const bonus = await get('SELECT * FROM referral_bonuses WHERE application_id=?', [a.id]);
  assert.ok(bonus);
  const usedRef = `PAID-${crypto.randomUUID()}`;
  await call(adminRouter, 'POST', `/api/admin/referral-bonuses/${bonus.id}/paid`, { amount_kobo: 50000, payout_completed: true, payout_reference: usedRef }, staff);
  const second = await draft(s), p = await checkout(second);
  await paid(p);
  await confirm(p);
  await approve(second.id);
  const b = await get('SELECT * FROM referral_bonuses WHERE application_id=?', [second.id]);
  await assert.rejects(call(adminRouter, 'POST', `/api/admin/referral-bonuses/${b.id}/paid`, { amount_kobo: 50000, payout_completed: true, payout_reference: usedRef }, staff), e => e.status === 409);
  assert.equal((await get('SELECT status FROM referral_bonuses WHERE id=?', [b.id])).status, 'EARNED');
  const unpaid = await draft(s);
  await run("UPDATE member_applications SET status='UNDER_REVIEW' WHERE id=?", [unpaid.id]);
  await assert.rejects(approve(unpaid.id), e => e.status === 409);
  assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [unpaid.id])).status, 'UNDER_REVIEW');
  assert.equal(await get('SELECT id FROM members WHERE application_id=?', [unpaid.id]), undefined);
  assert.equal(await get('SELECT * FROM referral_bonuses WHERE application_id=?', [unpaid.id]), undefined);
});

test('parallel approvals of different applications allocate distinct membership codes', async () => {
  const a = await draft(), b = await draft();
  for (const application of [a, b]) {
    const payment = await checkout(application);
    await paid(payment);
    await confirm(payment);
  }
  const results = await Promise.all([approve(a.id), approve(b.id)]);
  assert.notEqual(results[0].member.member_code, results[1].member.member_code);
  assert.match(results[0].member.member_code, /^OBT-\d{4}-\d{6,}$/);
  assert.match(results[1].member.member_code, /^OBT-\d{4}-\d{6,}$/);
});


test('confirmed payment cannot approve a second membership matching an existing account', async () => {
  const existing = await member(), sponsor = await member();
  for (const field of ['email', 'phone']) {
    const application = await draft(sponsor);
    const payment = await checkout(application);
    await paid(payment);
    await confirm(payment);
    // Simulate a legacy duplicate that reaches review with a real payment record.
    // Use a fresh value for the other identifier to exercise each match separately.
    await run(`UPDATE member_applications SET ${field}=? WHERE id=?`, [existing[field], application.id]);
    await assert.rejects(approve(application.id), e => e.status === 409 && /already has a membership/.test(e.message));
    assert.equal((await get('SELECT status FROM member_applications WHERE id=?', [application.id])).status, 'UNDER_REVIEW');
    assert.equal(await get('SELECT id FROM members WHERE application_id=?', [application.id]), undefined);
    assert.equal(await get('SELECT id FROM referral_bonuses WHERE application_id=?', [application.id]), undefined);
    assert.equal((await get('SELECT status FROM membership_bank_payments WHERE application_id=?', [application.id])).status, 'CONFIRMED');
    assert.equal(Number((await get('SELECT COUNT(*) AS n FROM members WHERE id=? AND status=?', [existing.id, 'ACTIVE'])).n), 1);
  }
});
