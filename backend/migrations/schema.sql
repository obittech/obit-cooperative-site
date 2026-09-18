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
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS membership_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES member_applications(id),
  provider       TEXT NOT NULL CHECK (provider IN ('paystack','monnify')),
  reference      TEXT NOT NULL UNIQUE,
  amount         REAL NOT NULL,
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
  frequency      TEXT NOT NULL,          -- Daily / Weekly / Monthly
  purpose        TEXT NOT NULL,          -- Emergency Fund / Business Capital / Rent / ...
  target_amount  REAL,
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
  currency    TEXT NOT NULL DEFAULT 'NGN',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id           INTEGER NOT NULL REFERENCES members(id),
  type                TEXT NOT NULL,     -- MEMBERSHIP_FEE / CONTRIBUTION / ...
  amount              REAL NOT NULL,
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
  bank_name         TEXT,
  account_name      TEXT,
  account_number    TEXT,
  bank_account_id   INTEGER REFERENCES member_bank_accounts(id),
  transfer_reference TEXT,
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
