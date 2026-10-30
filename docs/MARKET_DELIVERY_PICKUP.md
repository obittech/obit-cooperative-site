# Obit Market delivery and pickup foundation

Release: 30 October 2026. Real courier bookings, dispatch, live payments and refund/escrow releases remain disabled.

## Production capabilities

- Staff can create pickup location drafts with a name, public address, town, Nigerian state and opening hours. A separate explicit review confirms operational readiness and records a private verification note.
- Only ACTIVE locations with a saved verification are returned by the public options API. No locations are seeded into production. Do not publish an office, FFK kiosk or partner address until its operator has agreed to receive collections and staff have verified the arrangements.
- Editing a location clears verification and returns it to DRAFT. Pausing removes it from public options. Versions protect against stale staff edits and approvals. Public responses exclude staff notes and reviewer identifiers.
- Buyers can choose seller-quoted home delivery or a verified pickup point for their next request. The choice remains in the current page until submitted. A pickup quote stores the published address, hours and version as a snapshot, while preserving the buyer's recipient/phone details privately. Sellers see the pickup's public details and quote their delivery fee to that destination. No booking or customer notification is sent.
- The request hash includes delivery method and point ID. A retry returns the same request even if the point is later paused. Old home-delivery request hashes remain replay-compatible. A change of method or pickup point needs a new request key.
- Pickup edits or pauses reject stale quote acceptance and checkout. A received test payment after a pickup closure is recorded for review without committing stock. Already stored quote/order snapshots are not rewritten.

## Isolated tracking simulation

Set `MARKET_DELIVERY_MODE=test` only on a separate test/development runtime. Production always rejects shipment creation and tracking writes. A confirmed Monnify test payment with committed test stock is also required. The flag alone cannot create a shipment for an unpaid order.

The seller or staff may prepare one simulated shipment per order. References start `TEST-SHIP-`. Creation retries return the same shipment. No courier adapter is called.

| Method | Allowed test progression |
| --- | --- |
| Home delivery | PREPARING → IN_TRANSIT → buyer-confirmed DELIVERED |
| Failed attempt | IN_TRANSIT → DELIVERY_FAILED → IN_TRANSIT |
| Pickup | PREPARING → READY_FOR_PICKUP → buyer-confirmed DELIVERED |

Only the owning buyer can confirm receipt. Sellers/staff cannot set DELIVERED. Tracking commands use an optimistic version and a stable request key/payload hash, so retries do not duplicate events and conflicting commands are rejected. Tracking notes are shared with the owning buyer/seller and authorised staff. Do not include identity numbers, private contact details or financial information in notes. Status changes are blocked while a payment needs review or a pickup snapshot is no longer valid.

The order's payment status remains separate from shipment status. Receipt confirmation does not pay a seller, release escrow, create a refund or restock inventory. These require later provider-backed processes. This release does not provide a real collection code, courier scan, GPS location, proof of delivery or operating pickup service.

## Access and operational controls

Buyer and seller views receive delivery preferences and tracking only for their own orders. Staff use the existing Market tab for location reviews and delivery details. Public delivery options do not expose orders or shipments. Public pickup options and private staff location lists are bounded to 200 rows. Existing buyer/seller order history remains bounded to 50 orders; test tracking is limited to 50 events per shipment.

Listing/order/payment operations retain their existing locks. Pickup verification is checked under a location lock before acceptance, checkout and test shipment actions. No provider credentials, real customer fixtures or pickup addresses are added to production by deployment.

## Required before real fulfilment

Connect an agreed courier service with credentials, serviceability and rate quotes, booking idempotency, signed and deduplicated shipment events, cancellation/failed-delivery handling and delivery evidence. Confirm pickup operators, hours, storage/security and customer handover controls. Test payment reversal/refund interactions, package loss, pickup closure after payment, collection expiry and split-seller shipments. Obtain final delivery/returns policies and activate only after a reviewed live release.

## Verification

101 backend tests and five cart tests pass locally. Nine new scenarios cover location review/version/privacy, pickup snapshots and replay, stale point rejection, production and payment gates, ownership, tracking idempotency and versions, buyer-only receipt, pickup/home state transitions, payment review, delivery retry races and pickup closure after checkout. Isolated browser QA used fictional locations and mocked Monnify receipts to check mobile pickup requests, seller preparation, readiness, buyer receipt, staff draft publication and pause. Checks cover 320/390/430 px layouts. PostgreSQL CI must pass before merging. These checks do not certify a real courier or pickup operation.
