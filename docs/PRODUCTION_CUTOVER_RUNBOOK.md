# Obit Cooperative Production Cutover Runbook

## Current state
- Production backend is deployed from `main` and reported `Database runtime: postgres` in the Render startup log at 2026-09-24 13:19 UTC.
- The backend supports `DB_ENGINE=sqlite` and `DB_ENGINE=postgres`.
- The guarded sync reported `ok:true` at 2026-09-24 13:17 UTC, with SQLite balance, PostgreSQL balance and ledger totals each 40,000 kobo. The sync script also checked primary-key parity across its listed tables.
- The former SQLite disk is a cutover snapshot. It is not an up-to-date rollback source after PostgreSQL accepts new writes.
- PostgreSQL schema/runtime and API boot have been validated in CI.
- At verification, `GET /api/readiness` returned `database.runtime=postgres` and `database.ok=true`; public opportunities and Market reads succeeded. This does not establish that every protected member flow or recovery procedure has passed.
- Obit Market + SafePay use a multi-community tenant boundary. Obit Cooperative is the anchor community.
- SafePay production money movement is fail-closed until an approved provider's sandbox contract, webhook signature rules and production approval are configured.
- Dojah live KYC remains disabled until KYB/compliance approval.

## Future PostgreSQL cutover or rehearsal
1. Put the member platform into a short maintenance/read-only window.
2. Run `npm run migrate:postgres` from the production service environment so the script can read the mounted SQLite database and write to the configured `DATABASE_URL`.
3. Require the migration to finish with `ok:true`, equal SQLite/PostgreSQL balances and equal ledger totals.
4. Set `DB_ENGINE=postgres`.
5. Redeploy.
6. Verify `GET /api/readiness` reports `database.runtime=postgres`.
7. Smoke-test authentication, membership, KYC status read, member statement, opportunities, admin login and Market read endpoints.
8. Keep the SQLite disk unchanged as cutover evidence during the stabilization window. Record the cutover time and prevent later writes to SQLite.

## Post-cutover verification still required
1. On the paid PostgreSQL instance, confirm a recovery point or export is available and perform a restore into an isolated database. Check a known row and ledger total there. Do not change the production connection during this drill.
2. Compare current PostgreSQL member counts, application counts, transaction counts and balances with the cutover report and subsequent activity. Do not expose personal or financial records in public logs.
3. Smoke-test authenticated member and admin flows with controlled accounts, including a new write and its readback. Confirm SafePay remains disabled until its provider contract and signed sandbox event tests pass.
4. Record the verification time, database identity, recovery point, result and responsible reviewer before closing the cutover.

## Rollback
If a production smoke test fails, stop affected writes and assess whether PostgreSQL has accepted any writes since the final SQLite sync. Preserve both databases and transaction logs. Restore PostgreSQL from a verified recovery point or repair it in place where safe. A switch to the old SQLite disk is only valid if there were no later PostgreSQL writes, or after every later write has been reconciled and replayed. Verify member balances and records before reopening writes. Never let both databases accept independent production writes.

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
