# Obit marketplace rollout

Obit Market is the cooperative community marketplace, operated on technology infrastructure supplied by Obit Technologies Limited. Sellers require active cooperative membership; the public catalogue is open to buyers. This release expands the existing site, using its approved product listings and seller moderation.

## Delivered storefront

Green and gold responsive navigation, global search, category discovery, seller filtering by public member-shop alias, price filters and sorting, product details, browser-saved wishlist and cart, current-catalogue price totals, quantity editing, payment-plan estimates and downloadable bulk enquiry drafts. Bulk drafts are not sent automatically. Cart and wishlist do not synchronize across devices. The catalogue endpoint currently returns the latest 100 active listings.

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
