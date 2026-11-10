# Withdrawal retry safety and admin queue escaping

Based on main e41b016c8a75aafc26e1c052622b76891e928fa8.

## Withdrawal lifecycle and recovery

- An atomic row-locked claim stores a unique transfer reference and audit event before contacting Paystack. Repeated initiation returns that reference, including legacy, failed, unknown and paid transfers; it never sends a replacement transfer.
- The transfer request times out after 30 seconds. Transport failures, malformed JSON and rejected responses leave the reference in place. Unknown does not mean failed.
- A crash between claim and request intentionally leaves a locked claim. Never reset its reference or retry based solely on elapsed time or a provider 404.
- Reconcile the exact reference using the existing endpoint. Successful verification must match reference, amount and currency. Serialized accounting writes debit and issue a receipt once. The OTP flow still finalizes the same transfer.
- Claims reserve balance against other initiated legacy withdrawals, not every ledger writer or the separate manual-finance subsystem.
- Definite provider failure or a crash before submission requires an operator to verify the exact transfer with Paystack before designing recovery. No automatic reset/replacement path is introduced; unresolved reservations remain held.
- Existing historical duplicate transfers are not reversed or repaired by this patch. No real financial action was taken in testing.

No schema migration is required. Existing references are respected. Rolling back reopens duplicate-payout risk and must not be used to force uncertain claims through.

## Stored XSS

Application names, IDs, timestamps, badge values and alert messages are escaped for HTML. Review buttons and normal text remain unchanged. Error strings from payment providers cannot inject HTML through the shared admin alert renderer.

## Verification scope

Tests use synthetic fixtures, isolated databases and mocked provider HTTP. Coverage includes concurrent and repeated initiation, uncertain outcomes, persisted interrupted-claim states, old references, competing account claims, mismatched provider verification, concurrent accounting reconciliation, OTP completion, authorization/configuration failures, and hostile/ordinary/empty queue renderings. Interrupted-claim coverage seeds the durable crash state rather than killing a running network request. Actual provider sandbox calls, device/browser QA and deployment readiness are separate checks.
