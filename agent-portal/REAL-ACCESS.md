# Agent access preparation

Prepared, not activated. Keep the existing sandbox service unchanged until persistent hosting and first administrator are configured.

## Runtime

Node 22.13 or newer. Start: `node agent-portal/live-access.mjs`.

Required environment:
- `AGENT_ACCESS_ENABLED=true`
- `AGENT_DB=/var/data/agent-portal/accounts.sqlite`
- `AGENT_ORIGIN=https://agent.obitcooperative.com`
- `PORT` supplied by Render

Attach a dedicated persistent disk at `/var/data`. Do not share the cooperative's existing financial database or copy its member records. The runtime starts empty, creates no demo accounts or sample sales, and retains disabled financial write routes.

## Accounts

Run `node agent-portal/provision-account.mjs` in the persistent service environment. Supply one JSON object through protected stdin. Never place passwords in command arguments, source files, tickets or chat. The `account` object contains username, name, role and password. Passwords require 14–256 characters. The first account must be admin. Subsequent creations also require `adminUsername` and `adminPassword` in the stdin object. Existing accounts cannot be overwritten. Agents have isolated records. Admin can review all agent records. This is a staff provisioning utility, not yet a self-service invitation interface.

## Before activation

1. Approve the hosting and disk cost, configure mount and backups, and test restore.
2. Name the first administrator and complete password entry securely.
3. Test administrator provisioning, agent isolation, login on the custom domain, session expiry, and enquiry retention after restart using synthetic records.
4. Approve actual commission rates before adding any real sale or commission integration.
5. Keep payments, payouts, membership approval, bank verification, ledger writes and external messaging disabled.

Known limits: local SQLite supports one service instance. Enquiry workflow and sales views are inherited from the prototype. No real sales integrations, self-service agent administration, approved commission engine or production backup verification are included. Do not describe this preparation as completed production activation.

Validation: syntax checks passed for both scripts. Runtime activation rejects unset activation flag and temporary or unrelated database paths. Full deployment and restart persistence test require approved persistent hosting.
