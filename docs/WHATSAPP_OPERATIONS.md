# Obit WhatsApp integration

Status: prepared, not connected or enabled. Review updated 5 November 2026.
The existing business number is +2348030567787. The current OBS portal is
https://login.obittechnologies.com/login. It was reachable during this review
but required sign-in. The old mylogin address is not evidence that OBS is down.

Earlier session records reported this number connected in OBS with webhook
active and Business app/API coexistence on 28 October and 1 November. They also
reported automatic replies left off after Gemini failures. These are historical
observations, not a fresh inspection of provider settings. WABA ID, phone ID,
Meta app ownership, actual callback URL, subscriptions, secure forwarding,
coexistence echo delivery and current inbox behavior remain unverified.

Preserve the OBS inbox, connected number, callback URL and subscriptions.
Do not disconnect/reconnect the number, replace the callback, add subscriptions
or enable a second responder as part of this PR. No production settings were
changed in this review.

## Intended operation

An applicant completes the cooperative identity checks, uses the website's
membership checkout and reports payment. Staff checks actual bank credit.
An authenticated business-app message can then confirm the exact saved payment,
activate membership, assign a membership code, create community onboarding and
savings records, and record any applicable referral bonus once. The bonus is
recorded as payable. This never transfers money or credits savings with it.

Incoming customer messages cannot approve payment or membership. Attachments,
screenshots, old message history, bare “Confirmed”, and self-chat messages with
no payment reference cannot approve anything. No bank API is connected by this
change. A payment reference is not a bank transaction reference.

The prepared command syntax is:

`CONFIRM MEMBERSHIP <OBIT-MEM-reference> AMOUNT 3000 BANK <actual-credit-reference>`

Staff sends this in the registered applicant's WhatsApp chat after checking the
bank credit. An example in tests uses synthetic references only. The command is
accepted only from a signature-verified `smb_message_echoes` event for the pinned
WABA, phone-number ID and business telephone number. Any person with access to
that business app can produce such an echo, so linked devices must be restricted
to authorized payment approvers. A standalone incoming “Confirmed” from a
customer, or text forwarded through an unverified CRM callback, is rejected.
Activation uses the current shared `activateApprovedMember` helper used by
staff approvals. It copies the saved registration username and password hash
into the new member account, links the application to the user and awards any
referral once. New registrations can log in immediately after approval using
username, registered email, phone number or membership code with their password.
Existing members without credentials retain the website's identity-checked
credential setup path. Passwords and setup codes are never sent by WhatsApp.

An existing account must be an active member identity. Administrator identities
cannot be converted into member identities.

The latest identity check must be a verified live Youverify session. Sandbox
and locally simulated checks require staff review. Wrong amounts, the wrong
applicant chat, reused bank references, suspended approvers and unexpected
application states are held for review. Financial state changes use one
transaction, application locks and unique credit allocation. Delivery retries
cannot create duplicate memberships or referral bonuses.

## Business replies

The initial assistant uses fixed, reviewed business answers, rather than a
language model with access to financial actions. It introduces itself as an
automated assistant. It covers:

- Obit Technologies Limited: software and business automation, OBS Starter at
  ₦25,000 monthly for four core systems and Business at ₦100,000 for all eight.
- Obit Technologies Multipurpose Cooperative Society Limited: website
  registration, identity verification, payment and membership access.
- Finance: members use their username, registered email, phone number or
  membership code and password on
  finance.obitcooperative.com. Private balances belong in the portal.
- Obit Market: buyers may browse, sellers must be approved cooperative members.
- Payment claims: receipt collection and staff bank-credit verification.
- Loans, kiosk investment, solar, complaints and refunds: staff assistance.

It does not promise investment returns, live Moniepoint synchronization,
automated bank-credit checks, KYC approval, loan approval or provider readiness.
It does not ask for PINs, passwords, OTPs, BVNs or NINs. Unknown requests receive
the business menu. Uploaded receipts are not downloaded or analyzed here.

STOP persists an opt-out, START clears it, and HUMAN or a business-app response
holds replies for staff for 24 hours. This is a handoff queue, not a claim that a
staff notification has been delivered. Staff reviews the existing inbox and the
protected review endpoint. Automatic replies are sent only for incoming text
messages less than 23 hours old. Welcome messages also require a recorded recent customer message and no opt-out. No bulk marketing or proactive template
messages are enabled.

## Compatibility with current membership

Main includes PR #62 (combined staff payment confirmation and approval), PR #68
(registration credentials), and later reviewed-duplicate and member-finance
changes through PR #73, including locked savings plans and equipment loans. Both member-finance and WhatsApp migrations and routers are retained.
There is one activation helper, rather than separate WhatsApp account creation.
It refuses privileged, suspended and ambiguous contact matches. Saved registration
credentials cannot overwrite an existing user. Referral awards remain separate
from savings and protected by the unique application constraint.

