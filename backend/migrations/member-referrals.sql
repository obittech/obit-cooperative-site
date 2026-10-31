CREATE TABLE IF NOT EXISTS member_code_sequences (
 code_year TEXT PRIMARY KEY, last_value __INT__ NOT NULL DEFAULT 0 CHECK(last_value >= 0)
);
CREATE TABLE IF NOT EXISTS application_sponsors (
 application_id __INT__ PRIMARY KEY REFERENCES member_applications(id),
 sponsor_member_id __INT__ NOT NULL REFERENCES members(id),
 member_code TEXT NOT NULL, full_legal_name TEXT NOT NULL, phone TEXT NOT NULL,
 created_ms __INT__ NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_application_sponsors_member ON application_sponsors(sponsor_member_id);
CREATE TABLE IF NOT EXISTS referral_bonuses (
 id __ID__, application_id __INT__ NOT NULL UNIQUE REFERENCES member_applications(id),
 sponsor_member_id __INT__ NOT NULL REFERENCES members(id),
 amount_kobo __INT__ NOT NULL DEFAULT 50000 CHECK(amount_kobo = 50000),
 status TEXT NOT NULL DEFAULT 'EARNED' CHECK(status IN ('EARNED','PAID')),
 earned_ms __INT__ NOT NULL, paid_ms __INT__, paid_by __INT__ REFERENCES users(id),
 payout_reference TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_referral_bonuses_member ON referral_bonuses(sponsor_member_id);
