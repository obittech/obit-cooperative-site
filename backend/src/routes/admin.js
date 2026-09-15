// routes/admin.js — Admin MVP (staff/admin only).
// Approving an application is the one place a `members` row (permanent
// member ID) gets created — deliberately a human decision, not automatic
// on payment webhook, per "PAYMENT_VERIFIED -> UNDER_REVIEW -> ACTIVE"
// in the handover's status flow.

import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';
import { generateMemberCode } from '../utils/auth.js';

export const adminRouter = new Router();

adminRouter.get('/api/admin/dashboard', requireAuth('staff', 'admin'), async (req, res) => {
  const counts = {};
  const rows = all(`SELECT status, COUNT(*) as n FROM member_applications GROUP BY status`);
  rows.forEach((r) => { counts[r.status] = r.n; });
  const activeMembers = get(`SELECT COUNT(*) as n FROM members WHERE status = 'ACTIVE'`).n;
  res.json(200, { applications_by_status: counts, active_members: activeMembers });
});

adminRouter.get('/api/admin/applications', requireAuth('staff', 'admin'), async (req, res) => {
  const applications = all(`SELECT * FROM member_applications ORDER BY updated_at DESC LIMIT 200`);
  res.json(200, applications);
});

adminRouter.post('/api/admin/applications/:id/decision', requireAuth('staff', 'admin'), async (req, res, params) => {
  const application = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  if (!application) throw new HttpError(404, 'Application not found');
  if (application.status !== 'UNDER_REVIEW') {
    throw new HttpError(409, `Application must be UNDER_REVIEW to decide (currently ${application.status})`);
  }

  const { decision, note } = req.body || {}; // 'APPROVE' | 'REJECT' | 'NEEDS_INFORMATION'
  if (!['APPROVE', 'REJECT', 'NEEDS_INFORMATION'].includes(decision)) {
    throw new HttpError(400, "decision must be 'APPROVE', 'REJECT' or 'NEEDS_INFORMATION'");
  }

  if (decision === 'REJECT') {
    run("UPDATE member_applications SET status = 'REJECTED', updated_at = datetime('now') WHERE id = ?", [params.id]);
  } else if (decision === 'NEEDS_INFORMATION') {
    run("UPDATE member_applications SET status = 'NEEDS_INFORMATION', updated_at = datetime('now') WHERE id = ?", [params.id]);
  } else {
    const countRow = get(`SELECT COUNT(*) as n FROM members`);
    const memberCode = generateMemberCode(countRow.n + 1);
    let user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
    if (!user) {
      run('INSERT INTO users (email, phone, role) VALUES (?, ?, ?)', [application.email, application.phone, 'member']);
      user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [application.email, application.phone]);
    }
    run('INSERT INTO members (application_id, user_id, member_code, status) VALUES (?, ?, ?, ?)',
      [params.id, user.id, memberCode, 'ACTIVE']);
    const member = get('SELECT * FROM members WHERE application_id = ?', [params.id]);
    run('INSERT INTO community_onboarding (member_id) VALUES (?)', [member.id]);
    run("INSERT INTO ledger_accounts (member_id) VALUES (?)", [member.id]);
    run("UPDATE member_applications SET status = 'ACTIVE', updated_at = datetime('now') WHERE id = ?", [params.id]);
  }

  audit(req.user.id, `APPLICATION_DECISION_${decision}`, 'member_applications', params.id, { note: note ?? null });
  const updated = get('SELECT * FROM member_applications WHERE id = ?', [params.id]);
  const member = get('SELECT * FROM members WHERE application_id = ?', [params.id]);
  res.json(200, { application: updated, member: member ?? null });
});

adminRouter.get('/api/admin/reconciliation/exceptions', requireAuth('staff', 'admin'), async (req, res) => {
  // Anything with a webhook event recorded but not marked processed, or a
  // payment stuck PENDING for a while, needs a human look.
  const stuckWebhooks = all(`SELECT * FROM webhook_events WHERE processed = 0 ORDER BY received_at DESC`);
  const stuckPayments = all(
    `SELECT * FROM membership_payments WHERE status = 'PAYMENT_PENDING' AND created_at < datetime('now', '-1 day')`
  );
  res.json(200, { stuck_webhooks: stuckWebhooks, stale_pending_payments: stuckPayments });
});

adminRouter.get('/api/admin/audit', requireAuth('staff', 'admin'), async (req, res) => {
  const events = all(`SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200`);
  res.json(200, events);
});
