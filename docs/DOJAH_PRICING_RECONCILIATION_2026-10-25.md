# Dojah endpoint and spending reconciliation
Review date: 25 October 2026. Production remains unauthorised. This document does not approve a budget or activate live KYC.

## Evidence
- Account-specific price confirmation and sandbox instruction: ticket #98dca2ce, 23 October 2026, https://mail.google.com/mail/u/?authuser=obitcooperative%40gmail.com#all/1a1683273c09e650
- Current provider references: https://docs.dojah.io/api-reference/individual-verification/nigeria/validate-bvn and https://docs.dojah.io/api-reference/individual-verification/nigeria/lookup-nin
- Inspected backend/src/routes/kyc.js, backend/src/services/kyc-cost-controls.js and backend/.env.example on main.
- Billing clarification sent under the existing ticket on 25 October 2026. No answer is assumed.

## Implemented requests
| Internal product | Request | Documented provider product | Published rate |
| --- | --- | --- | --- |
| bvn | GET /api/v1/kyc/bvn with bvn, first_name, last_name, dob when available | Validate BVN | NGN 45 |
| nin (default) | GET /api/v1/kyc/nin with nin | Lookup NIN, basic tier | NGN 60 |

The endpoint-to-product names are supported by current official documentation. Account-specific billing mapping and tax-inclusive wallet debit still require Dojah confirmation. Historical SDK labels differ, so do not infer a BVN lookup tier from the short path. No endpoint switch is justified.

Other confirmed published prices: BVN Basic lookup NGN 50, BVN Advanced lookup NGN 60, NIN Advanced NGN 85, NIN Premium NGN 100, selfie with BVN NGN 90, selfie with NIN NGN 90. These products are not currently dispatched by this route. Do not map them to internal bvn/nin cost settings or enable them without a separate integration and approval.

## Membership options
Retain NIN as the current default and BVN as an alternative pending approval. NIN lookup supplies identity fields for local name/date-of-birth matching and can return a photo, although this route does not perform face matching. BVN validation supplies field-match results and avoids retrieving a full identity record. It may be sufficient where the approved membership policy only requires checking supplied names and date of birth. Neither existing flow proves that the applicant is physically present.

BVN validation would cost NGN 15 less per initial request than basic NIN if the proposed account billing mapping is confirmed. This alone does not justify changing the default. BVN availability among members, policy requirements and provider product approval remain relevant.

Do not collect both identifiers routinely or automatically fall back after failure. Review the failure first because the second product can incur another debit. Advanced/Premium records add cost and unnecessary data unless a defined membership requirement calls for them. Selfie verification requires capture, specific consent, privacy/retention review, response handling and separate tests. Confirm whether NGN 90 includes lookup and liveness before comparing totals.

The current reservation path checks latest terms and privacy consent before dispatch. Confirm the consent text clearly explains the chosen identity check and provider. Keep raw identifiers and returned identity records/photos out of persistence and audit logs.

## First 100 members: illustrations
All figures exclude unconfirmed taxes/fees. Formula: dispatched billable calls multiplied by the published product rate. These are expenses, not guaranteed verified-member counts.

| Product | 100 initial calls | 100 initial + 10 additional billed calls | 100 initial + 25 additional billed calls |
| --- | ---: | ---: | ---: |
| Validate BVN | NGN 4,500 | NGN 4,950 | NGN 5,625 |
| BVN Basic lookup | NGN 5,000 | NGN 5,500 | NGN 6,250 |
| BVN Advanced lookup | NGN 6,000 | NGN 6,600 | NGN 7,500 |
| Lookup NIN | NGN 6,000 | NGN 6,600 | NGN 7,500 |
| NIN Advanced | NGN 8,500 | NGN 9,350 | NGN 10,625 |
| NIN Premium | NGN 10,000 | NGN 11,000 | NGN 12,500 |
| Selfie with BVN or NIN, each | NGN 9,000 | NGN 9,900 | NGN 11,250 |

