# Youverify KYC integration

The backend supports direct Nigerian NIN and BVN verification through Youverify Quickcheck. Youverify is the sole provider. No provider selector or fallback is supported. Prior verification history and provider references remain intact for audit and reconciliation. Retired pending sessions can be replaced with a new Youverify session only when there is no unresolved provider request. Shared application-level duplicate, attempt and spending controls still apply.

## Sandbox configuration

Set these server-side variables on the existing backend service:

```dotenv
YOUVERIFY_ENV=sandbox
YOUVERIFY_SECRET_KEY=<sandbox API secret from workspace settings>
YOUVERIFY_PRODUCTION_AUTHORIZED=false
```

Never place the secret in frontend configuration or commit it. The adapter uses the token header with no Bearer prefix, POST /v2/api/identity/ng/nin or /bvn, explicit subject consent, and a local request UUID in metadata.requestId. No premium flags, NIN retrieval from BVN, selfie checks, Entity 360 creation, monitoring subscriptions or additional checks are requested. Confirm Quickcheck access and product coverage with Youverify for the contracted workspace.

Use provider-supplied synthetic sandbox fixtures only. Mocked automated tests verify both products, privacy, consent, reconciliation, matching, live gates and duplicate protection. A real sandbox acceptance test is still required with a valid sandbox key. No real subject should be used for this test.

## Results and reconciliation

The response must be HTTP success, success=true, data.status=found and include a safe verification report data.id. Store only that report ID, HTTP status and local outcome in the existing reconciliation tables. The report ID is distinct from the submitted NIN/BVN and metadata.requestId. Recover provider and environment through request.check_id -> kyc_checks.

Require provider first and last names to match complete name tokens and require a valid matching ISO date of birth on both sides. A report that lacks DOB fails the application match. Confirm actual BVN DOB availability during sandbox acceptance before enabling that product. HTTP success or allValidationPassed alone never approves an application.

Timeouts, unreadable payloads, missing report IDs, non-found/pending statuses and HTTP errors remain UNKNOWN. No automated retry, fallback, webhook approval or scheduled polling is enabled. Operators must reconcile uncertain requests in the provider dashboard. Existing daily limits, attempt limits and 24-hour duplicate checks also apply to historical requests. Usage accounting is deliberately conservative and includes historical reservations in the same environment.

## Production activation requirements

Keep production disabled until written Youverify acceptance of Obit Technologies as contracting entity and the disclosed Obit Cooperative use under the infrastructure agreement, approved products, agreed pricing, consent/privacy terms and management authorization are recorded. These are separate legal entities.

After sandbox acceptance and authorization, production requires all of:

- YOUVERIFY_ENV=live
- YOUVERIFY_SECRET_KEY set to the production secret
- YOUVERIFY_PRODUCTION_AUTHORIZED=true
- YOUVERIFY_APPROVED_PRODUCTS containing the approved comma-separated products (nin,bvn)
- YOUVERIFY_DAILY_REQUEST_LIMIT, a positive integer
- YOUVERIFY_DAILY_BUDGET_KOBO, a positive integer
- YOUVERIFY_NIN_MAX_COST_KOBO and/or YOUVERIFY_BVN_MAX_COST_KOBO for each enabled product, positive integers covering maximum agreed billable cost including applicable taxes

No production rates or budgets are supplied by this change. Keep the written approval flag false until all prerequisites are complete. No database migration is needed.

## Pricing reviewed

The supplied Youverify Nigeria Pricing v7, effective Q3 2026, lists Cowork Startup at NGN 85,000 monthly or NGN 935,000 annually, excluding 7.5% VAT. Startup includes 200 new entities and 200 eID identity/business verification inclusions monthly and does not offer entity overage. Higher plans are NGN 235,000, NGN 555,000 and NGN 920,000 monthly before VAT. Page 5 says out-of-cycle eIDV pricing is subject to agreement, requires an active subscription, and is unavailable on Startup. These are published plan inclusions, not an agreed per-NIN/BVN API rate or a purchase authorization. Confirm Quickcheck billing, NIN/BVN inclusion counting, unsuccessful-call charges and plan entitlement in writing.

## Sources reviewed 28 October 2026

- https://doc.youverify.co/get-started/authentication
- https://doc.youverify.co/api-reference/specs/quickcheck.json (NIN/BVN request and response contracts)
- https://doc.youverify.co/get-started/quickstart
- https://doc.youverify.co/guides/onboard-by-government-id
- Supplied Youverify Nigeria Pricing v7 PDF, pages 1, 2 and 5

## Verification

Run npm test in backend. Provider HTTP calls in automated tests are mocked. Live provider connectivity, contractual entitlement and production processing are not established by these tests.
