-- Additive marketplace foundation. No custody or payment state is introduced.
-- __ID__, __INT__ and __TIME__ are replaced by the database adapter.
CREATE TABLE IF NOT EXISTS market_buyers (
  id __ID__, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')),
  session_version INTEGER NOT NULL DEFAULT 0, created_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS market_login_challenges (
  id __ID__, reference TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
  code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  expires_ms __INT__ NOT NULL, created_ms __INT__ NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_market_challenge_email ON market_login_challenges(email,created_ms);
CREATE INDEX IF NOT EXISTS idx_market_challenge_created ON market_login_challenges(created_ms);
CREATE TABLE IF NOT EXISTS market_addresses (
  id __ID__, buyer_id __INT__ NOT NULL UNIQUE REFERENCES market_buyers(id),
  recipient TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
  city TEXT NOT NULL, state TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'NG',
  updated_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS market_carts (
  id __ID__, buyer_id __INT__ NOT NULL REFERENCES market_buyers(id),
  listing_id __INT__ NOT NULL REFERENCES market_listings(id),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
  UNIQUE(buyer_id,listing_id)
);
CREATE TABLE IF NOT EXISTS market_inventory (
  id __ID__, listing_id __INT__ NOT NULL UNIQUE REFERENCES market_listings(id),
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL DEFAULT 1, updated_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS market_purchase_requests (
  id __ID__, reference TEXT NOT NULL UNIQUE, buyer_id __INT__ NOT NULL REFERENCES market_buyers(id),
  request_key TEXT NOT NULL, payload_hash TEXT NOT NULL, address_json TEXT NOT NULL,
  subtotal_kobo __INT__ NOT NULL CHECK(subtotal_kobo>0),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','CANCELLED')),
  created_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(buyer_id,request_key)
);
CREATE INDEX IF NOT EXISTS idx_market_requests_buyer ON market_purchase_requests(buyer_id,id);
CREATE TABLE IF NOT EXISTS market_request_shops (
  id __ID__, request_id __INT__ NOT NULL REFERENCES market_purchase_requests(id),
  seller_member_id __INT__ NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','QUOTED','DECLINED','CANCELLED')),
  delivery_kobo __INT__, delivery_days INTEGER, seller_note TEXT NOT NULL DEFAULT '',
  updated_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(request_id,seller_member_id)
);
CREATE INDEX IF NOT EXISTS idx_market_request_seller ON market_request_shops(seller_member_id,id);
CREATE TABLE IF NOT EXISTS market_request_items (
  id __ID__, shop_id __INT__ NOT NULL REFERENCES market_request_shops(id),
  listing_id __INT__ NOT NULL REFERENCES market_listings(id), title TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
  unit_kobo __INT__ NOT NULL CHECK(unit_kobo>0)
);

CREATE TABLE IF NOT EXISTS market_auth_guard (id INTEGER PRIMARY KEY, touched INTEGER NOT NULL DEFAULT 0);
INSERT INTO market_auth_guard (id,touched) VALUES (1,0) ON CONFLICT(id) DO NOTHING;

-- Store identities require staff review. Evidence is private to operations.
CREATE TABLE IF NOT EXISTS market_stores (
  id __ID__, seller_member_id __INT__ NOT NULL UNIQUE REFERENCES members(id),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  official INTEGER NOT NULL DEFAULT 0 CHECK(official IN (0,1)),
  verification_note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  updated_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS market_promotions (
  id __ID__, listing_id __INT__ NOT NULL UNIQUE REFERENCES market_listings(id),
  label TEXT NOT NULL, price_kobo __INT__ NOT NULL CHECK(price_kobo>=2000000),
  base_kobo __INT__ NOT NULL, starts_ms __INT__ NOT NULL, ends_ms __INT__ NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1, updated_at __TIME__ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
