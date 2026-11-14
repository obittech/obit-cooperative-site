# Terminal Youverify lookup outcomes

A provider lookup is terminal only when the synchronous response is HTTP 200,
`success` is boolean `true`, a safe `data.id` report reference has been captured,
and `data.status` is exactly `found` or `not_found`.

- `found` continues through the existing name and date-of-birth matcher.
- `not_found` records request state `NOT_FOUND`, keeps the applicant and check
  `KYC_PENDING`, saves only a safe local outcome, and writes `KYC_NOT_FOUND` to
  the audit log in the same transaction. It does not verify or reject identity.
- Other statuses, absent/invalid tracking references, malformed responses,
  HTTP errors (including 404), and timeouts remain `UNKNOWN` and require manual
  reconciliation. No message text or alternate status spelling is inferred.

All reservations, attempts and the same-product 24-hour duplicate restriction
are retained. No automatic retry or alternate-product dispatch is introduced.
If terminal persistence or audit fails, the transaction rolls back and the
request remains blocked as `DISPATCHED`. A status read derives the public note
from the latest saved receipt for the check, so a newer unresolved request
cannot display an old terminal outcome. It also supports manually reconciled
receipts without modifying historical applicant details.

## Provider contract limitation

Youverify's [verification-status guide](https://doc.youverify.co/how-to/verification-statuses)
describes **Not Found** as a completed failed lookup, unlike **Pending**.
The [Quickcheck OpenAPI specification](https://doc.youverify.co/api-reference/specs/quickcheck.json)
uses the exact `not_found` value on other identity-report endpoints; its NIN
example only shows `found`. Thus the exact failed NIN response shape is a
narrow assumption about the standardized report contract, not a captured
production-response fixture. A read of the existing NIN report was denied
HTTP 403 during investigation. No new billable verification was requested.

The regression tests use synthetic responses only. If a NIN response uses a
different shape, it remains safely unresolved instead of being automatically
cleared. Confirm the failed NIN contract with Youverify before widening this
allowlist. Do not automatically rewrite historical `UNKNOWN` records: each
requires evidence-backed reconciliation.

## Retry-time messaging

The public negative-result message is calculated from the saved request's
`started_ms`, not from the time the page is reopened. During the inclusive
24-hour duplicate window it shows the original UTC end timestamp. After that
window it says the previous waiting period has ended and still asks the
applicant to contact support to check their details. It does not promise that
another request will be accepted: consent, unresolved-request, attempt,
product and budget checks remain unchanged. Missing/invalid timestamps produce
support guidance without inventing a retry time. Status reads never dispatch
a provider request or alter history.
