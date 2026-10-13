# Obit Technologies provider activation handover

Original proposal recorded: 2 October 2026. Correspondence and source review updated: 13 October 2026.
Original branch baseline: 0389c11515b6f14f8201446b53a86828d627a200.
Current main inspected: 77d29e22cfd3673f5a3250555c01cedd222d743c. This is a repository revision, not a verified production deployment.

## Legal entities and provider accounts

- Obit Technologies Limited and Obit Technologies Multipurpose Cooperative Society Limited remain separate legal entities. Company service fees, cooperative membership fees, cooperative contributions and marketplace seller proceeds require distinct, declared provider relationships and fund flows.
- The original proposal was for Obit Technologies Limited to be the Paystack contracting merchant using its company documents and matching corporate bank. This is a business intention, not Paystack approval to collect for the Cooperative.
- Paystack's 8 October instruction is to onboard the Cooperative using the Cooperative Society's own registration documents and details. Cooperative onboarding must use its own business details and authorised settlement information.
- Confirmed Paystack dashboard business ID: **2013062**. Obit Technologies Limited's CAC registration number **1871166** is not a Paystack merchant ID. Confirmation of 2013062 does not resolve its final legal-entity assignment or establish live approval.
- The outstanding routing question is whether 2013062 should be converted/completed for the Cooperative, or retained for Obit Technologies Limited while a separate Cooperative merchant account is created. Do not infer an answer or mix documents while this is unresolved.
- Obit SafePay operator and intended escrow-provider contracting business: Obit Technologies Limited, subject to the escrow provider's accepted onboarding and custody arrangement. This is separate from Cooperative Paystack onboarding.
- Dojah cooperative KYB review remains on the existing cooperative ticket. No change of that applicant is authorised by this handover.
- Do not upload one entity's documents into the other's merchant record without the provider's accepted entity-change or new-account process.
- Merchant settlement into an Obit Technologies bank account is distinct from protected escrow custody. Obtain the escrow provider's accepted arrangement before changing custody disclosures.

## Confirmed correspondence and evidence limits

Paystack source thread: https://mail.google.com/mail/u/?authuser=obitcooperative%40gmail.com#all/1a0be3906f7e7d0a

- On 23 September, Paystack requested the dashboard business ID.
- On 5 October, Paystack confirmed business ID 2013062 after rejecting 1871166 as the merchant ID. Paystack reported an incomplete compliance form and requested completion and an activation request.
- The same 5 October reply required review and approval of third-party seller collection and settlement arrangements before use. Paystack must not be used to hold/manage wallet, escrow, cooperative contribution or third-party funds in an ordinary settlement account without an approved structure. SafePay and related financial functions must remain disabled pending review.
- On 8 October, Adebusola instructed separate Cooperative onboarding using the Society's documents and details. The reply said the settlement arrangement could remain the same and manual settlements could be considered once the Cooperative business is live. This does not answer the merchant-record routing question or override the 5 October fund-flow restrictions. Verify the accepted bank beneficiary and permitted settlement arrangement explicitly.
- On 10 October, the Cooperative confirmed entity separation and asked whether to complete/convert 2013062 for the Cooperative or create a separate Cooperative merchant while retaining 2013062 for the company.
- No subsequent answer was found in the connected Cooperative Gmail account during the 12 October check. The 13 October read of this thread still ends with the 10 October sent reply. This is scoped mailbox/thread evidence, not proof that no answer exists elsewhere.
- Prior Paystack test receipts identify the Cooperative as merchant. They do not establish live activation or an Obit Technologies merchant's ownership.
- Historical evidence retained from the original handover: EscrowPay's 22 September welcome email addressed obitcooperative@gmail.com and requested business profile/KYB completion and test credentials. Registration alone does not establish live escrow approval. Dojah confirmed receipt of cooperative registration certificate and registered bye-laws on 28 September, with a follow-up sent on 2 October. These historical items were not independently rechecked in this revision.

## Current-main review and deployment limits

PR #22 is an open, unmerged draft. At review, current main was four commits ahead of the original common baseline, and the PR branch contained two handover commits absent from main. Subsequent main changes include the market redesign, related listing/schema changes and automation pages. This documentation revision does not merge those runtime changes or establish that they are deployed.

Configuration references were checked against current main's backend/.env.example, backend/src/routes/payments.js, backend/src/routes/webhooks.js, backend/src/services/safepay-provider.js, backend/src/routes/safepay-webhook.js and backend/src/routes/safepay.js.

- Membership and contribution checkout share PAYSTACK_SECRET_KEY and PAYSTACK_LIVE_ENABLED. There is no separate contribution-approval switch in the inspected payment route. A membership-only launch needs a reviewed server-side restriction that prevents unapproved contribution collection before installing/enabling live configuration.
- The payment webhook checks signatures and stored references and has duplicate-processing protections, but missing amounts are accepted and missing currency defaults to NGN. It does not explicitly check Paystack event domain or PAYSTACK_LIVE_ENABLED. Treat strict amount/currency/environment/event validation and concurrent replay/retry recovery as launch checks requiring evidence or a separately reviewed fix.
- SafePay still uses provisional Bearer authentication and /v1/escrows endpoints. Its funded webhook correlates event/escrow identifiers and status but does not validate amount, currency or environment against the order. SAFEPAY_MODE is descriptive in the inspected provider boundary, not an enforced live-mode barrier. Do not enable provisional code merely by setting credentials.
- Delivery confirmation records release_pending. The inspected route does not execute provider release/refund. Full settlement/refund automation is not proven.
- Membership payment verification moves applications to UNDER_REVIEW. Fully automatic membership activation is not established by this handover.
- Reconcile this draft with main and confirm the actual deployed commit and service configuration before any activation. Repository defaults are not evidence of live settings.