Example: 90 successful initial checks and 10 chargeable 404s still consume 100 calls. If those 10 members later receive one corrected, permitted request each, plan for 110 billed calls. If 10 timed-out initial calls and their later repeats are both billed, the same 110-call illustration applies, but that charging rule is an assumption. Do not actually retry an UNKNOWN request until reconciled.

Mixed example: 100 initial NIN calls plus BVN checks for 10 unresolved applicants = NGN 6,450, assuming both proposed mappings and all those calls are billed. This does not assume the fallback succeeds. Local validation failures and requests blocked before fetch create no new provider request.

The NGN 50,000 minimum top-up is prepaid wallet funding, not the expense for 100 members. For example, NGN 6,000 of confirmed debits would leave NGN 44,000 before other charges. Do not top up before activation and spending approval.

## Existing safeguards to retain
- Sandbox default, production authorisation flag, approved-product list and required positive integer limits.
- Atomic durable reservations, shared dispatch guard, rolling 24-hour request and reserved-budget limits.
- Latest consent checks, application-state validation, same-product duplicate block for 24 hours and maximum five attempts per application per 24 hours.
- DISPATCHED/UNKNOWN requests block further requests for that application until reconciled.
- All dispatches retain their reservation, including 404s, mismatches and timeouts. Reserved spend is conservative exposure, not a settled provider invoice.
- No automatic provider retry and no persistence of raw BVN/NIN or provider identity payloads.

The local request UUID is not a provider idempotency guarantee. Do not describe the system as eliminating every possible provider duplicate charge.

## Configuration after provider confirmation only
Keep DOJAH_ENV=sandbox and DOJAH_PRODUCTION_AUTHORIZED=false. Leave approved products and live limits unconfigured until written authorisation, endpoint-specific final debit confirmation and internal budget approval.

If all-inclusive rates are confirmed unchanged, the per-call bounds would be DOJAH_BVN_MAX_COST_KOBO=4500 and DOJAH_NIN_MAX_COST_KOBO=6000. These are conditional examples, not approved live settings. Include taxes/fees in the bound when applicable. Approved-product tokens are bvn and nin, matching the implemented routes.

For illustration only, 20 calls at a maximum NGN 60 per call reserve NGN 1,200, or 120000 kobo. Daily limits are rolling 24-hour limits, not a calendar-day reset and not a substitute for checking the actual provider wallet balance. No wallet-balance integration was identified in the inspected spending service.

## Open provider questions and validation before activation
Requested: account endpoint mapping, VAT/fees, full-rate mismatch/404 billing, 400 BVN-not-found billing, timeouts/network failures/424/429/5xx, retry and duplicate billing, provider idempotency/references, ledger reconciliation/refunds, guaranteed BVN date-of-birth response fields, and selfie lookup/liveness inclusions.

Before activation, run or extend meaningful integration tests for:
1. Every missing live approval/product/budget/cost setting fails before provider fetch.
2. Concurrent duplicate submissions make one dispatch and budget-boundary races cannot overspend reservations.
3. 404, mismatch, timeout, malformed response and interrupted processing retain reservations. UNKNOWN remains blocked across new sessions and process restarts.
4. Consent withdrawal and already-verified applications prevent new dispatches.
5. Exact configured paths/query parameters and no retry, raw identifier persistence, provider payload persistence or secret logging.
6. Missing DOB in the application or provider response cannot silently become a full identity match under the intended policy.

A matching review is justified separately: identityMatchDetails currently treats absent DOB on either side as a DOB match and compares names using substring inclusion. The BVN object branch also expects a date_of_birth object, while the current documentation example omits it. Obtain representative approved-product responses and define the membership matching policy before changing these semantics. Do not weaken matching to accommodate missing provider fields.

## Scope of this change
Documentation only. No live configuration, endpoint, matching, retry, schema or reservation changes. Review calculations and source-to-endpoint mapping manually. Runtime tests are not claimed for this documentation change.
