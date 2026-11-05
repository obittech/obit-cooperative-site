CREATE TABLE IF NOT EXISTS member_finance_requests (
 id __ID__, member_id __INT__ NOT NULL REFERENCES members(id),
 reference TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('DEPOSIT','WITHDRAWAL')),
 amount_kobo __INT__ NOT NULL CHECK(amount_kobo > 0),
 purpose TEXT NOT NULL, frequency TEXT NOT NULL,
 bank_name TEXT NOT NULL, account_name TEXT NOT NULL, account_number TEXT NOT NULL,
 designation TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('READY','REPORTED','CONFIRMED','PAID','REJECTED')),
 bank_reference TEXT UNIQUE, transaction_id __INT__ UNIQUE REFERENCES transactions(id),
 created_ms __INT__ NOT NULL, confirmed_ms __INT__, confirmed_by __INT__ REFERENCES users(id),
 UNIQUE(member_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS member_finance_requests_member ON member_finance_requests(member_id,status);
