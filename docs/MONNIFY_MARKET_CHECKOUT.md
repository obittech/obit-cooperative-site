# Obit Market: Monnify checkout

Provider selected by Chief Obinna: Monnify, in connection with his Moniepoint BRM work. This release implements a sandbox adapter and reconciliation workflow. It does not enable live collection, settlement, escrow, refunds or dispatch.

## Account and access requirements

Moniepoint BRM terminal management and Monnify merchant APIs are separate interfaces. BRM login credentials must never be used as API credentials. Obtain the merchant's sandbox API Key, Secret Key and Contract Code from Monnify. Confirm the contracting entity, marketplace collection activity, settlement destination and any seller split arrangements with the provider before a live release. Do not assume an OBS subscription merchant account covers member sellers' collections. The application does not claim that Monnify supplies escrow automatically.

No real merchant credentials were available for this implementation. Automated tests and the isolated browser preview use mocked Monnify responses and fictional accounts. A real sandbox checkout remains an acceptance requirement.

## Sandbox configuration

Use a separate non-production deployment and database. Configure secrets through the hosting provider's protected environment controls, never the frontend, repository or chat.

| Variable | Required setting |
| --- | --- |
| `NODE_ENV` | `test` or `development` |
| `MARKET_CHECKOUT_MODE` | `test` |
| `MARKET_MONNIFY_API_KEY` | Merchant sandbox key beginning `MK_TEST_` |
| `MARKET_MONNIFY_SECRET_KEY` | Merchant sandbox secret |
| `MARKET_MONNIFY_CONTRACT_CODE` | Matching sandbox Contract Code |
| `MARKET_MONNIFY_CALLBACK_URL` | HTTPS URL ending `/market-account.html`, optionally `#orders`; no query, username or password |
| `MARKET_MONNIFY_ALLOW_UNSIGNED_SANDBOX_WEBHOOK` | Normally omitted. `true` only in the isolated sandbox when receiving Monnify's documented unsigned sandbox notifications |

`http://localhost`, `http://127.0.0.1` and `http://terminal.local` callbacks are also allowed for local development. The API hostname is fixed to `https://sandbox.monnify.com`. It is not configurable by a request or environment override. `NODE_ENV=production` always disables marketplace checkout and webhook processing. A live key does not enable collection. No production variables are changed by this release.

Set the sandbox collection notification URL to the staging backend's `/api/webhooks/market/monnify`. Do not use the membership payment webhook. The API key, secret and Contract Code stay on the server. Auth tokens are cached only in process memory and are invalidated for subsequent calls after a provider 401 response.

## API and order behaviour

- Authenticate with `POST /api/v1/auth/login` using Basic auth for `apiKey:secretKey`, then use the returned Bearer token. Each external call times out after six seconds.
- Initialize with `POST /api/v1/merchant/transactions/init-transaction`. Send the order total in NGN, merchant Contract Code, customer email, server-generated payment reference, configured redirect URL, and CARD / ACCOUNT_TRANSFER channels. The browser supplies only an acknowledged total and order ID. It cannot choose the amount, customer email, contract, provider URL or payment reference.
- Allow checkout links only under `https://sandbox.sdk.monnify.com/checkout/`. Monnify hosts payment entry. Obit does not collect card data.
- One durable attempt exists per order. A transaction claims the attempt before calling the provider. Double clicks, network errors and process restarts cannot create a second initialization reference. An uncertain response requires reconciliation, not a new payment attempt.
- Starting sandbox checkout extends a live 15-minute reservation to 45 minutes once, covering Monnify's documented 40-minute checkout validity plus a processing margin. Replays never extend the hold again. Before opening an expired link, the customer must check payment status.
- Verify with `GET /api/v2/merchant/transactions/query?paymentReference=...` from the server. Match both references, NGN currency, total payable and amount paid to the immutable order. Parse NGN decimal values to integer kobo. Only an exact PAID receipt can commit test inventory. Partial, excess, reversed or uncertain results require review or remain unconfirmed.
- Serialize buyer, order, then listing locks. Commit physical stock once and atomically stop subtracting that order's reservation. A confirmed test order cannot subsequently expire or be cancelled as an unpaid order. Cancellation is blocked while a checkout is uncertain, ready or under review.
- Confirmed payments reported after cancellation/expiry or against unavailable stock go to PAYMENT_REVIEW and do not commit inventory. No automatic re-reservation, refund, wallet credit or dispatch occurs.
- Browser redirects and webhook payloads alone never confirm payment. A webhook triggers server verification. A notification still awaiting authoritative confirmation returns a retryable response. Duplicates of a confirmed receipt are acknowledged without reducing stock again.
- Buyer and seller order history show effective status and payment events without exposing buyer contact details to sellers. Staff can view the latest 100 attempts and query Monnify status in the isolated sandbox. Reconciliation cannot initiate a payment or refund.

## Webhook boundaries

The current Monnify webhook overview specifies HMAC-SHA512 over the exact request bytes with the client secret. The event-types page also contains older wording suggesting concatenation hashing. This implementation follows the explicit HMAC guidance and does not accept multiple signature algorithms. Confirm the live signature format and trusted source-IP enforcement with Monnify before enabling production.

