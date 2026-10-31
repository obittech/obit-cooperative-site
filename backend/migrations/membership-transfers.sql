CREATE TABLE IF NOT EXISTS membership_bank_payments (
 id __ID__, application_id __INT__ NOT NULL UNIQUE REFERENCES member_applications(id),
 reference TEXT NOT NULL UNIQUE, amount_kobo __INT__ NOT NULL CHECK(amount_kobo > 0),
 bank_name TEXT NOT NULL, account_name TEXT NOT NULL, account_number TEXT NOT NULL,
 whatsapp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','CLAIMED','CONFIRMED')),
 created_ms __INT__ NOT NULL, claimed_ms __INT__, confirmed_ms __INT__,
 bank_reference TEXT UNIQUE, confirmed_by __INT__ REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS bank_credit_allocations (
 bank_reference TEXT PRIMARY KEY, resource_type TEXT NOT NULL, resource_id __INT__ NOT NULL
);
INSERT INTO bank_credit_allocations (bank_reference, resource_type, resource_id)
 SELECT bank_reference, 'MARKET', id FROM market_bank_payments WHERE bank_reference IS NOT NULL
 ON CONFLICT(bank_reference) DO NOTHING;