## Paystack activation sequence

1. Obtain Paystack's written answer on routing business ID 2013062. Confirm the dashboard legal entity, merchant identifier, authorised settlement beneficiary and allowed payment purposes for each resulting account.
2. Complete Cooperative onboarding with Cooperative documents and details as instructed. If a company merchant is retained/created, complete its own company onboarding separately. Submit the appropriate activation requests and retain live-approval evidence.
3. Obtain approval of each declared fund flow, separating membership fees, company service fees, cooperative contributions and marketplace collections. Execute any required inter-entity collection/service agreement and align customer terms with accepted responsibilities.
4. Resolve the shared live-switch limitation before a membership-only launch. Keep contributions, wallet/escrow balances, third-party seller proceeds and associated payouts blocked until separately approved.
5. Configure the correct account's keys privately in Render. PAYSTACK_LIVE_ENABLED remains false until live approval, reviewed restrictions/configuration and the agreed restricted validation window.
6. Confirm the actual backend host, register /api/webhooks/payments/paystack, and verify PAYSTACK_CALLBACK_URL and the existing member callback path. A browser return must never serve as payment confirmation.
7. Prove strict amount in kobo, NGN currency, provider reference, signature, event type, account/environment and exactly-once posting. Test missing/mismatched fields, test/live mismatch, concurrent duplicates, retries after processing failure, declined/cancelled checkout and delayed webhooks.
8. Under an agreed limited live test for approved flows only, reconcile provider receipt, application/member record, ledger where applicable and actual settlement into the approved bank. Keep broader collection disabled until results and rollback readiness are reviewed.

## SafePay activation sequence

1. Confirm whether the existing EscrowPay account can onboard Obit Technologies or requires a new business account.
2. Obtain KYB acceptance, commercial terms, custody/settlement responsibilities and dispute rules.
3. Obtain exact API authentication, endpoint paths, amount units, idempotency rules and event schema.
4. Compare the issued documentation with backend/src/services/safepay-provider.js and backend/src/routes/safepay-webhook.js. Resolve the current-main validation and mode-enforcement gaps through a separate reviewed change before enabling the provider.
5. Configure sandbox credentials privately and test creation, funding, delivery, release, refund, duplicate events and disputes. Confirm that release/refund paths are implemented and reconciled before promising automation.
6. Verify webhook signature, event identifiers, order correlation, amount, currency, environment and allowed transitions against the issued contract.
7. Complete approved limited live validation, including actual release/refund and settlement evidence, before public checkout.

## Current configuration references and secure handling

Paystack: PAYSTACK_SECRET_KEY, PAYSTACK_LIVE_ENABLED, PAYSTACK_CALLBACK_URL.
SafePay: SAFEPAY_PROVIDER, SAFEPAY_PROVIDER_ENABLED, SAFEPAY_MODE, ESCROWPAY_API_KEY, ESCROWPAY_API_BASE.
SafePay webhooks: SAFEPAY_WEBHOOK_SIGNATURE_MODE, SAFEPAY_WEBHOOK_SECRET, SAFEPAY_WEBHOOK_HEADER, SAFEPAY_FUNDED_EVENT.
KYC: DOJAH_ENV, DOJAH_APP_ID, DOJAH_SECRET_KEY.
Keep WEBHOOK_SANDBOX_MODE=false and ENABLE_DEV_ROUTES=false on deployed services.

2013062 is a dashboard identifier, not an API credential or a new environment variable. Verify keys belong to the provider-approved entity and environment. Enter secrets only through secure provider dashboards and backend environment settings. Never commit real .env files, expose secrets to frontend code, or place credentials in PRs, logs, screenshots or correspondence. Rotate any exposed key and retain only redacted validation evidence.

## Additional launch check

The repository default membership fee remains NGN 2,000. The intended offer recorded in the business context is NGN 3,000 for the first 100 members and NGN 10,000 thereafter. The actual Render setting has not been inspected in this review. Confirm the approved offer and deployed setting before a payment test. Do not silently change the fee or infer the promotional membership count.

## Required decisions and configuration checks

- Paystack's answer on 2013062 routing and the resulting separate merchant records.
- Accepted legal names, authorised settlement-bank details and approval scope for every payment purpose.
- Completed compliance/activation and written approval of any third-party collection, contributions, custody or payout arrangement.
- EscrowPay company-account routing, KYB, custody contract and issued API/webhook documentation.
- Dojah's Cooperative approval and verified KYC configuration before the membership flow.
- Actual Render workspace/services, deployed commit, live flags, secret ownership, callback/webhook URLs and production simulation settings. The original handover records My Workspace (obittechnologies2021@gmail.com), tea-dakbm9ek1f9s73cnshg0 as an unverified workspace reference. Follow the Render tool's workspace-selection requirements when inspecting it.
- Approved membership pricing and promotional-count rule, server-side flow restrictions, strict webhook validation and reconciliation/retry evidence.
- A separate decision and reviewed implementation if automatic membership activation or SafePay release/refund is required.

## Launch evidence to retain

Provider approvals, accepted entity/bank configuration, executed agreements, API/webhook contract version, test references, redacted webhook results, ledger reconciliation, settlement/refund evidence, deployed commit and management launch decision. Do not include credentials in the repository.