Monnify documents that sandbox notifications omit the signature. Such notifications are rejected unless the dedicated sandbox flag is explicitly enabled. Even with that flag, the server looks up a known marketplace reference and independently queries Monnify. The flag cannot enable production processing. A persisted ten-second cooldown limits repeated verification per attempt. Never trust arbitrary forwarding headers for source-IP validation.

## Required before live collection

Complete the real sandbox exercise with the correct merchant credentials, an activated marketplace merchant contract and settlement arrangement, real collection notifications, failed/expired/partial/overpaid cases, reversals and refund reconciliation. Confirm customer-borne fees versus total payable. Add durable asynchronous notification processing and monitoring before scale. Review the live webhook signature and source IP against the actual hosting proxy. Activate live mode only through a separate reviewed implementation and deployment.

## Official references

- [Monnify hosted checkout](https://developers.monnify.com/docs/collections/one-time-payments/checkout-api)
- [Verify transactions](https://developers.monnify.com/docs/collections/manage-payments/verify-transactions)
- [Webhooks](https://developers.monnify.com/docs/webhooks)
- [Going live](https://developers.monnify.com/docs/live)

## Release validation

92 backend tests and five cart tests pass locally. Ten new marketplace payment tests cover production gates, initialization ownership/idempotency, unknown outcomes and unsafe URLs, exact server verification, stock commitment once, late/partial/overpaid receipts, reference and currency checks, webhook verification, unsigned sandbox boundaries, cancellation and expiry races. Isolated phone QA used a mocked provider transport and fictional records, checked checkout-link preparation, receipt verification, staff reconciliation and 320/390/430 px layouts. PostgreSQL CI must pass before merge. This does not constitute a real merchant sandbox test.

## Activation work sequence (1 November 2026)

The existing BRM dashboard does not establish Monnify merchant activation or API access. Sign into the Monnify merchant dashboard for Obit Technologies Limited and check activation there. Ask Monnify to confirm marketplace collections and the proposed seller-payment arrangements. Choose the verified company account ending 446 as settlement destination if Monnify accepts it. Settlement configuration does not subscribe this account to incoming-credit notifications for unrelated direct transfers.

1. Obtain sandbox API Key, Secret Key and Contract Code. Enter these in a separate staging service's protected environment settings using the `MARKET_MONNIFY_*` names above. Never put a bank password, PIN or OTP in these fields.
2. Set the staging callback to its own `/market-account.html#orders` page. Register the staging backend's `/api/webhooks/market/monnify` in Developers → Webhook URLs → Transaction Completion. Do not register the production API while its checkout is disabled: it will return 503. Do not point staging notifications at production orders or the production database.
3. From `backend/`, run `npm run check:monnify`. This checks configuration locally, prints only booleans and missing-setting names, and does not contact Monnify. A zero exit code means configuration is complete, not that a merchant or transaction was verified.
4. Run `npm run check:monnify -- --authenticate` in the same protected staging environment. This only obtains an in-memory sandbox authentication token. It neither initializes a checkout nor transfers money. Success verifies credentials, not the Contract Code, settlement configuration, webhook delivery or a payment. Those require the actual sandbox exercise.
5. Exercise one staging order through checkout and a real sandbox notification. Confirm independent provider verification, exact NGN total, one stock deduction, receipt visibility, duplicate handling, wrong amount, expired order and provider outage. Keep all test inventory and customer records in staging.
6. After sandbox acceptance, obtain live credentials and confirm the provider-approved collection, settlement and seller-release arrangement. A separate live implementation must cover live checkout URLs, immutable per-attempt environment selection, delivery eligibility and aftercare for provider-paid orders. These currently depend on the manual bank-payment flow and must not be enabled by merely changing an environment variable.

For direct incoming-credit monitoring of account 4006326446, ask Moniepoint for account-scoped credit notifications and a transaction-query API, including unique bank/session reference, credited account, amount, currency, confirmed status and reversal handling. This is a separate request from Monnify collections. An outgoing POS transfer event or a settlement notification is not sufficient evidence of a buyer's incoming credit.

No live keys, merchant account access, provider sandbox payment, or continuous bank-feed access were available during this preparation. Production manual transfers remain the current route.

## Controlled hosted acceptance fixture

`MARKET_MONNIFY_ACCEPTANCE=true` enables one labelled sandbox order only on the designated disposable Render sandbox service. It refuses production, PostgreSQL, another service ID, another database path, live keys, or either manual-transfer option. It never runs unless explicitly enabled. The fixture creates one test buyer, test member seller, two units of test inventory and a single NGN 1,000 test order. These are acceptance records, not verified real sellers, real goods or a public demonstration.

The normal checkout adapter initializes the actual Monnify sandbox checkout. The fixture prints only the sandbox checkout URL, test references and periodic order/stock status. It does not print authentication tokens or provider keys. Repeated startup on the same database reuses the order and payment attempt. The free sandbox filesystem is disposable, so a later rebuild may start a new fixture. Do not send real money.

Use Monnify's sandbox bank simulator to pay the generated sandbox account, then inspect event delivery and the fixture's order status. Successful acceptance requires a provider-triggered webhook, authoritative verification, SUCCEEDED status, stock remaining one, and one PAYMENT_VERIFIED event. Resend the same notification and confirm those quantities remain unchanged. Configuration or authentication success alone is not payment acceptance. Disable the fixture after the exercise.
