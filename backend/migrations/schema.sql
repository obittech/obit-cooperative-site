-- Obit Membership MVP — Release 1 schema
-- SQLite via Node's built-in node:sqlite (portable, zero native-build dependency).
-- Designed to migrate cleanly to PostgreSQL for Obit One (see README "Migration path").
-- Status vocabularies follow the Obit Project Master Context handover exactly.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE,
  phone           TEXT UNIQUE,
  password_hash   TEXT,               -- scrypt hash, set once member activates portal access
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','staff','admin')),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Membership application funnel (Release 1)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS member_applications (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                   INTEGER REFERENCES users(id),
  full_legal_name           TEXT,
  date_of_birth             TEXT,
  gender                    TEXT,
  phone                     TEXT,
  whatsapp                  TEXT,
  email                     TEXT,
  address                   TEXT,
  state                     TEXT,
  lga                       TEXT,
  occupation_category       TEXT,      -- salary earner / trader / artisan / driver / tech worker / shop owner / MSME ...
  membership_type           TEXT,
  application_date           TEXT NOT NULL DEFAULT (datetime('now')),
  next_of_kin_name           TEXT,
  next_of_kin_phone          TEXT,
  intended_savings_amount    REAL,
  intended_savings_frequency TEXT,      -- Daily / Weekly / Monthly
  interests_json             TEXT,      -- JSON array: savings, business support, financing, FFK, agriculture, training
  referral_source            TEXT,
  campaign                   TEXT,
  status TEXT NOT NULL DEFAULT 'LEAD' CHECK (status IN (
    'LEAD','APPLICATION_STARTED','APPLICATION_SUBMITTED',
    'KYC_PENDING','KYC_VERIFIED','KYC_FAILED',
    'PAYMENT_PENDING','PAYMENT_VERIFIED','PAYMENT_FAILED',
    'UNDER_REVIEW','NEEDS_INFORMATION','REJECTED','ACTIVE','SUSPENDED','CLOSED'
  )),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES member_applications(id),
  type           TEXT NOT NULL,         -- terms / privacy / marketing
  accepted       INTEGER NOT NULL DEFAULT 0,
  accepted_at    TEXT,
  ip_address     TEXT
);

CREATE TABLE IF NOT EXISTS kyc_checks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id     INTEGER NOT NULL REFERENCES member_applications(id),
  provider           TEXT NOT NULL DEFAULT 'SANDBOX',   -- swap for real KYC provider in production
  session_ref        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'KYC_PENDING' CHECK (status IN ('KYC_PENDING','KYC_VERIFIED','KYC_FAILED')),
  raw_status_detail  TEXT,
  verified_at        TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS membership_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES member_applications(id),
  provider       TEXT NOT NULL CHECK (provider IN ('paystack','monnify')),
  reference      TEXT NOT NULL UNIQUE,
  amount         REAL NOT NULL,
  amount_kobo    INTEGER,
  currency       TEXT NOT NULL DEFAULT 'NGN',
  status         TEXT NOT NULL DEFAULT 'PAYMENT_PENDING' CHECK (status IN ('PAYMENT_PENDING','PAYMENT_VERIFIED','PAYMENT_FAILED')),
  verified_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Activated members
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS members (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL UNIQUE REFERENCES member_applications(id),
  user_id        INTEGER REFERENCES users(id),
  member_code    TEXT NOT NULL UNIQUE,   -- permanent member ID, e.g. OBT-2026-000123
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  activated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS community_onboarding (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id              INTEGER NOT NULL UNIQUE REFERENCES members(id),
  whatsapp_joined        INTEGER NOT NULL DEFAULT 0,
  orientation_completed  INTEGER NOT NULL DEFAULT 0,
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Release 2 shape (tables exist now so Release 1 data migrates cleanly;
-- no business logic writes to ledger_* / contribution_plans yet — COMING NEXT)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contribution_plans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id      INTEGER NOT NULL REFERENCES members(id),
  amount         REAL NOT NULL,
  amount_kobo    INTEGER,
  frequency      TEXT NOT NULL,          -- Daily / Weekly / Monthly
  purpose        TEXT NOT NULL,          -- Emergency Fund / Business Capital / Rent / ...
  target_amount  REAL,
  target_amount_kobo INTEGER,
  status         TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE','PAUSED','CLOSED')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  provider      TEXT NOT NULL,
  identity_ref  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  account_type TEXT NOT NULL DEFAULT 'SAVINGS',
  balance     REAL NOT NULL DEFAULT 0,
  balance_kobo INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'NGN',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL REFERENCES members(id),
  type                TEXT NOT NULL,     -- MEMBERSHIP_FEE / CONTRIBUTION / ...
  amount              REAL NOT NULL,
  amount_kobo         INTEGER,
  currency            TEXT NOT NULL DEFAULT 'NGN',
  provider_reference  TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  transaction_id    INTEGER NOT NULL REFERENCES transactions(id),
  direction         TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount            REAL NOT NULL,
  amount_kobo       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ledger_account_id, transaction_id, direction)
);

