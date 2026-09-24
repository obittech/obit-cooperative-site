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
);
