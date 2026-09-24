import { Router, HttpError } from '../router.js';
import { get, all, run } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { audit } from '../utils/audit.js';

export const opportunitiesRouter = new Router();

async function memberForUser(userId) {
  const member = await get('SELECT * FROM members WHERE user_id = ?', [userId]);
  if (!member || member.status !== 'ACTIVE') throw new HttpError(403, 'Active cooperative membership is required');
  return member;
}

function publicFields(row) {
  return {
    id: row.id,
    slug: row.slug,
    headline: row.headline,
    category: row.category,
    public_summary: row.public_summary,
    source_name: row.source_name,
    source_url: row.source_url,
    deadline: row.deadline,
    location: row.location,
    status: row.status,
    fit_score: row.fit_score,
    next_action: row.next_action,
    published_at: row.published_at,
    members_only: Boolean(row.members_only),
  };
}

opportunitiesRouter.get('/api/opportunities', async (_req, res) => {
  const rows = await all(`SELECT * FROM opportunities
                    WHERE publication_status = 'PUBLISHED'
                    ORDER BY featured DESC, COALESCE(deadline, '9999-12-31') ASC, published_at DESC`);
  res.json(200, rows.map(publicFields));
});

opportunitiesRouter.post('/api/me/opportunities/unlock', requireAuth('member'), async (req, res) => {
  const member = await memberForUser(req.user.id);
  const accessCode = String(req.body?.access_code || '').trim().toUpperCase();
  if (!accessCode) throw new HttpError(400, 'Enter your member access code');
  if (accessCode !== String(member.member_code).trim().toUpperCase()) {
    await audit(req.user.id, 'OPPORTUNITY_ACCESS_DENIED', 'members', member.id);
    throw new HttpError(403, 'The access code does not match this member account');
  }

  const rows = await all(`SELECT id, slug, headline, category, public_summary, full_summary,
                           why_it_matters, source_name, source_url, eligibility, deadline,
                           location, funding_benefit, required_contribution, conditions,
                           application_steps, documents_required, risks, fit_verdict,
                           fit_score, next_action, status, published_at
                    FROM opportunities
                    WHERE publication_status = 'PUBLISHED'
                    ORDER BY featured DESC, COALESCE(deadline, '9999-12-31') ASC, published_at DESC`);
  await audit(req.user.id, 'OPPORTUNITY_HUB_UNLOCKED', 'members', member.id);
  res.json(200, { member_code: member.member_code, opportunities: rows });
});

opportunitiesRouter.get('/api/admin/opportunities', requireAuth('staff', 'admin'), async (_req, res) => {
  res.json(200, await all('SELECT * FROM opportunities ORDER BY updated_at DESC'));
});

opportunitiesRouter.post('/api/admin/opportunities', requireAuth('staff', 'admin'), async (req, res) => {
  const body = req.body || {};
  for (const field of ['slug', 'headline', 'public_summary', 'source_name', 'source_url']) {
    if (!String(body[field] || '').trim()) throw new HttpError(400, field + ' is required');
  }
  if (!/^https:\/\//i.test(body.source_url)) throw new HttpError(400, 'source_url must use HTTPS');

  const result = await run(`INSERT INTO opportunities (
      slug, headline, category, public_summary, full_summary, why_it_matters,
      source_name, source_url, eligibility, deadline, location, funding_benefit,
      required_contribution, conditions, application_steps, documents_required,
      risks, fit_verdict, fit_score, next_action, status, publication_status,
      members_only, featured, published_at, created_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'))`, [
      body.slug.trim(), body.headline.trim(), body.category || 'Business opportunity',
      body.public_summary.trim(), body.full_summary || null, body.why_it_matters || null,
      body.source_name.trim(), body.source_url.trim(), body.eligibility || null,
      body.deadline || null, body.location || 'Nigeria', body.funding_benefit || null,
      body.required_contribution || null, body.conditions || null,
      body.application_steps || null, body.documents_required || null, body.risks || null,
      body.fit_verdict || null, Number.isFinite(Number(body.fit_score)) ? Number(body.fit_score) : null,
      body.next_action || 'WATCH', body.status || 'CONFIRMED',
      body.publication_status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT',
      body.members_only === false ? 0 : 1, body.featured ? 1 : 0, req.user.id
    ]);
  await audit(req.user.id, 'OPPORTUNITY_CREATED', 'opportunities', result.lastInsertRowid);
  res.json(201, await get('SELECT * FROM opportunities WHERE id = ?', [result.lastInsertRowid]));
});

opportunitiesRouter.patch('/api/admin/opportunities/:id', requireAuth('staff', 'admin'), async (req, res, params) => {
  const current = await get('SELECT * FROM opportunities WHERE id = ?', [params.id]);
  if (!current) throw new HttpError(404, 'Opportunity not found');
  const allowed = ['headline','category','public_summary','full_summary','why_it_matters','source_name',
    'source_url','eligibility','deadline','location','funding_benefit','required_contribution',
    'conditions','application_steps','documents_required','risks','fit_verdict','fit_score',
    'next_action','status','publication_status','members_only','featured'];
  const updates = [];
  const values = [];
  for (const field of allowed) {
    if (!(field in (req.body || {}))) continue;
    let value = req.body[field];
    if (field === 'source_url' && value && !/^https:\/\//i.test(value)) throw new HttpError(400, 'source_url must use HTTPS');
    if (['members_only','featured'].includes(field)) value = value ? 1 : 0;
    updates.push(field + ' = ?');
    values.push(value);
  }
  if (!updates.length) throw new HttpError(400, 'No supported fields supplied');
  updates.push("updated_at = datetime('now')");
  values.push(params.id);
  await run(`UPDATE opportunities SET ${updates.join(', ')} WHERE id = ?`, values);
  await audit(req.user.id, 'OPPORTUNITY_UPDATED', 'opportunities', params.id, { fields: updates });
  res.json(200, await get('SELECT * FROM opportunities WHERE id = ?', [params.id]));
});
