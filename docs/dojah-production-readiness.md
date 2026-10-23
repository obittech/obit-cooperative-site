# Dojah backend readiness, 22 October 2026

## Provider evidence

Ticket #98dca2ce, reply of 21 October at 15:01 Nigerian time, confirms:

- The signed PDF submitted on 20 October is sufficient. No separate Google eSignature is required.
- Compliance remains under review. Approved products and production access have not been confirmed.
- Compliance will clarify remaining items, including principal-partners disclosure and its scope.
- Minimum wallet top-up: NGN 50,000. HTTP 404 responses are chargeable.

Source: https://mail.google.com/mail/u/?authuser=obitcooperative%40gmail.com#all/1a15ec3fc6d7ad4b

Although the reply says a pricing document is attached, the retrieved MIME message contains only plain text and HTML. Gmail attachment searches found no separate pricing document. Do not infer endpoint prices from the top-up amount. Obtain the document and confirm BVN/NIN endpoint names, prices, taxes, chargeable failure codes, timeout billing and any provider idempotency support before live configuration.

## Implemented controls

A durable provider-request ledger reserves allowance before dispatch. A shared database row serializes reservation transactions across PostgreSQL workers. SQLite transactions are queued within the process. No network call occurs inside the reservation transaction.

- Consent is checked again immediately before reservation.
- Only pending/failed KYC applications can reserve, with environment-specific sessions.
- An unfinished dispatch or unknown timeout blocks the application until reconciliation. These blocks do not automatically expire.
- At most one call per application, product and environment in a rolling 24 hours, including failures, corrected numbers and new sessions. This intentionally requires support review for corrections during that period. No identifier fingerprint or raw identity is stored.
- The existing five-attempt allowance is retained, including pre-migration attempts. New requests have accurate per-dispatch rolling timestamps.
- Global rolling 24-hour request and estimated-cost limits are checked atomically. These are application limits, not the provider wallet balance.
- Every dispatch retains its full estimated-cost reservation, including 404, mismatch, errors and timeouts. There are no automatic retries or automatic refunds of allowance.
- Missing approval, product approval, credentials or positive integer limits prevents live dispatch. Sandbox stays the default. The signed MSA is not the approval signal.

The ledger stores random request IDs, application/check references, product, environment, timestamps, outcome, HTTP status and reserved kobo. Audit records contain no raw numbers, identity hashes, provider response payloads, credential values or request URLs. This remains personal operational data through application references. Restrict access under the existing database access policy. Do not purge DISPATCHED/UNKNOWN records or recent reservation rows merely to restore allowance.

## Operator tracking and reconciliation

Read-only summary, using an epoch-millisecond cutoff for the preceding 24 hours:

```sql
SELECT environment, product, state, COUNT(*) AS requests,
       SUM(reserved_kobo) AS estimated_reserved_kobo
FROM kyc_provider_requests
WHERE started_ms >= :cutoff_ms
GROUP BY environment, product, state;

SELECT id, application_id, check_id, environment, product, state,
       started_ms, finished_ms, provider_status, reserved_kobo
FROM kyc_provider_requests
WHERE state IN ('DISPATCHED', 'UNKNOWN')
ORDER BY started_ms;
```

Reconcile ambiguous calls with Dojah using secure operational channels and the approximate time/product. Local request IDs are correlation IDs, not provider idempotency keys. Never send another verification as a reconciliation probe. Check the provider dashboard for actual charges and compare with conservative reservations. A process crash before dispatch may leave a reservation with no charge, which is an intentional safe failure. After a confirmed result, an authorised operator can resolve the specific record to an allowed terminal outcome. Preserve its reservation and history, record the evidence in an audit event, and do not reset attempts or delete it to force a retry. A correction inside 24 hours remains blocked. There is no public bypass endpoint.

## Deployment gates

1. Run `npm run test:kyc` for SQLite and PostgreSQL plus existing CI. PostgreSQL concurrency validation is required before deployment readiness is asserted.
2. Deploy the additive migration and code together in sandbox. Migration runs at boot for both adapters and is repeatable. Verify database migration permissions and back up under the existing process.
3. Keep `DOJAH_ENV=sandbox` and `DOJAH_PRODUCTION_AUTHORIZED=false`. Do not top up the wallet or perform a live identity test during preparation.
4. Obtain express written production approval and exact approved BVN/NIN products/endpoints, outstanding compliance requirements, pricing document and activation instructions.
5. Obtain matching production AppId/secret through secure configuration. Never commit them or paste them into logs, tickets or PRs. Confirm the secret belongs to the approved Cooperative account.
6. Obtain an approved spend ceiling and set positive integer daily request/budget limits plus conservative per-product maximum charge in kobo, inclusive of taxes/fees. Values in tests are fictitious, not recommended prices or budgets. Any price increase requires updating the upper bounds before resuming live requests.
7. Only after these gates may an authorised operator set `DOJAH_ENV=live`, `DOJAH_PRODUCTION_AUTHORIZED=true` and `DOJAH_APPROVED_PRODUCTS` to the expressly approved products. Perform a consented, funded test within the approved budget and reconcile its charge before wider release.

This change does not modify Render settings, establish which revision is deployed, merge itself, fund the wallet or activate production. Roll back code only while retaining the new ledger tables. Before any later reactivation, deploy these controls again and reconcile pending dispatches so a rollback cannot silently bypass cost controls.
