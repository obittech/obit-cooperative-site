# Dojah endpoint and spending reconciliation
Review date: 27 October 2026. Production remains unauthorised. This document does not approve a budget or activate live KYC.

## Evidence
- Account-specific price confirmation and sandbox instruction: ticket #98dca2ce, 23 October 2026, https://mail.google.com/mail/u/?authuser=obitcooperative%40gmail.com#all/1a1683273c09e650
- Current provider references: https://docs.dojah.io/api-reference/individual-verification/nigeria/validate-bvn and https://docs.dojah.io/api-reference/individual-verification/nigeria/lookup-nin
- Inspected backend/src/routes/kyc.js, backend/src/services/kyc-cost-controls.js and backend/.env.example on main.
- Final account billing clarification: ticket #98dca2ce, 26 October 2026, https://mail.google.com/mail/u/?authuser=obitcooperative%40gmail.com#all/1a177ac8f3268ca1

## Implemented requests
| Internal product | Request | Documented provider product | Published rate |
| --- | --- | --- | --- |
| bvn | GET /api/v1/kyc/bvn with bvn, first_name, last_name, dob when available | Validate BVN | NGN 45 |
| nin (default) | GET /api/v1/kyc/nin with nin | Lookup NIN, basic tier | NGN 60 |

Dojah expressly confirmed these existing endpoints map to Validate BVN at NGN 45 and Lookup NIN at NGN 60. Both are final wallet debits inclusive of VAT and other fees. Historical SDK labels differ, so do not infer a BVN lookup tier from the short path. No endpoint switch is justified.

Other confirmed published prices: BVN Basic lookup NGN 50, BVN Advanced lookup NGN 60, NIN Advanced NGN 85, NIN Premium NGN 100, selfie with BVN NGN 90, selfie with NIN NGN 90. These products are not currently dispatched by this route. Do not map them to internal bvn/nin cost settings or enable them without a separate integration and approval.

## Membership options
Retain NIN as the current default and BVN as an alternative pending approval. NIN lookup supplies identity fields for local name/date-of-birth matching and can return a photo, although this route does not perform face matching. BVN validation supplies field-match results and avoids retrieving a full identity record. It may be sufficient where the approved membership policy only requires checking supplied names and date of birth. Neither existing flow proves that the applicant is physically present.

BVN validation costs NGN 15 less per request than basic NIN under the confirmed mapping. This alone does not justify changing the default. BVN availability among members, policy requirements and provider product approval remain relevant.

Do not collect both identifiers routinely or automatically fall back after failure. Review the failure first because the second product can incur another debit. Advanced/Premium records add cost and unnecessary data unless a defined membership requirement calls for them. Selfie verification requires capture, specific consent, privacy/retention review, response handling and separate tests. Confirm whether NGN 90 includes lookup and liveness before comparing totals.

The current reservation path checks latest terms and privacy consent before dispatch. Confirm the consent text clearly explains the chosen identity check and provider. Keep raw identifiers and returned identity records/photos out of persistence and audit logs.

## First 100 members: illustrations
Validate BVN and Lookup NIN figures use confirmed final wallet debits including VAT and other fees. Other product rows reproduce published prices only, without confirmation of their all-inclusive debit or approval for this account. Formula: dispatched billable calls multiplied by the published product rate. These are expenses, not guaranteed verified-member counts.

| Product | 100 initial calls | 100 initial + 10 additional billed calls | 100 initial + 25 additional billed calls |
| --- | ---: | ---: | ---: |
| Validate BVN | NGN 4,500 | NGN 4,950 | NGN 5,625 |
| BVN Basic lookup | NGN 5,000 | NGN 5,500 | NGN 6,250 |
| BVN Advanced lookup | NGN 6,000 | NGN 6,600 | NGN 7,500 |
| Lookup NIN | NGN 6,000 | NGN 6,600 | NGN 7,500 |
| NIN Advanced | NGN 8,500 | NGN 9,350 | NGN 10,625 |
| NIN Premium | NGN 10,000 | NGN 11,000 | NGN 12,500 |
| Selfie with BVN or NIN, each | NGN 9,000 | NGN 9,900 | NGN 11,250 |

Example: 90 successful initial checks and 10 chargeable 404s still consume 100 calls. If those 10 members later receive one corrected, permitted request each, plan for 110 billed calls. If 10 timed-out initial calls and their later repeats are both billed, the same 110-call illustration applies, because Dojah confirms every provider request is charged. A network failure does not establish whether the provider received the request, so retain full exposure until reconciled. Do not actually retry an UNKNOWN request until reconciled.

Mixed example: 100 initial NIN calls plus BVN checks for 10 unresolved applicants = NGN 6,450, using the confirmed final debits, with every provider request billed. This does not assume the fallback succeeds. Local validation failures and requests blocked before fetch create no new provider request.

