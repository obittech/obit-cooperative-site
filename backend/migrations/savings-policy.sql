CREATE TABLE IF NOT EXISTS savings_plan_terms (
 plan_id __INT__ PRIMARY KEY REFERENCES contribution_plans(id),
 lock_months INTEGER NOT NULL CHECK(lock_months IN (1,3,6,12)),
 business_type TEXT NOT NULL DEFAULT '', equipment TEXT NOT NULL DEFAULT '',
 started_ms __INT__, maturity_ms __INT__
);
CREATE TABLE IF NOT EXISTS savings_request_terms (
 request_id __INT__ PRIMARY KEY REFERENCES member_finance_requests(id),
 plan_id __INT__ NOT NULL REFERENCES savings_plan_terms(plan_id),
 fee_kobo __INT__ NOT NULL DEFAULT 0, payout_kobo __INT__ NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_loan_requests (
 id __ID__, plan_id __INT__ NOT NULL UNIQUE REFERENCES savings_plan_terms(plan_id),
 member_id __INT__ NOT NULL REFERENCES members(id), reference TEXT NOT NULL UNIQUE,
 target_kobo __INT__ NOT NULL, savings_kobo __INT__ NOT NULL, requested_kobo __INT__ NOT NULL,
 status TEXT NOT NULL DEFAULT 'REQUESTED', created_ms __INT__ NOT NULL
);
