CREATE TABLE IF NOT EXISTS application_reviews (
 application_id INTEGER PRIMARY KEY REFERENCES member_applications(id),
 decision TEXT NOT NULL CHECK(decision IN ('CONDITIONAL_ACCEPTANCE','DUPLICATE_HOLD','RELEASED')),
 retained_application_id INTEGER REFERENCES member_applications(id),
 note TEXT NOT NULL, reviewed_by INTEGER NOT NULL REFERENCES users(id), updated_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS application_support_requests (
 application_id INTEGER PRIMARY KEY REFERENCES member_applications(id),
 message TEXT NOT NULL, updated_ms BIGINT NOT NULL
);