The NGN 50,000 minimum top-up is prepaid wallet funding, not the expense for 100 members. For example, NGN 6,000 of confirmed debits would leave NGN 44,000 before other charges. Do not top up before activation and spending approval.

## Existing safeguards to retain
- Sandbox default, production authorisation flag, approved-product list and required positive integer limits.
- Atomic durable reservations, shared dispatch guard, rolling 24-hour request and reserved-budget limits.
- Latest consent checks, application-state validation, same-product duplicate block for 24 hours and maximum five attempts per application per 24 hours.
- DISPATCHED/UNKNOWN requests block further requests for that application until reconciled.
- All dispatches retain their reservation, including 404s, mismatches and timeouts. Reserved spend is conservative exposure, not a settled provider invoice.
- No automatic provider retry and no persistence of raw BVN/NIN or provider identity payloads.

The local request UUID is not a provider idempotency guarantee. Do not describe the system as eliminating every possible provider duplicate charge.

## Configuration after production authorisation and budget approval only
Keep DOJAH_ENV=sandbox and DOJAH_PRODUCTION_AUTHORIZED=false. Leave approved products and live limits unconfigured until written account and product authorisation and internal budget approval.

Confirmed final debits correspond to DOJAH_BVN_MAX_COST_KOBO=4500 and DOJAH_NIN_MAX_COST_KOBO=6000. These values are documentation only, not approved or applied live settings. Approved-product tokens are bvn and nin, matching the implemented routes.

For illustration only, 20 calls at a maximum NGN 60 per call reserve NGN 1,200, or 120000 kobo. Daily limits are rolling 24-hour limits, not a calendar-day reset and not a substitute for checking the actual provider wallet balance. No wallet-balance integration was identified in the inspected spending service.

## Open provider questions and validation before activation
Confirmed: endpoint mapping, final VAT/fee-inclusive debits, chargeable 404s at full product rate, every provider request charged, and provider reference_id for tracking. Clients must handle timeouts, network failures, duplicate submissions and retries. A local UUID or provider reference is not a provider idempotency guarantee. Dojah guarantees BVN, first name and last name fields, but has not guaranteed DOB here.

Still needed: explicit account and permitted-product production approval, ledger reconciliation/refund procedures, provider reference schema examples (including errors), guaranteed DOB behaviour, and selfie lookup/liveness inclusions. Do not assume network failures are free or automatically retry them.

Before activation, run or extend meaningful integration tests for:
1. Every missing live approval/product/budget/cost setting fails before provider fetch.
2. Concurrent duplicate submissions make one dispatch and budget-boundary races cannot overspend reservations.
3. 404, mismatch, timeout, malformed response and interrupted processing retain reservations. UNKNOWN remains blocked across new sessions and process restarts.
4. Consent withdrawal and already-verified applications prevent new dispatches.
5. Exact configured paths/query parameters and no retry, raw identifier persistence, provider payload persistence or secret logging.
6. Missing DOB in the application or provider response cannot silently become a full identity match under the intended policy.

A matching review is justified separately: identityMatchDetails currently treats absent DOB on either side as a DOB match and compares names using substring inclusion. The BVN object branch also expects a date_of_birth object, while the current documentation example omits it. Obtain representative approved-product responses and define the membership matching policy before changing these semantics. Do not weaken matching to accommodate missing provider fields.

## Provider reference reconciliation
The additive kyc_provider_references table links provider tracking metadata to the local request UUID, which already links to the application and KYC check. Existing rows are not backfilled with invented references. The shared startup migration creates the table on SQLite and PostgreSQL and can be rerun without deleting existing data.

Only explicit top-level reference_id or data.reference_id values are accepted. References must be bounded opaque strings using letters, numbers, underscore, dot, colon or hyphen. Conflicting values, identity-like runs of 11 digits and unexpected formats are discarded and marked INVALID. Missing references are marked MISSING. Never search identity payloads recursively for tracking values. Unsupported valid provider formats require reviewed allowlist changes after inspecting redacted examples.

Tracking metadata is written before local identity matching, including on non-2xx responses. References remain in the backend database, outside public responses, status details and audit events. Database operator access and backup controls apply. No raw identifiers, provider identity records or photos are stored in this table.

Missing/invalid references, unreadable responses and non-404 provider errors leave UNKNOWN requests blocked indefinitely, even beyond the rolling 24-hour limits. Network failures without a response retain the local request UUID and reservation, with no invented provider reference. Interrupted writes leave DISPATCHED or UNKNOWN records blocked. An available reference is only a tracking aid, not proof of settlement, identity match or approval. Operators must reconcile local UUID, environment, product, HTTP status, reserved amount and provider reference against the provider ledger/support before any separately authorised follow-up. There is no automatic retry, refund, reservation release or public reconciliation endpoint.

## Scope of this change
Updates confirmed pricing and adds provider tracking metadata and conservative missing-reference handling. No live configuration, endpoint, matching policy or automatic retry changes. Production remains disabled pending written account/product approval and budget approval.
