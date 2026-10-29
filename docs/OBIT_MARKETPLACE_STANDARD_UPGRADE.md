# Obit Market commerce upgrade

Requested 29 October 2026. Product direction: phone-first marketplace under Obit Cooperative, with technology infrastructure provided by Obit Technologies Limited. Sellers require active cooperative membership. Buyers do not.

## Delivery sequence and completion criteria

| Area | Current implementation | Work required for completion |
| --- | --- | --- |
| Mobile website | Responsive storefront, bottom navigation, category search, saved items, bag and buyer account | Repeated checks on physical Android/iOS devices, slow connections and accessibility. Measure production performance before claiming capacity. |
| Catalogue and stores | Server search, filters, pagination, named store submissions, staff review, staff-controlled official labels and timed promotions | Onboard genuine sellers, approve real products, obtain brand authorisation, add photo uploads, variants and batch import. No fictional catalogue expansion. |
| Customer orders | Email-code accounts, bag, quote history, quote acceptance, separate unpaid orders, 15-minute stock holds, cancellation and event timelines | Paid-order transitions and fulfilment after provider confirmation. Existing quotes remain enquiries. |
| Checkout and payments | Server pricing, provider switches keep live checkout closed | Provider merchant approval specifically covering marketplace collections and settlement. Marketplace-specific payment sessions, signed webhook reconciliation, durable idempotency, integration with the existing unpaid stock reservations, amount/currency validation, interrupted checkout recovery. Test failure and reversal paths before enabling. Existing membership payment code must not be reused without marketplace order linkage. |
| Delivery and pickup | Address and seller delivery quotes | Serviceable zones, courier agreement/API credentials, confirmed delivery quotes, verified pickup location register and opening hours. Book only eligible paid orders. Verify and deduplicate courier events, distinguish shipment from order status, support failed delivery and collection codes. Do not advertise FFK addresses as collection points before operations approval. |
| Seller operations | Listing submission/approval, stock versioning, shop identity review, quote responses, reserved/available stock and unpaid-order cancellation | Variants/SKUs, batch import, paid-order picking and dispatch, cancellation reasons, provider settlement reconciliation and staff audit history. |
| Returns and refunds | No live paid-order return/refund workflow | Approve category-specific return windows and exclusions, inspection and evidence process, return logistics, buyer dispute rights, staff decisions and provider refund API. Refunds must be amount-capped, idempotent and reconciled to provider confirmation. Never mark a refund complete from a staff button alone. |

Build order: catalogue and seller tools, order/stock lifecycle, payment integration, delivery and pickup, returns and refunds, then operational pilot and measured performance checks. Software foundations can be built while providers review the business. Public service promises require confirmed business operations.

## Store and promotion release

- Additive tables in `backend/migrations/market-commerce.sql` work with SQLite and PostgreSQL. Existing membership, KYC and payment data are unchanged.
- Sellers submit a name and description. Updates require the latest version and clear approval, badge and private evidence. While pending, the public listing uses its existing Member shop alias.
- Staff/admin approve identities. Official status requires a private evidence/reference note and an affirmative review of brand ownership or written authorisation. The system records the review, it does not independently establish legal brand rights. Seller submissions cannot award badges.
- Store descriptions and names are escaped in the browser. Private review notes are excluded from public catalogue output and seller profile responses.
- Directory and store links include only active products from active sellers in the active cooperative community. Staff can remove approval using Reject. Store identity approval and product approval remain separate.
- Promotions are staff-controlled, one per listing, for up to 90 days and below the current listing price, within the existing minimum listing range. Disabling a promotion, expiry or a listing price change removes its effect without a scheduled job.
- The same server price calculation is used for catalogue filters/sorting, bag totals and new quote snapshots. No crossed-out reference prices or invented savings claims. A stale bag total cannot create a quote at an expired offer price.
- Promotions do not create payments, orders, reservations or delivery bookings. Existing unpaid quote history retains its snapshot.
- Operations controls are in the existing admin Market tab. Store reviews are bounded to the latest 200 and promotion metadata to 500. Add pagination before exceeding those operational limits. Public catalogue page size remains bounded to 48 and shop options to 500.

## Verification and rollout

Run the backend regression suite, cart tests, JavaScript syntax checks and SQLite migration checks locally. The PR workflow additionally runs marketplace tests with PostgreSQL. Review the mobile store directory, selected-store view, promotion filter and seller submission form using isolated fictional accounts. No email, payment or courier provider requests are made by that preview.

Deploy backend and frontend through the existing GitHub/Render services after CI passes. Verify health, catalogue and unsigned staff guards, then verify the phone layout. Do not insert live products, authorise a brand or create an offer merely to populate the release.

Payments and fulfilment remain unavailable until their own implementations, provider arrangements and end-to-end acceptance checks are complete. This release does not establish parity with Jumia in operating scale, stock breadth, logistics or resilience.


## Unpaid purchase-order release

- New `market_purchase_orders`, `market_purchase_order_items` and `market_purchase_order_events` tables are additive and distinct from legacy `market_orders` / SafePay records. One order per seller quote, enforced by a database unique key, makes acceptance retries idempotent without a new client-generated key.
- Accept only an owned QUOTED response on an uncancelled request within seven days. The reviewed product-plus-delivery total is acknowledged, but prices and the address come from server records. Every product must still be active with the same price and confirmed available stock. Changes require a fresh quote.
- Orders remain AWAITING_PAYMENT, CANCELLED or EXPIRED. No API can mark these orders paid, shipped, delivered or refunded. No email, payment, KYC or courier dispatch is added by this release.
- Hold stock for 15 minutes. Catalogue/cart availability subtracts only unexpired active holds. Expiry releases stock through the availability query even without a scheduled worker. Buyer/seller history reads persist expiry and its event once. Operations summaries derive the effective status without exposing contact details.
- Lock buyer, quote parent, then listing IDs in ascending order during acceptance. Listing locks serialize competing reservations and inventory edits on PostgreSQL. Cancellation releases a hold by transitioning the order, without incrementing or decrementing physical stock. Seller edits cannot set stock on hand below active reservations.
- Limit a buyer to two concurrent active holds and ten new orders per hour. Completed retries do not consume another hold. An expired/cancelled order is returned on replay and cannot be reopened. Request cancellation rolls back if any quote in it already has an order. Use order cancellation instead.
- Buyers see their own snapshots and events. Sellers see only their own items, totals and destination town/state, with no full address, email or phone. Read-only staff summaries show the latest 100 orders. Buyer/seller history shows the latest 50. Cancellation reasons are shared with the other party and escaped in the UI.
- Mobile account navigation adds Orders alongside Bag, Delivery and Requests. Quote acceptance has a review sheet and an unpaid/reservation acknowledgement. Every order shows that payment collection and dispatch are unavailable. Seller stock labels distinguish on-hand, reserved and available units.
- Before a payment release, address late webhook arrivals after reservation expiry, verify provider funding and amount/currency, settle physical stock exactly once, and atomically handle cancellations competing with payment. A legacy membership webhook must never confirm one of these new orders.

Validation: 82 backend tests plus five cart tests pass locally. Eight new integration tests cover snapshot/idempotency, last-unit competition, cancellation, automatic expiry, stale/unconfirmed quotes, access/privacy, active-hold limits and quote cancellation racing acceptance. The existing PostgreSQL workflow runs these cases too. Isolated browser QA covers quote review, buyer and seller cancellation, stock counts and phone/desktop layouts. No production fixtures are inserted.
