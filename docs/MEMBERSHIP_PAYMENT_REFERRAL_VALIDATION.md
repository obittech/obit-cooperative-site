# Membership payment and referral validation

Controlled validation on 1 November 2026 against main e193c7f with the approval guard in this branch.

## Results

131 backend tests and 14 frontend regression checks passed locally on Node 24.22.1 using isolated SQLite databases. Identity results, bank credits and payout records were synthetic. No real identity check, payment, WhatsApp message or disbursement was initiated. The registration suite covers registration, simulated identity verification, signed gateway confirmation, staff approval and portal login. The referral suite exercises registration through internal transfer, notification, staff confirmation, approval, bonus earning and synthetic payout recording.

Validated: server-priced fee and account snapshots, one checkout reference under concurrency, notification remains pending, exact amount and staff permission checks, cross-membership/market bank-reference reuse rejection, active sponsor lookup from registered records, self-referral rejection, frozen attribution after checkout, one 50000-kobo bonus after payment and approval, duplicate approval/reward prevention, payout-reference reuse prevention, separate earned/payable/paid totals and unchanged savings balances.

Found and corrected: approval previously trusted UNDER_REVIEW without independently requiring a confirmed membership payment. An unpaid application in this state could become ACTIVE. Approval now requires a CONFIRMED internal transfer or PAYMENT_VERIFIED gateway record within the approval transaction. Regression verifies no membership or bonus is created on rejection.

## Production observation and remaining requirements

The read-only live /api/payments/membership/options endpoint returned Moniepoint MFB, OBIT TECHNOLOGIES LIMITED, account 4006326446, fee 300000 kobo and WhatsApp 2348030567787. This proves the currently served configuration, not bank ownership or credit arrival. Compare the complete account number and name with authoritative company bank records before launch. Existing checkout records retain their original account snapshots.

Run the added Node 22 SQLite and PostgreSQL membership/referral CI checks. Local PostgreSQL was unavailable. Review, merge and deploy the approval guard through the normal workflow, then confirm the deployed revision. Test staff screens and mobile registration in staging with synthetic records. Production bank reconciliation remains a manual staff control: a checked checkbox and supplied reference are staff attestations, not an automated bank verification. Use the bank's canonical unique transaction reference consistently. Different text references for the same actual credit cannot be detected without authoritative bank integration. Bonus PAID records likewise attest to an independently completed payout and never initiate one.

No real production membership payment or end-to-end bank settlement was tested. Reliable operations require designated reconciliation staff, independent bank access, handling of wrong/short/duplicate transfers, and a documented payout/reconciliation process. Do not treat a WhatsApp notification, receipt screenshot or earned bonus as settled funds.


## PR #58 PostgreSQL registration failure investigation

Run 41289332794 passed the first PostgreSQL registration suite, then ran that suite again against the same `obit_ci` database. The registration fixture generated a new email but always used phone `08000000000`. The first journey created a membership for that phone. The second journey correctly matched that existing user by phone and rejected duplicate membership. SQLite did not reproduce this because each process used a fresh in-memory database. This was reused fixture identity across repeated PostgreSQL runs, not a failure of the confirmed-payment requirement.

The registration fixture now chooses a fresh synthetic phone after checking both application and user records. The repeated PostgreSQL workflow steps remain in place to verify reuse of a populated database. A new regression separately reuses an existing member's email and phone on a paid application and verifies rejection, no new membership or referral bonus, unchanged review status, and preservation of the confirmed payment for reconciliation. No production service or duplicate-account guard was weakened.

Local Node 24 validation after correction: 132 backend tests and 14 frontend checks passed. PostgreSQL and Node 22 validation remain subject to the updated PR's GitHub Actions results.
