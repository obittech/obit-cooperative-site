# Payment webhook and health-check hardening

Prepared 23 October 2026. This release does not establish approval for live-money use.

## Behavior

- Signed Paystack charge events require `charge.success`, `status=success`, explicit positive integer kobo amount, currency, reference and the domain matching the configured test/live secret-key prefix.
- Live callbacks require the existing `PAYSTACK_LIVE_ENABLED=true` switch. The change does not turn it on or install credentials.
- Unrelated Paystack event types are acknowledged without modifying financial records. Missing event types and malformed data are rejected.
- Membership callbacks must match the recorded provider. Transfer callbacks must match the recorded withdrawal amount and NGN currency.
- Local sandbox signature mode is rejected when `NODE_ENV=production`.
- Financial updates, audit entries and processed-event bookkeeping commit together before the HTTP acknowledgement. PostgreSQL transaction-scoped locks serialize webhook deliveries by payment reference; SQLite webhook deliveries are queued on its single connection.
- Event identity includes the event type so a transfer reversal does not disappear behind an earlier success with the same provider ID. Reversals remain audit exceptions for finance review; this release does not automate reversal credits.
- `/api/health` now performs a read-only database probe and returns 503 on failure or after a two-second response deadline. It returns no credentials or internal error details. The existing `/api/readiness` remains available.

## Validation

Run `cd backend && npm test`. Tests use an isolated in-memory SQLite database unless `DB_ENGINE=postgres` is explicitly supplied with a disposable `DATABASE_URL` and `PGSSL=disable` for local CI.

Coverage includes missing and malformed values, signature rejection, event type, provider/domain mismatch, disabled live processing, repeated and concurrent contribution callbacks, single ledger credit, transfer amount mismatch, transaction rollback/retry, reversal event identity, and healthy/failed/timed-out health probes. Synthetic events signed with test fixtures are not evidence of Paystack provider delivery or settlement.

The PostgreSQL Runtime Validation workflow runs this suite against SQLite and its disposable PostgreSQL service. Do not point the suite at production: it migrates and seeds test rows.

## Release and monitoring

1. Require passing CI on the reviewed commit before merging. Keep current live-money and KYC flags unchanged.
2. After the intended API commit is live, verify `/api/health` returns 200 and the expected compact response.
3. In the existing Render API service, set Health Check Path to `/api/health`, then verify the resulting deployment and health behavior. Adding the endpoint in source does not configure Render. No new Render service is required.
4. Run controlled Paystack test-mode checkout and capture authentic signed delivery evidence, duplicate delivery behavior, ledger reconciliation and the corresponding provider record.
5. Retain existing unprocessed events for finance investigation; this change does not replay historical events or repair historical partial postings.

## Remaining launch requirements

Provider approval and merchant-entity routing, final membership pricing, a separate membership/contribution activation policy, payout-initiation concurrency, actual deployed key modes, current MFA verification, secure production read-only reporting and current restoration evidence remain separate requirements. Webhook serialization alone does not coordinate other payout routes or guarantee account-wide concurrency safety.
