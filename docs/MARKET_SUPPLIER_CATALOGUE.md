# Supplier catalogue

Staff sign in to Admin → Market Listings → Supplier catalogue and markup.
Load the researched batch, then Save private drafts. Nine product candidates are included from PVPro and SunPress public pages checked on 5 November 2026. These are research leads, not approved suppliers or available stock. No images were copied or permission inferred. The iron was advertised as a November preorder. Public prices are stored as observed_retail_kobo, never assumed to be agreed supplier cost. Supplier onboarding was not submitted and no messages were sent.

## Pricing and preparation

Edit a private draft using its Edit button. All money fields are integer kobo. markup_bps is basis points: 1500 means 15%, an editable planning example. Price = cost_kobo + handling_kobo + ceil(cost_kobo * markup_bps / 10000). Delivery is separately confirmed in the existing seller quotation. Invalid, negative and excessive prices are rejected.

Before Prepare for listing review, record confirmed supplier cost, actual stock quantity, responsible active cooperative-member seller ID, delivery estimate in days, an authorised image URL, supply-agreement and verification evidence references. Set supply_confirmed and content_authorised only after actual checks. checked_ms is the actual time in milliseconds of the latest price/stock check. References identify secure records, not personal identity documents.

Preparing creates a DRAFT listing with inventory. Existing staff listing approval remains necessary. Buyers do not need cooperative membership. Staff research and supplier costs remain behind staff authentication and no-store responses. No feed credentials or commercial commitments are created.

## Expiry and revisions

Linked supplier listings disappear from the public catalogue and become unavailable in cart/quote preview after 24 hours from verification. Bank-transfer checkout also rejects stale checks. This is enforced by server time without requiring a worker. Existing payments remain subject to bank verification and aftercare.

Published source keys are immutable. To revise an offer, pause the old listing using existing listing controls, then import a new source key with fresh evidence and prepare/review the replacement. Already-created orders retain their quoted totals. No automatic feed synchronisation is claimed.

## Deployment

This release also includes previously prepared versioned purchase terms and settlement-review checks. The commerce migration is additive for SQLite and PostgreSQL. Existing buyers and sellers are preserved. Automated settlement remains disabled. Supplier checklists do not execute transfers.

Run marketplace regressions and frontend tests. CI must validate PostgreSQL before merge. After deployment, verify staff-only routes reject buyer sessions, import the research batch, check it stays private, and complete one authorised supplier listing review before live sales.