CREATE TABLE IF NOT EXISTS member_bank_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         INTEGER NOT NULL REFERENCES members(id),
  bank_code         TEXT NOT NULL,
  bank_name         TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  account_name      TEXT NOT NULL,
  recipient_code    TEXT,
  verified_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(member_id, bank_code, account_number)
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         INTEGER NOT NULL REFERENCES members(id),
  ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
  amount            REAL NOT NULL CHECK (amount > 0),
  amount_kobo       INTEGER,
  bank_name         TEXT,
  account_name      TEXT,
  account_number    TEXT,
  bank_account_id   INTEGER REFERENCES member_bank_accounts(id),
  transfer_reference TEXT,
  provider_status   TEXT NOT NULL DEFAULT 'not_started',
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PAID','CANCELLED')),
  reviewed_by       INTEGER REFERENCES users(id),
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
  receipt_number TEXT NOT NULL UNIQUE,
  issued_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Platform plumbing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed   INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, event_id)             -- idempotency guard
);

CREATE TABLE IF NOT EXISTS referrals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES member_applications(id),
  referral_code  TEXT,
  referred_by    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  INTEGER,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      INTEGER,
  detail_json    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ---------------------------------------------------------------------------
-- Verified opportunity hub
-- Public visitors receive teaser fields only. Full application guidance is
-- returned exclusively after an active member authenticates and supplies the
-- member code tied to that same account.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opportunities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                  TEXT NOT NULL UNIQUE,
  headline              TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'Business opportunity',
  public_summary        TEXT NOT NULL,
  full_summary          TEXT,
  why_it_matters        TEXT,
  source_name           TEXT NOT NULL,
  source_url            TEXT NOT NULL,
  eligibility           TEXT,
  deadline              TEXT,
  location              TEXT DEFAULT 'Nigeria',
  funding_benefit       TEXT,
  required_contribution TEXT,
  conditions            TEXT,
  application_steps     TEXT,
  documents_required    TEXT,
  risks                 TEXT,
  fit_verdict           TEXT,
  fit_score             INTEGER CHECK (fit_score IS NULL OR (fit_score >= 0 AND fit_score <= 100)),
  next_action           TEXT NOT NULL DEFAULT 'WATCH' CHECK (next_action IN ('DO_TODAY','PREPARE_THIS_WEEK','WATCH','IGNORE')),
  status                TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','PROSPECTIVE','CLOSED')),
  publication_status    TEXT NOT NULL DEFAULT 'DRAFT' CHECK (publication_status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  members_only          INTEGER NOT NULL DEFAULT 1,
  featured              INTEGER NOT NULL DEFAULT 0,
  published_at          TEXT,
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_opportunities_publication
ON opportunities(publication_status, status, deadline);


INSERT OR IGNORE INTO opportunities (
  slug, headline, category, public_summary, full_summary, why_it_matters,
  source_name, source_url, eligibility, deadline, location, funding_benefit,
  required_contribution, conditions, application_steps, documents_required,
  risks, fit_verdict, fit_score, next_action, status, publication_status,
  members_only, featured, published_at
) VALUES
(
  'credicorp-partnership-route-2026',
  'CREDICORP partnership route for responsible productive-asset access',
  'Development finance and partnership',
  'CREDICORP invites financial institutions and vendors or manufacturers to explore partnership routes. Obit has not been approved as a partner, and this is not a grant announcement.',
  'CREDICORP is a Federal Government development finance institution focused on expanding responsible consumer credit. Its public partnership route may be relevant to technology, vendor, distribution or financial-institution partners, subject to CREDICORP assessment.',
  'A properly structured relationship could eventually help eligible Nigerians obtain productive devices, energy solutions or other assets through approved credit providers. No benefit to Obit members is confirmed at this stage.',
  'CREDICORP',
  'https://credicorp.ng/',
  'The official page does not publish one universal partner-eligibility checklist. The applicant must truthfully identify its role and provide evidence of legal status, operations, customer safeguards and relevant capability.',
  NULL,
  'Nigeria',
  'Potential partnership, vendor access, distribution support or wholesale credit support depending on the approved category. No grant amount is stated.',
  'Not stated publicly. Any credit product may carry provider-specific repayment costs.',
  'No Obit entity should present itself as a lender, CREDICORP partner or approved vendor until formally authorised.',
  '1. Review the official Become a Partner route.\n2. Select the truthful partner category.\n3. Prepare a capability note using verified operations only.\n4. Assemble corporate, compliance and evidence documents.\n5. Obtain Chief Obinna''s approval before submitting or accepting terms.',
  'Registration documents; ownership and management details; verified service description; operating evidence; financial records requested by CREDICORP; customer-protection and data-handling approach; supplier or financing relationships if applicable.',
  'Main risks are regulatory overstatement, unsuitable credit terms, inability to evidence operations, or implying a partnership before approval. Do not pay unofficial agents.',
  'Best current fit is Obit Technologies Limited, with FFK described only as a proposed delivery channel. Cooperative eligibility as a financing institution remains unverified.',
  76,
  'PREPARE_THIS_WEEK',
  'CONFIRMED',
  'PUBLISHED',
  1,
  1,
  '2026-09-24 08:00:00'
),
(
  'smedan-registration-route-2026',
  'SMEDAN registration can strengthen an MSME profile—but does not guarantee funding',
  'MSME support',
  'SMEDAN operates an official business-registration portal that may connect registered MSMEs to government and private-sector support. Registration itself is not a grant award.',
  'The SMEDAN portal is a foundational MSME registration route. An eligible business can create or verify its profile and use that record when pursuing relevant programmes, but each opportunity has separate conditions.',
  'For a trader, artisan or small business, a consistent official business profile can make later applications easier to verify and reduce dependence on agents promising guaranteed grants.',
  'SMEDAN',
  'https://portal.smedan.gov.ng/',
  'Nigerian micro, small and medium enterprises using the truthful legal and operating category. Cooperative-category eligibility should be confirmed before registration.',
  NULL,
  'Nigeria',
  'Registration and potential access to relevant public or private support information. No automatic loan or grant is promised.',
  'No fee or contribution is stated on the official sign-up page used for this briefing.',
  'Avoid duplicate profiles and do not select an inaccurate business type. Programme benefits remain subject to their own rules.',
  '1. Check whether the entity already has a SMEDAN profile.\n2. Gather the registered name, number, address, sector, contacts and ownership details.\n3. Use the official portal only.\n4. Verify every entry before submission.\n5. Retain the confirmation for later programme applications.',
  'Registration certificate and number; business address and contacts; sector and operating description; ownership or management details; existing SMEDAN identifier if any.',
  'Duplicate registration, incorrect classification and unofficial agents charging for guaranteed access are the principal risks.',
  'Good foundational fit for Obit Technologies Limited. Cooperative registration should wait until the portal category is confirmed.',
  67,
  'PREPARE_THIS_WEEK',
  'CONFIRMED',
  'PUBLISHED',
  1,
  0,
  '2026-09-24 08:00:00'
),
(
  '3mtt-partner-network-2026',
  '3MTT Partner Network is accepting organisations on a rolling basis',
  'Technology partnership and skills',
  'The Federal Government''s 3MTT Partner Network accepts expressions of interest from registered organisations that can deliver training, hire talent, support innovation, provide funding or extend programme reach. Applications are reviewed on a rolling basis.',
  'The 3MTT Partner Network has six participation tiers. Obit Technologies could truthfully explore the Delivery Network, Employer and Talent Network, Innovation and Enterprise Network, or Amplification Network, subject to evidence of actual capacity and agreement with the programme team.',
  'For Nigerians, the programme can widen access to digital training, internships, jobs and practical technology support. Participation by an organisation does not guarantee grants, contracts or automatic selection.',
  '3 Million Technical Talent Programme',
  'https://3mtt.nitda.gov.ng/partnership/',
  'Registered organisations may apply. Each tier requires evidence matching the contribution offered, such as training delivery, technology platforms, hiring commitments, incubation support, funding or media reach.',
  NULL,
  'Nigeria',
  'Possible partner recognition, access to programme tools and talent, training resources, grants or contract consideration where applicable. No guaranteed cash award is stated.',
  'No application fee is stated. The applicant must commit credible staff time, facilities, tools, placements, programme support or reach appropriate to the chosen tier.',
  'The application is followed by a scope-alignment call and, if accepted, a memorandum of understanding. Obit must not promise facilities, jobs, funding, cohorts or nationwide delivery that it cannot evidence.',
  '1. Select only the partnership tier Obit can presently support.\n2. Prepare a one-page capability statement and evidence list.\n3. Complete the official expression-of-interest form.\n4. Attend the alignment call if invited.\n5. Review any proposed memorandum of understanding before acceptance.',
  'CAC certificate; company profile; website; primary contact details; service and programme description; team profiles; evidence of training, technology, recruitment, incubation or community reach; proposed contribution; locations; measurable outcomes; references where available.',
  'Selection is not guaranteed. Overstating facilities, trainees, jobs, reach or funding capacity would create reputational and contractual risk. Any memorandum of understanding requires legal and management review.',
  'Strong fit for Obit Technologies Limited. The best initial case is technology-enabled delivery and amplification, with FFK or the Cooperative mentioned only where verified and relevant.',
  88,
  'DO_TODAY',
  'CONFIRMED',
  'PUBLISHED',
  1,
  1,
  '2026-09-24 09:30:00'
),
(
  'nitda-iicp-registration-2026',
  'NITDA registration can strengthen Obit Technologies for government ICT work',
  'Technology compliance and procurement readiness',
  'NITDA maintains a registration process for indigenous IT service providers and consultants seeking to serve Federal Ministries, Departments and Agencies. Registration requires an online application, supporting documents and a signed letter to the Director-General.',
  'Registration places qualified firms in the national database of indigenous IT companies. NITDA states that a satisfactory applicant may first receive a six-month provisional certificate and later a substantive certificate valid for two years, subject to verification.',
  'For Nigerian businesses, stronger registration of local technology providers can improve accountability and local participation in public ICT projects. Registration itself does not award a contract.',
  'National Information Technology Development Agency',
  'https://nitda.gov.ng/registration-of-contractors-service-providers/',
  'Nigerian IT service providers or consultants that can prove their corporate status, technical service areas, personnel capacity and supporting records.',
  NULL,
  'Nigeria',
  'Possible entry in NITDA''s national database of indigenous IT companies, a provisional certificate for six months and, after verification, a substantive certificate valid for two years.',
  'The official information reviewed does not state the applicable fee. Preparation and physical submission costs may arise.',
  'Information and documents are verified. Fabricated or unsupported documents can lead to refusal or revocation. Renewal should be submitted at least three months before expiry.',
  '1. Review the official NITDA requirements and service categories.\n2. Audit Obit''s corporate, tax, personnel and project evidence.\n3. Complete the IICP portal application.\n4. Prepare a signed application letter addressed to the Director-General of NITDA.\n5. Submit the form and stipulated documents through the official route.\n6. Track provisional review and respond to any compliance recommendations.',
  'CAC certificate and company records; tax and statutory compliance records requested by the form; company profile; office and contact details; service categories; technical staff CVs and qualifications; project evidence and references; signed application letter; any required financial or infrastructure evidence.',
  'Obit may not yet have enough completed-project evidence or every statutory certificate. Registration does not guarantee procurement awards, and inaccurate capability claims could cause refusal.',
  'Very strong foundational fit for Obit Technologies Limited, especially before pursuing more Federal Government ICT tenders.',
  90,
  'PREPARE_THIS_WEEK',
  'CONFIRMED',
  'PUBLISHED',
  1,
  1,
  '2026-09-24 09:30:00'
),
(
  'nitda-naccima-msme-digital-partnership-2026',
  'NITDA and NACCIMA begin an MSME digital-transformation partnership',
  'MSME digital transformation',
  'NITDA and NACCIMA announced a formal partnership on 15 September 2026 covering MSME digital transformation, capacity building, technology adoption and a collaborative digital ecosystem. No public application window was announced in the official release.',
  'The memorandum of understanding is intended to connect government, organised private-sector bodies, technology companies, investors and development partners. Implementation is expected to begin, but specific beneficiary and vendor selection routes are not yet published.',
  'Traders and small businesses may later gain access to digital-skills, technology-adoption or market-support activities. These benefits remain prospective until implementation details are officially released.',
  'National Information Technology Development Agency',
  'https://nitda.gov.ng/nitda-naccima-seal-strategic-partnership-to-accelerate-nigerias-digital-economy-msme-digital-transformation/9803/',
  'No public application eligibility was announced. Future participation may involve NACCIMA members, MSMEs, technology companies, training providers or ecosystem partners, subject to later official guidance.',
  NULL,
  'Nigeria',
  'Prospective access to capacity building, digital adoption, innovation support, market linkages and ecosystem collaboration. No funding amount or guaranteed benefit is stated.',
  'Not stated because no application route has been announced.',
  'This is confirmed news but only a prospective opportunity. Do not contact unofficial agents or present Obit as an implementing partner.',
  '1. Monitor NITDA and NACCIMA official channels.\n2. Prepare a short MSME digitisation capability note.\n3. Identify a realistic pilot for Abuja MSMEs.\n4. Wait for an official implementation, vendor or beneficiary route.\n5. Seek approval before sending a partnership approach.',
  'Company profile; CAC certificate; MSME digitisation service description; team profiles; pilot concept; verifiable client or project evidence; data-protection approach; proposed outcomes and delivery locations.',
  'There is presently no open application and no stated funding. Pursuing unofficial invitations or claiming programme affiliation would be misleading.',
  'Good watch-list fit for Obit Technologies Limited and a possible future member-benefit channel for Obit Cooperative.',
  72,
  'WATCH',
  'PROSPECTIVE',
  'PUBLISHED',
  1,
  0,
  '2026-09-24 09:30:00'
);

UPDATE opportunities
SET source_url = 'https://credicorp-register.ng/vendor-application', updated_at = datetime('now')
WHERE slug = 'credicorp-partnership-route-2026';

UPDATE opportunities
SET source_url = 'https://smedan.gov.ng/our-programs/ssp/', updated_at = datetime('now')
WHERE slug = 'smedan-registration-route-2026';


-- Obit Market + SafePay multi-community infrastructure
CREATE TABLE IF NOT EXISTS communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL, community_type TEXT NOT NULL DEFAULT 'cooperative',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO communities (slug,legal_name,display_name,community_type,status)
VALUES ('obit-cooperative','Obit Technologies Multipurpose Cooperative Society Limited','Obit Cooperative Society','cooperative','ACTIVE');
CREATE TABLE IF NOT EXISTS market_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id),
  seller_member_id INTEGER NOT NULL REFERENCES members(id), title TEXT NOT NULL, description TEXT,
  category TEXT NOT NULL DEFAULT 'Other', price_kobo INTEGER NOT NULL CHECK(price_kobo>0),
  currency TEXT NOT NULL DEFAULT 'NGN', status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('DRAFT','ACTIVE','PAUSED','SOLD','REMOVED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS market_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id),
  reference TEXT NOT NULL UNIQUE, listing_id INTEGER NOT NULL REFERENCES market_listings(id),
  buyer_member_id INTEGER NOT NULL REFERENCES members(id), seller_member_id INTEGER NOT NULL REFERENCES members(id),
  amount_kobo INTEGER NOT NULL CHECK(amount_kobo>0), currency TEXT NOT NULL DEFAULT 'NGN',
  provider TEXT, provider_escrow_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK(status IN ('CREATED','AWAITING_FUNDING','FUNDED','DELIVERING','DELIVERED','DELIVERY_CONFIRMED','DISPUTED','RELEASE_PENDING','RELEASED','REFUND_PENDING','REFUNDED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS market_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES market_orders(id),
  opened_by_member_id INTEGER NOT NULL REFERENCES members(id), reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','UNDER_REVIEW','BUYER_WINS','SELLER_WINS','RESOLVED')),
  resolution_note TEXT, resolved_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS safepay_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, event_id TEXT NOT NULL,
  order_id INTEGER REFERENCES market_orders(id), event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(provider,event_id)
);
CREATE INDEX IF NOT EXISTS idx_market_listings_community_status ON market_listings(community_id,status);
CREATE INDEX IF NOT EXISTS idx_market_orders_community ON market_orders(community_id);
CREATE INDEX IF NOT EXISTS idx_market_orders_buyer ON market_orders(buyer_member_id);
CREATE INDEX IF NOT EXISTS idx_market_orders_seller ON market_orders(seller_member_id);
