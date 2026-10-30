# Manual fulfilment, returns and refund records

Release 30 October 2026. Applies to confirmed company bank-transfer orders only. No bank transfers, courier bookings, KYC calls or seller settlements are initiated by these actions.

## Buyer

Account > Orders shows staff-recorded preparation, carrier and handover/tracking reference. Only the owning buyer can confirm receipt after IN_TRANSIT or READY_FOR_PICKUP. Receipt does not release money or prevent an issue report. A buyer may open one return/refund case per confirmed order, including non-delivery. Duplicate identical requests return the same case. Different requests for the same order direct the buyer to support, preserving the original record.

## Staff

Admin > Market > Purchase orders > Fulfilment / returns / refunds. Unresolved cases are prioritised within the 100-order operations list. Staff can see the actual delivery destination for this order. Only active staff/admin users have access.

Staff prepare an order after confirming the actual bank credit. Home delivery uses PREPARING > IN_TRANSIT, with failed-attempt and retry updates. Pickup uses PREPARING > READY_FOR_PICKUP. Dispatch needs a carrier and handover reference. Pickup readiness rechecks the verified location. Opening a case blocks new dispatch or receipt updates until a decision. These updates are manual records, not courier scans, automatic bookings, GPS, delivery evidence certification or guarantees.

## Return and refund handling

OPEN > RETURN_AUTHORISED > RECEIVED > APPROVED or REJECTED. OPEN may move directly to APPROVED for cases such as non-delivery, where goods need not come back. All decisions require a customer-visible reason. Agree the return destination, logistics, costs and inspection with the buyer before authorisation. Never auto-restock returned goods. Inspect and use existing inventory controls separately.

APPROVED is not a completed payment. Staff make the bank refund outside this application, verify the debit and agreed buyer recipient, then record its amount and unique bank reference. Partial refunds are supported up to the approved amount and never above confirmed funds. One bank reference cannot record multiple refunds. The buyer receives an OBRF receipt reference, amount and recorded date, while bank references remain staff-only. This attestation does not independently establish recipient-bank credit. No payout account or identity number should be placed in public case notes.

Rows are locked in the existing transaction adapter. Version checks prevent stale dispatch and case decisions. Bank-reference recording is serialised across API replicas. Records and audit events commit together. Additive tables leave existing sandbox shipment mode constraints unchanged. Sandbox payments cannot authorise manual live fulfilment.

## Remaining operating requirements

Publish agreed category-specific return periods/exclusions, delivery service areas, refund times, return charges and seller settlement arrangements. Confirm genuine pickup operators and couriers. Onboard actual sellers and products. Complete an authorised real bank-credit, handover, buyer-receipt and refund pilot. Automated financial settlement and courier integration remain separate work. No store or product is deleted by this release.

## Verification

114 backend tests and six frontend tests passed locally. New integration checks cover paid-order requirements, access/privacy, staff versus buyer receipt, concurrent dispatch, return deduplication, inspection, approval caps, cumulative refund limits, duplicate bank references, stale versions and migration replay. PostgreSQL CI and Render status are checked before reporting publication.

Late or unfulfillable credits: staff may verify the actual bank credit for refund review only. This releases the hold, opens an issue case and never commits stock or permits dispatch. A verified credit can then be refunded through the same approval and debit-record process. Repeating the same credit review does not duplicate its case.