The staff combined endpoint retains its existing behavior of keeping a verified
payment when a known duplicate membership requires review. The stricter WhatsApp
path rolls back payment and activation on identity conflicts and sends the event
to administrator review. It never performs the staff-only approve-existing link
operation. A repeat of the same confirmed reference and active application does
not award another bonus or create another ledger. Wrong credit references fail.

Business-app echoes authenticate the sending business number, not the individual
staff device. The configured administrator is an audit attribution and must be
active. It does not prove which human sent the message. Restrict linked devices
to authorized approvers. Keep automatic approval off until that control and the
provider event provenance are verified. ChatGPT text is not a webhook event and
does not execute this command.

## Proposed production configuration, awaiting approval

| Item | Proposed change | Condition |
| --- | --- | --- |
| OBS number, inbox, callback and subscriptions | Preserve existing values | Inspect signed-in provider settings first |
| Cooperative feature flags | `WHATSAPP_ENABLED=false`, `WHATSAPP_APPROVAL_ENABLED=false` | Initial deployment only after approval |
| Secrets | Add app secret, verification token and sending token in secret settings | Confirm owner/provider and scopes, never commit values |
| Account pins | Set WABA ID, phone ID, supported Graph version and active approver ID | Values still unknown, do not guess |
| Event delivery | Provider-supported authenticated forwarding preserving raw bytes and Meta signature, or a separately reviewed authenticated adapter | Do not replace the OBS callback or accept unsigned CRM JSON |
| Automated replies | One reply owner per conversation, preserve OBS inbox and manual takeover | Controlled handset validation and separate enablement approval |
| Automated approvals | Leave disabled | Live identity, actual bank-credit check, echo provenance and approver-device controls validated and approved |

If OBS cannot forward the original signed Meta body, this endpoint is not a
compatible receiver for its callback. Obtain the provider's documented event and
authentication contract, then review and test a dedicated adapter. No adapter or
new subscription is assumed to exist. Rollback means disabling both feature
flags while keeping staff web approval available and leaving OBS unchanged.

## Connection and release checklist

1. Inspect the existing OBS WhatsApp settings and provider. Verify the number,
   WABA ID, phone-number ID, Meta app ownership, permissions and supported API
   version. Determine whether OBS can securely forward Meta raw-body signatures
   or whether its provider requires a different authenticated adapter. Do not
   forward an unsigned message into this Meta endpoint.
2. Store WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and WHATSAPP_ACCESS_TOKEN in
   the service's secret settings. Do not send them in chat or commit them.
3. Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID, WHATSAPP_GRAPH_VERSION and
   WHATSAPP_APPROVER_USER_ID to verified values. The approver must be an existing
   active cooperative administrator, not the member account.
4. Deploy with WHATSAPP_ENABLED=false and WHATSAPP_APPROVAL_ENABLED=false.
5. After arranging delivery without breaking the existing OBS webhook, enable
   WHATSAPP_ENABLED and register the GET verification handshake and POST events
   at `/api/webhooks/whatsapp`. Subscribe both `messages` and
   `smb_message_echoes` if the actual coexistence setup supports them.
6. Use a separate test handset. Verify incoming text, outgoing app echo and
   correct reply delivery. Confirm an incoming approval command cannot activate
   a member. Signed local fixtures do not prove live provider delivery.
7. Keep approval disabled until a verified live identity session, a real staff
   bank-credit check and one controlled membership approval have been tested.
   Only then enable WHATSAPP_APPROVAL_ENABLED. Application 21 has not been
   approved or altered by this implementation.

`GET /api/admin/whatsapp/status` reports configuration presence and queue counts,
not a verified connection. `GET /api/admin/whatsapp/review` is administrator-only
and contains private applicant messages. Do not display it on a public page.
The server drains a durable queue every three seconds. Unknown send outcomes
are held for review rather than retried, to prevent duplicate messages.
Membership can be active even when its welcome message failed, so staff must
check the application before resending or reapproving. Completed events are
removed after 30 days. Review payloads are redacted after 30 days. Minimal event
IDs and review outcomes remain for investigation. Opt-out records persist.

## Validation and limits

Local SQLite tests cover signature checks, disabled configuration, account
pinning, incoming-versus-outgoing authorization, duplicate events, exact amounts,
credit reuse, identity checks, account collisions, opt-out and takeover. Existing
membership and referral tests cover the shared activation helper. The compatibility suite now includes real registration through WhatsApp approval,
all four login identifiers, saved password-hash retention, application/user linkage,
referral replay and shared privileged/suspended/ambiguous-account rejection.
The CI workflow runs it on SQLite and PostgreSQL. See the PR checks for execution
results. Live Meta/OBS delivery and end-to-end production approval are unverified. No credentials were obtained and neither business has automatic
WhatsApp replies enabled by this change.

Provider references consulted:
- https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
  (archived official SDK documentation for handshake and signature concepts).
- https://docs.360dialog.com/partner/onboarding/whatsapp-coexistence/coexistence-webhooks
  (provider's current echo envelope example).
- Direct retrieval of current Meta echo documentation was rate limited. Verify
  the real provider envelope and current Meta documentation before enabling.
