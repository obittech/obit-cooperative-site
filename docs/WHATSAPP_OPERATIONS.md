# Obit WhatsApp integration

Status: prepared, not connected or enabled. The existing WhatsApp number is
+2348030567787. Earlier OBS work used mylogin.obittechnologies.com. During this
change that dashboard could not be reached. Its live connection, provider API,
webhook subscription and coexistence support still need verification. Do not
replace its callback URL or subscribe another app without checking ownership
and preserving the existing inbox.

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
- Finance: members use their membership code and password on
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
membership and referral tests cover the shared activation helper. Live Meta/OBS
delivery, PostgreSQL execution and end-to-end production approval have not been
verified. No credentials were obtained and neither business has automatic
WhatsApp replies enabled by this change.

Provider references consulted:
- https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
  (archived official SDK documentation for handshake and signature concepts).
- https://docs.360dialog.com/partner/onboarding/whatsapp-coexistence/coexistence-webhooks
  (provider's current echo envelope example).
- Direct retrieval of current Meta echo documentation was rate limited. Verify
  the real provider envelope and current Meta documentation before enabling.
