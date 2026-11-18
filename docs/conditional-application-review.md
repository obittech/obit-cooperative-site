# Conditional administrative review

This is a separate, narrow main-based change. It does not activate members without identity/payment evidence. Conditional acceptance is stored in application_reviews; the original application, KYC and payment statuses remain unchanged. No member ID, user login, ledger or referral bonus is created. Normal activation retains its payment prerequisite.

Administrator-only decisions: CONDITIONAL_ACCEPTANCE, DUPLICATE_HOLD, RELEASED. Staff may view comparison details. Holds require both exact phone and case-insensitive email matches, explicit same-person confirmation, a reason, and no payment or membership record on the held application. Contact matches are candidates, never proof. Holds are reversible and audited, not deletion. Held application writes and membership activation are blocked; reads remain available. Incoming provider callbacks remain intact so evidence is not lost.

Applicant resume shows the separate administrative result. Existing registration recovery authentication is unchanged. Admin queue exposes Review / duplicate hold. A saved conditional decision must never be reported as active membership.

Release gates: fresh main/deploy comparison, PostgreSQL migration/test execution, browser/mobile review including save/repeat/cancel/reopen, independent code review. Local SQLite backend and frontend suites are tested; no live customer data was used. No external messages, verification charges, payment confirmation or membership decisions were performed by this engineering batch.

Concurrency review: payment initiation and bank-transfer creation recheck holds after locking the application row. KYC session creation and charge reservation use the same application lock; a hold cannot be placed while a provider request is DISPATCHED or UNKNOWN. Already in-flight verification must be reconciled, not discarded. Deterministic interleaving tests cover a hold committed after access middleware but before payment/KYC handlers. Final SQLite suite: 191 tests; frontend: 41.

Local release checks: GitHub main compared identical with baseline 0a4f42d. PostgreSQL tools/server unavailable in executor. Cloud browser cannot reach executor loopback QA server (ERR_CONNECTION_REFUSED), so no browser/mobile success is claimed. Render workspace selection missing; deployment SHA not verified. Remains unpublished.
