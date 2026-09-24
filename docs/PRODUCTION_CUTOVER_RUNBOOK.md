# Obit Cooperative Production Cutover Runbook

## Current state
- Production backend is deployed from `main`.
- The backend supports `DB_ENGINE=sqlite` and `DB_ENGINE=postgres`.
- SQLite remains the rollback source until the final cutover is completed.
- PostgreSQL schema/runtime and API boot have been validated in CI.
- Obit Market + SafePay use a multi-community tenant boundary. Obit Cooperative is the anchor community.
- SafePay production money movement is fail-closed until an approved provider's sandbox contract, webhook signature rules and production approval are configured.
- Dojah live KYC remains disabled until KYB/compliance approval.

## PostgreSQL cutover
1. Put the member platform into a short maintenance/read-only window.
2. Run `npm run migrate:postgres` from the production service environment so the script can read the mounted SQLite database and write to the configured `DATABASE_URL`.
3. Require the migration to finish with `ok:true`, equal SQLite/PostgreSQL balances and equal ledger totals.
4. Set `DB_ENGINE=postgres`.
5. Redeploy.
6. Verify `GET /api/readiness` reports `database.runtime=postgres`.
7. Smoke-test authentication, membership, KYC status read, member statement, opportunities, admin login and Market read endpoints.
8. Keep the SQLite disk unchanged as rollback evidence during the stabilization window.

## Rollback
If any production smoke test fails:
1. Set `DB_ENGINE=sqlite`.
2. Redeploy.
3. Confirm readiness and member balances.
4. Investigate PostgreSQL without writing new production data to both databases concurrently.

## KYC go-live
Do not change `DOJAH_ENV` to live until Dojah confirms KYB approval and production credentials/permissions. Before enabling live:
- remove sandbox-only diagnostics from member responses;
- confirm NIN and BVN production response mappings;
- retain bounded retries and fail-closed unknown responses;
- verify privacy notice, consent, retention and incident handling;
- perform a controlled real-user pilot before broad activation.

## SafePay go-live
Keep `SAFEPAY_PROVIDER_ENABLED=false` until:
- Obit Technologies/provider contracting structure is confirmed;
- sandbox credentials and exact webhook signature/event contract are received;
- signed/idempotent webhook tests pass;
- create -> fund -> deliver -> release/refund and dispute flows pass;
- production terms, complaints and data roles are approved.
No browser-side action may mark an order FUNDED.

## Hardening checklist
- Server-side session revocation: implemented.
- Password reset revokes prior sessions: implemented.
- Integer-kobo parser for money-moving member routes: implemented.
- Member-facing bank account masking: implemented.
- Privacy, platform terms and member policies: published.
- robots.txt and sitemap.xml: published.
- Production readiness endpoint: implemented.
- PostgreSQL paid/retained production plan: required before relying on the database beyond the free-instance expiry.
- Backup/restore drill: perform after paid PostgreSQL retention is confirmed.
