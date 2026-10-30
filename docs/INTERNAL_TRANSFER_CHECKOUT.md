# Internal bank-transfer checkout

Buyers accept a seller quote, open Pay Now, transfer to the configured company account and click I Have Paid. No receipt upload is requested. The server saves a pending notification and supplies a WhatsApp link to +2348030567787 with the order reference and amount. The buyer must tap Send in WhatsApp. Staff follows payment and delivery there. No automated WhatsApp or AI service is connected by this change.

Staff open Marketplace payment records in admin and confirm the actual credit using its unique bank transaction reference and exact order amount. Buyer notifications never mark an order paid. Confirmation commits stock once and exposes a printable receipt in the buyer account. Reused bank references are rejected. Late notifications remain in review for staff to resolve. No payout, refund or courier transaction is initiated.

## Activation

Set MARKET_TRANSFER_BANK_NAME, MARKET_TRANSFER_ACCOUNT_NAME and MARKET_TRANSFER_ACCOUNT_NUMBER to the confirmed receiving account, then set MARKET_TRANSFER_ENABLED=true and deploy the API. These variables are intentionally unset until the account is confirmed. Existing records keep an account snapshot. Sandbox Monnify remains separate and cannot share an order with internal transfers.

An opened checkout holds stock for 45 minutes. An on-time payment notification extends the hold to 24 hours for staff review. Unconfirmed holds then expire. Confirmation after expiry requires staff resolution and is blocked by this endpoint. Staff must verify the bank credit independently.

The additive table is created at startup on both SQLite and PostgreSQL. Tests cover SQLite and the existing commerce, payment and KYC suites.
