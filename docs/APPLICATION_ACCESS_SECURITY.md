# Application access security release notes

This patch requires authenticated ownership for application read/edit/consent,
KYC session/status/verification/simulation, and membership checkout/transfer detail
and payment-claim endpoints. Application IDs and provider references are never
credentials. Staff administration and provider webhook verification remain intact.

New applications receive a separately signed four-hour application-scoped bearer
session. The frontend retains it only in sessionStorage. Resume requires the
registration username/password; linked members must prove their current member
password and active account/membership. Password/session-version changes revoke
older sessions. Existing member sessions work for explicitly owned records only;
email/phone similarity never proves ownership. Responses carrying personal data or
new sessions use Cache-Control: no-store.

Legacy credentialless applications remain fail-closed when a scoped session is
unavailable or expires. This patch adds no support-token issuance or recovery
backdoor. Support must separately verify ownership using an approved procedure.
The frontend keeps saved application IDs after expiry/network failure and shows
credential recovery instead of silently creating a duplicate. Active members can
use their authenticated Member Portal session. Error messages render as text,
not HTML.

Operational cautions:
- Coordinate backend/frontend release and refresh cached clients. Backend guards
  deny older frontend requests until the client loads session/recovery support.
- No new migration or external secret is needed; retain a strong existing
  AUTH_TOKEN_SECRET. No KYC/payment production settings are changed.
- Resume throttling is bounded but process-local (five username attempts and a
  broad 300 socket-IP requests per 15 minutes). Proxy IPs can be shared. Review
  trusted-edge/shared client-IP limits when scaling. Never trust arbitrary
  forwarded headers. Wider signup-abuse controls are separate work.
- Browser bearer tokens remain accessible to JavaScript. Same-origin HttpOnly
  cookie migration and broader XSS review are separate work. Do not log tokens.
- Do not roll back to unauthenticated access. Prefer maintenance responses if a
  recovery problem arises.

Integrated release validation (Node 22.23.4): full backend SQLite 170/170,
PostgreSQL 18.6 isolated-database suites 170/170, frontend 41/41, and isolated
synthetic HTTP application/KYC ownership and credential-resume smoke passed.
JavaScript syntax and whitespace checks passed. Real mobile/browser visual QA
remains unverified because the test browser could not reach the isolated server.
No real KYC, payment or member-data operations were used for validation.

Commands:
- backend: npm test
- backend: npm run test:access
- backend: node --experimental-sqlite test/application-http-smoke.mjs
- repository root: node --test tests/*.test.cjs

The PostgreSQL CI workflow includes application-access tests for both engines and
runs on main, security/** and the existing feature/postgres-runtime branch, plus
pull requests targeting main. Test fixtures authenticate explicitly. Authorization
tests execute full route chains and deliberately do not use fixture-token helpers.
