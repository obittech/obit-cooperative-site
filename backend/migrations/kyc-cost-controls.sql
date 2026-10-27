-- Shared by SQLite and PostgreSQL. No identity numbers, hashes or payloads.
CREATE TABLE IF NOT EXISTS kyc_dispatch_guard (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
INSERT INTO kyc_dispatch_guard (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS kyc_provider_requests (
  id TEXT PRIMARY KEY,
  application_id BIGINT NOT NULL,
  check_id BIGINT NOT NULL,
  environment TEXT NOT NULL,
  product TEXT NOT NULL,
  state TEXT NOT NULL,
  reserved_kobo BIGINT NOT NULL,
  started_ms BIGINT NOT NULL,
  finished_ms BIGINT,
  provider_status INTEGER
);
CREATE INDEX IF NOT EXISTS kyc_request_application ON kyc_provider_requests(application_id, started_ms);
CREATE INDEX IF NOT EXISTS kyc_request_environment ON kyc_provider_requests(environment, started_ms);

-- Provider tracking metadata only. Never expose through public KYC routes.
CREATE TABLE IF NOT EXISTS kyc_provider_references (
  request_id TEXT PRIMARY KEY REFERENCES kyc_provider_requests(id),
  reference_id TEXT,
  reference_status TEXT NOT NULL,
  recorded_ms BIGINT NOT NULL
);
