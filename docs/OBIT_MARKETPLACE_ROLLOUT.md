# Obit marketplace rollout

Obit Market is the cooperative community marketplace, operated on technology infrastructure supplied by Obit Technologies Limited. Sellers require active cooperative membership; the public catalogue is open to buyers. This release expands the existing site, using its approved product listings and seller moderation.

## Delivered storefront

Green and gold responsive navigation, global search, category discovery, seller filtering by public member-shop alias, price filters and sorting, product details, browser-saved wishlist and cart, current-catalogue price totals, quantity editing, payment-plan estimates and downloadable bulk enquiry drafts. Bulk drafts are not sent automatically. Cart and wishlist do not synchronize across devices. The legacy catalogue endpoint returns the latest 100 listings. The storefront now uses the paginated catalogue endpoint described below.

Checkout remains disabled. No payment, stock reservation, order placement or delivery booking occurs in the cart. Member shop labels are pseudonymous aliases, not verified business trade names. Existing membership and seller listing flows remain in place. No competitor branding or copied catalogue is used.

## Domain activation

1. In Render, open static service `srv-dakboj3m8hqs73e1dpn0` (obit-cooperative-site), Settings > Custom Domains. Add `marketplace.obitcooperative.com`.
2. At the authoritative DNS provider, create CNAME host `marketplace`, target `obit-cooperative-site.onrender.com`. Preserve all other website and email records.
3. Verify the domain in Render and wait for an issued TLS certificate before announcing the subdomain.
4. Verify HTTPS root redirects to `/market.html`, the catalogue loads and the existing cooperative homepage remains intact. The backend explicitly allows this HTTPS origin.

Domain attachment, DNS and certificate issuance require authenticated hosting and DNS access; these are not completed merely by merging the storefront code.

## Next commerce milestones

- Real seller shop profiles, inventory, product variants and pagination.
- Buyer identity and addresses independent of cooperative membership.
- Server-side multi-seller checkout with authoritative pricing, stock reservation, idempotent order creation and per-seller fulfillment.
- Approved payment-provider integration, verified webhooks, refund/dispute workflows and reconciled settlement. Obit does not claim to hold escrow funds.
- Shipping quotes, carrier integrations, tracking, returns and buyer notifications.
- Verified-purchase reviews and seller operations dashboards.

## Validation

Run `node --test tests/market-state.test.cjs` from the repository root and `npm test` in backend after installing dependencies. Browser QA uses isolated fixtures outside tracked source; no QA listings are published.

## Commerce foundation release — 29 October 2026

Delivered in the commerce foundation update:

- Email-code shopping accounts independent of membership, with a separate token namespace/key, durable one-time challenges, five verification attempts, per-email cooldown and a database-backed global send limit. Sign-out revokes all shopping sessions. Existing member/staff/admin sessions and onboarding are unchanged.
- Database-backed carts with per-buyer isolation, concurrent item updates, idempotent guest-bag merge, current server prices and availability. Unavailable guest items remain in the guest bag with a notice. Wishlist is still browser-local.
- One saved Nigerian delivery address per shopper; full addresses and phone numbers are not returned in seller quote inboxes.
- Server-side category/search/price/seller filters and 24-item storefront pagination, with a maximum API page size of 48. Seller filter options return at most 500 active member shops.
- Seller stock controls with ownership checks and optimistic versions. Unknown stock is explicitly shown as unconfirmed; new stock is never invented. Existing listings remain intact.
- Read-only quote overview in the existing staff/admin console, showing latest 100 references, totals, destination towns/states and outstanding seller responses.
- Multi-seller quote requests with server-priced snapshots, buyer acknowledgement of the current total, idempotency keys, seller-specific inboxes, delivery quotations/declines and buyer cancellation. Up to 100 distinct products, 99 units per line and ₦3,000,000 per request. Latest 50 buyer/seller requests are shown; seller listing controls show latest 100 listings.

Quote requests are NOT paid orders. They do not reserve inventory, dispatch goods, create escrow or settle sellers. Shipping fees are seller estimates; customer payment and quote acceptance are not enabled. The existing legacy SafePay order tables and provider gates are untouched.

### Additive database migration

The adapter applies `backend/migrations/market-commerce.sql` for both SQLite and PostgreSQL. New tables hold shoppers, sign-in challenges, addresses, carts, inventory and quotes; existing users, memberships, payments and orders are not rewritten. Run migration twice in checks to verify repeatability. Rollback the application to the previous commit if needed; leave the additive tables in place rather than deleting shopper data.

### Email and operational configuration

Buyer code emails use the existing RESEND_API_KEY and RESEND_FROM_EMAIL settings. The frontend disables code issuance if the API reports email is unconfigured. Codes expire after 10 minutes and shopper sessions after four hours. No mock authentication, QA identity, fixture catalogue or provider keys are part of production source.

Monitor API failures, code send failures, rate limits and seller quote response times after release. Operational targets, independent security review, restore drills, stress testing, carrier contracts, live checkout and supplier auto-purchasing remain separate acceptance milestones. This release does not establish Jumia/Konga-scale capacity.

### Verification

Marketplace integration tests run against both SQLite and PostgreSQL in CI. They cover shopper/member token separation, OTP consumption/expiry/lockout, failed email delivery, cart isolation/merging, prices and unavailable stock, catalogue pagination beyond 100, duplicate request replay, price changes, quantity limits, seller ownership, quote privacy and cancellation. Existing payment and KYC regression suites remain required. Browser QA uses an ignored isolated runner and fictional accounts only.

## Phone-first interface — 29 October 2026

The storefront and shopping account now share a phone layout for viewports up to 768px: a compact search header, five-button bottom navigation, collapsible category/price/seller/sort controls, larger product actions, bag/product bottom sheets, safe-area spacing and 16px form inputs. Desktop filters and account panels remain visible above that breakpoint. Phone account navigation separates Bag, Delivery and Requests; saving delivery details returns to the bag, and a submitted quote opens Requests. Saved-products links can open directly from the account page.

Browser QA checks used 320px, 390px and 430px frames (with no horizontal document overflow), plus a 1024px desktop frame. Checks covered filters, saved products, bag sheet dimensions, account tab visibility and field sizing. These are browser viewport checks, not a claim of testing every physical handset. Existing provider/payment restrictions are unchanged.
