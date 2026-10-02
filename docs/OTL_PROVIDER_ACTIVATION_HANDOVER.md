# Obit Technologies provider activation handover

Decision recorded: 2 October 2026.
Source baseline: production main at 0389c11515b6f14f8201446b53a86828d627a200.

## Legal entities and provider accounts

- Paystack contracting merchant: Obit Technologies Limited, using its company documents and matching corporate bank account.
- Obit SafePay operator and intended escrow-provider contracting business: Obit Technologies Limited.
- Obit Technologies Multipurpose Cooperative Society Limited remains the separate membership and programme organisation.
- Dojah cooperative KYB review remains on the existing cooperative ticket. No change of that applicant is authorised by this handover.
- Do not upload Obit Technologies documents into an account still registered as the Cooperative without the provider's accepted entity-change or new-account process.
- Merchant settlement into an Obit Technologies bank account is distinct from protected escrow custody. Obtain the escrow provider's accepted arrangement before changing custody disclosures.

## Verified evidence

- GitHub main is the production baseline above. No divergent legacy branch has been merged.
- Paystack Reviews replied on 23 September asking for a 6/7-digit dashboard business ID. The inspected thread contains no subsequent response with that ID.
- Prior Paystack test receipts identify the Cooperative as merchant. They do not establish activation of an Obit Technologies merchant.
- EscrowPay welcome email of 22 September was addressed to obitcooperative@gmail.com and requests business profile/KYB completion and test application credentials. Account registration does not establish live escrow approval.
- SafePay provider code currently targets EscrowPay. Bearer authentication and /v1/escrows endpoints remain provisional pending issued provider documentation.
- Market pilot terms already identify Obit Technologies as operator.
- Dojah confirmed receipt of cooperative registration certificate and registered bye-laws on 28 September. A follow-up was sent on 2 October.

## Paystack activation sequence

1. Identify the Obit Technologies business ID and verify the legal name and settlement bank in the dashboard.
2. Obtain Paystack acceptance of the declared arrangement, separating membership fees, cooperative contributions and marketplace flows.
3. Complete company onboarding using the requested company records and corporate-bank evidence.
4. Execute the appropriate inter-entity collection/service arrangement and reflect accepted responsibilities in customer terms.
5. Configure keys securely in Render. PAYSTACK_LIVE_ENABLED remains false until live approval and the restricted validation window.
6. Register the deployed backend's /api/webhooks/payments/paystack URL, after confirming the actual backend host, and use the existing member callback path.
7. Verify amount, NGN currency, provider reference, signature, environment and exactly-once posting. Test duplicate callbacks, declined/cancelled checkout and delayed webhooks.
8. Under an agreed limited live test, verify the receipt, member record, ledger and actual settlement into the intended bank. Keep broader collection disabled until results are reviewed.

## SafePay activation sequence

1. Confirm whether the existing EscrowPay account can onboard Obit Technologies or requires a new business account.
2. Obtain KYB acceptance, commercial terms, custody/settlement responsibilities and dispute rules.
3. Obtain exact API authentication, endpoint paths, amount units, idempotency rules and event schema.
4. Compare provider documentation with backend/src/services/safepay-provider.js and backend/src/routes/safepay-webhook.js. Do not enable provisional code merely by installing credentials.
5. Configure sandbox credentials privately and test creation, funding, delivery, release, refund, duplicate events and disputes.
6. Verify webhook signature, event identifiers, order correlation, amount, currency, environment and allowed transitions against the issued contract.
7. Complete limited live validation, including actual release/refund and settlement evidence, before public checkout.

## Current configuration references

Paystack: PAYSTACK_SECRET_KEY, PAYSTACK_LIVE_ENABLED, PAYSTACK_CALLBACK_URL.
SafePay: SAFEPAY_PROVIDER, SAFEPAY_PROVIDER_ENABLED, SAFEPAY_MODE, ESCROWPAY_API_KEY, ESCROWPAY_API_BASE.
SafePay webhooks: SAFEPAY_WEBHOOK_SIGNATURE_MODE, SAFEPAY_WEBHOOK_SECRET, SAFEPAY_WEBHOOK_HEADER, SAFEPAY_FUNDED_EVENT.
KYC: DOJAH_ENV, DOJAH_APP_ID, DOJAH_SECRET_KEY.
Keep WEBHOOK_SANDBOX_MODE=false and ENABLE_DEV_ROUTES=false on deployed services.

## Additional launch check

The repository default membership fee is NGN 2,000. The intended offer recorded in the business context is NGN 3,000 for the first 100 members and NGN 10,000 thereafter. The actual Render setting has not been inspected. Confirm the approved offer and deployed setting before a payment test. Do not silently change the fee or infer the promotional membership count.

## Required inputs

- Correct Obit Technologies Paystack business ID.
- Confirmed settlement-bank details, entered through the provider's secure dashboard.
- Provider-issued sandbox/live credentials, entered through secure environment settings.
- Confirmation of Render workspace: My Workspace (obittechnologies2021@gmail.com), tea-dakbm9ek1f9s73cnshg0. The Render tool explicitly requires user workspace confirmation before service inspection.
- Approved membership pricing and promotional-count rule if the deployed fee differs.

## Launch evidence to retain

Provider approvals, accepted entity/bank configuration, executed agreements, API/webhook contract version, test references, redacted webhook results, ledger reconciliation, settlement/refund evidence, deployed commit and management launch decision. Do not include credentials in the repository.
