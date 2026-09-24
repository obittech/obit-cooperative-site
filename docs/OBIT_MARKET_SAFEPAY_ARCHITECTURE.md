# Obit Market + Obit SafePay operating architecture

## Entity roles

### Obit Technologies Limited
Obit Technologies Limited is the technology infrastructure owner and operator for Obit Market and Obit SafePay. It develops and maintains the software, APIs, integrations, platform operations and associated technology intellectual property.

### Obit Technologies Multipurpose Cooperative Society Limited
The Cooperative is the member-owned community partner. It manages cooperative membership, governance, member programmes and the relationship with its members. Obit Cooperative is the anchor community/first tenant. The platform data model uses a community tenancy layer so Obit Technologies can later serve other approved cooperatives, associations and communities under separate commercial arrangements without transferring product ownership.

### Approved financial providers
Payment, escrow, custody and settlement functions are performed only by approved third-party financial providers under their own regulatory permissions. Consistent with the inter-company framework, such providers are selected or approved, integrated and technically managed through Obit Technologies to the fullest extent legally permissible; where law or provider rules require direct Cooperative contracting, Obit Technologies remains lead technical integrator where lawful. Neither Obit Technologies Limited nor the Cooperative should represent itself as holding customer funds under the SafePay model unless a future licensed structure expressly permits that activity.

## Product ownership
- Obit Market: technology product/infrastructure of Obit Technologies Limited.
- Obit SafePay: protected-transaction orchestration layer of Obit Technologies Limited.
- Cooperative member/community programmes: operated by the Cooperative.
- Provider escrow/payment rails: supplied by contracted third-party financial providers.

## Data governance
Technology ownership does not equal ownership of personal data. Before production, the parties must document their respective controller/processor roles, lawful bases, data-sharing purposes, retention, security, incident response, data-subject rights and cross-border transfers where applicable. A written data-processing/data-sharing agreement is required where the legal roles call for it.

## Commercial relationship
Before production, execute an inter-company Technology Infrastructure & Strategic Partnership Agreement covering:
1. technology licence and IP ownership;
2. service scope and service levels;
3. fees/revenue allocation and related-party approval;
4. marketplace governance;
5. data protection and security;
6. payment-provider responsibilities;
7. complaints and dispute escalation;
8. audit and records;
9. business continuity and exit/data portability;
10. termination and transition.

## SafePay production guardrails
- No Obit-held stored-value wallet in this phase.
- No browser/client event may mark an order funded.
- FUNDED must be derived from a cryptographically verified provider event.
- Release/refund calls remain disabled until provider sandbox documentation, signatures and end-to-end tests are complete.
- Public copy must identify Obit Technologies as technology operator, the Cooperative as community partner, and the contracted financial provider as custodian/settlement provider.
- Provider onboarding must use the legal entity that actually contracts for the integration. Documents from one Obit entity must not be substituted for another.

## Deployment
This architecture document records the intended operating model. It does not itself transfer IP, personal data, licences or regulatory responsibility. Those effects require signed agreements and applicable approvals.


## Multi-community tenancy
- `communities` is the tenant boundary for Obit Market.
- `obit-cooperative` is seeded as the anchor tenant.
- Listings and orders carry `community_id`.
- Cooperative membership remains the current pilot access model; future community identity adapters must be introduced deliberately rather than hard-coding ownership into the Market product.
- Cross-community access is disabled until tenant authorization, privacy and commercial controls are implemented.

## Webhook safety
SafePay webhooks are fail-closed. A provider must supply the exact signature contract before production activation. The handler requires an explicitly configured signature mode, secret, signature header and funded-event name. Unknown or unmatched events are recorded without changing money state. Only a verified configured funded event can move an order from AWAITING_FUNDING to FUNDED.
