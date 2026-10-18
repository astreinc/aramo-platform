# Aramo E-Sign Multi-Provider — Addendum A1: Precedence and Traceability v1.0

**Governing directive:** `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md`
(canonical: OneDrive `Aramo/locked`, sha256 `c1ecfb8e248f19cb6c03cd49bc0ba3571c58b1d144b6476955e5553ad0dc0037`;
Lead Architect, relayed by PO 2026-10-18).
**Authored by:** Code Executor, as the governed addendum the directive requires (§A: "Record an explicit governed amendment/addendum with precedence and traceability. Do not silently modify LOCKED originals.").
**Status:** program record. It changes no LOCKED original; it records how the new directive sits against them.

## 1. Precedence

For the program scope only (commercial allowance for Aramo Sign, tenant e-signature provider selection, the common availability/routing service, and the DocuSign and Adobe Acrobat Sign adapters), the Multi-Provider directive takes precedence over these earlier deferrals. Everything else in those directives stays in force.

| Earlier LOCKED clause | Effect for this program |
|---|---|
| E-Sign Product-Experience V1 Implementation, :10, :165, :200 (billing/plans/metering and external providers out of V1) | Superseded for program scope (the new directive names this one explicitly). |
| E-Sign Product-Experience V1 Backlog, :626-627 | Superseded for program scope. |
| E-Sign Dedicated-Prod-and-Subscription Backlog, :3 (do not build until activated), :144 (no plan names or quotas) | Activated for the Aramo Sign envelope allowance only. The V1 quantity (100 per monthly period) is ratified by the new directive and stored as plan-catalog data. Pricing, billing provider and payment collection stay out of scope. |
| E-Sign Independent Digital Signature Platform, :122 and §30 :859-869 (external providers, multi-provider settings, billing, metering not authorized) | Superseded for program scope by the new directive's explicit authorization. |
| DOC v1.1 :353 (R29 — third-party adapters remain deferred) | Superseded for program scope; the adapters implement the existing `SignatureProviderPort` as :229 anticipated. |
| DOC-TEMPLATE-ADMIN-RTR-1 :155 ("RTR remains Documents + Native E-Sign") | RTR stays Documents-governed; the signing provider is the tenant's selected provider (directive §4). The RTR gate (DOC-5 PL-1) is unchanged: only an EXECUTED Document satisfies it. |

The new directive names only the V1 Implementation directive as amended (its :5). The rows above beyond the first are recorded here as a typed divergence (precedence inferred from the directive's explicit scope, :38-41, :101-110, :131-136), for Lead confirmation.

## 2. Constraints carried forward unchanged

- **No plan logic in envelope state transitions** (Independent Platform :578, :902; Dedicated-Prod Backlog :132, :189). The allowance is checked and charged at the native provider's send seam (`apps/esign-service` `AramoSignAllowanceGate`), never in `libs/esign` lifecycle code.
- **No cross-service schema shortcut** (Dedicated-Prod Backlog :188). The allowance authority is the `scope:shared` library `libs/subscription` with its own `subscription` schema, used in-process the same way `libs/entitlement` is used by every service today.
- **Evidence sealed** (PX-V1 :197, DOC-3/4). External providers' completion artifacts are stored under their own labels; a provider artifact is never relabelled as the Aramo certificate.
- **apps/api reaches E-Sign only through `SignatureProviderPort`** (DOC-3 :67, Operational Closure :65).
- **Backend enforcement; frontend advisory.**
- **No live provisioning.** No tenant is subscribed by migration or by the production seed. A DEVELOPMENT subscription exists only through the governed local/test path, which refuses production.

## 3. Program decisions (executor, within the directive)

| # | Decision |
|---|---|
| A1-1 | Plan catalog: `subscription.Plan` + `PlanAllowance` (configurable `included_quantity`). Seed: plan `aramo-sign-included-v1`, allowance `esign.envelopes` = 100, `MONTHLY`. |
| A1-2 | Subscription: `subscription.TenantSubscription` with `period_anchor` and `source` MANUAL or DEVELOPMENT. No payment status is modelled (no billing provider has been selected). One open subscription per tenant (partial unique index). |
| A1-3 | Period: monthly from the anchor, UTC, day clamped to month length; no rollover of the included allowance. |
| A1-4 | Ledger: `subscription.AllowanceUsage`, unique `(tenant, allowance, send_key)`; states RESERVED, CONSUMED, RELEASED; origin SEND or HISTORICAL. Reservation is serialized per tenant and allowance by a transaction-scoped advisory lock. Overdue reservations stay counted until resolved against the envelope record. A consumed row also writes `esign.envelope.sent` to the existing `metering.UsageEvent` stream in the same transaction. |
| A1-5 | Send identity for Aramo Sign: `aramo-sign:envelope:<envelope_id>`. A retry of the same envelope never charges twice; void, decline and expiry after a send stay counted. |
| A1-6 | Refusals: `ESIGN_NOT_SUBSCRIBED` (403) and `ESIGN_ALLOWANCE_EXHAUSTED` (409), each with `details.reason` (`NOT_SUBSCRIBED`, `LIMIT_REACHED`), carried through the internal zone to the ATS adapter. |
| A1-7 | A send refused or failed before acceptance leaves its envelope in DRAFT; the governed ATS send now sends that DRAFT envelope on retry instead of reporting it as already sent. |
| A1-8 | Historical reconciliation: `AllowanceService.recordHistorical` records only real sent envelopes, into their own period, idempotently. |

### PR 2 — availability and routing

| # | Decision |
|---|---|
| A1-9 | Provider integration layer: `libs/signature-routing` (schema `signature_routing`). `TenantSignatureProvider` holds one active provider per tenant (no row = the built-in Aramo Sign); `SignatureProviderSelectionEvent` is an append-only audit of every change (enforced by trigger); `SignatureRequestRoute` freezes the provider on each created request. |
| A1-10 | One backend decision: `SignatureAvailabilityService.evaluate(tenant, actorScopes?)` returns provider, availability, a typed reason (NO_PROVIDER, NOT_SUBSCRIBED, NOT_AUTHORIZED, LIMIT_REACHED, PROVIDER_DISCONNECTED, PROVIDER_UNAVAILABLE, PROVIDER_REFUSED) and, for Aramo Sign, the allowance. Aramo Sign needs the `esign` capability AND an open subscription with allowance left. A selected provider with no adapter in this build reads PROVIDER_UNAVAILABLE. |
| A1-11 | Enforcement immediately before the send: `GovernedDocumentSigningService` (the single RTR/Offer send path) asks `SignatureRoutingService.forNewSend` before preparing the document or creating anything; a refusal is `ESIGN_SEND_UNAVAILABLE` (409, `details.reason`). It never falls back to another provider. Existing requests (resend of a DRAFT, reminders) route by their frozen provider; requests created before routing existed are Aramo Sign. |
| A1-12 | Policy authoring: publishing a policy that REQUIRES `rtr_present` is refused (422 `CLIENT_SUBMITTAL_POLICY_INVALID`, `details.reason = RTR_REQUIRES_SIGN`, `signature_reason`) when the tenant cannot send at all (NO_PROVIDER, NOT_SUBSCRIBED, PROVIDER_UNAVAILABLE). Temporary states (LIMIT_REACHED, PROVIDER_DISCONNECTED) do not block authoring; they block the send, and the RTR requirement stays enforced (DOC-5 gate unchanged). |
| A1-13 | Read for the UI: `GET /v1/document-signing/availability` (`document:read`, ATS capability), judged for the calling user. Frontend adoption lands with PR 3 so it reconciles with PR #959's recruiter UI instead of duplicating it. |

### PR 3 — Settings → Integrations → E-Signature

| # | Decision |
|---|---|
| A1-14 | `GET /v1/integrations/esignature/overview` (`integration:read`) and `PUT /v1/integrations/esignature/active-provider` (`integration:write`, held by tenant admins/owners). A change writes the append-only selection event and a structured log line. Only providers this build can send through are selectable; external providers read NOT_AVAILABLE (not "connected") until their adapters land. |
| A1-15 | ats-web Settings → Integrations → E-Signature panel renders the backend overview: active provider, provider statuses, Aramo Sign allowance (used of limit, renewal date, meter), the 80% warning and the 100% pause with contact-your-account-team guidance (no purchasing workflow exists). |
| A1-16 | Recruiter-surface adoption of `GET /v1/document-signing/availability` (T×R 360, board, list, My Desk) follows PR #959, which owns those surfaces' current "Requires Aramo Sign" behaviour: once #959 and this program land, #959's client-side subscription context is fed from the availability endpoint and its reason map gains LIMIT_REACHED and the provider reasons. |

### PR 4 — DocuSign adapter (shared external-provider framework)

| # | Decision |
|---|---|
| A1-17 | External adapters extend `SignatureProviderPort` (`ExternalSignatureAdapter`: connection state, OAuth, disconnect, completion retrieval). An adapter is registered only when its app registration is configured in the environment; otherwise the provider reads NOT_AVAILABLE everywhere. No production values are configured (no activation). |
| A1-18 | Credential custody reuses `IntegrationConnection` + the existing `connector/*` Secrets Manager namespace (no IAM change). Tokens are write-only, never in Postgres, logs or the browser; disconnect tombstones and disables. A rejected refresh marks the connection degraded → PROVIDER_DISCONNECTED and "Reconnect needed". |
| A1-19 | OAuth connect: Authorization Code + PKCE (S256); state stored as a SHA-256 hash, single-use, 10-minute expiry, bound to tenant + admin + provider (the callback is authenticated by the same admin's session cookie). The callback always redirects back to Settings with an outcome flag. This deliberately does not reuse the Microsoft state pattern (unverified nonce, replayable within its window). |
| A1-20 | Evidence: the provider's signed PDF is the EXECUTED artifact (same Document -> EXECUTED transition the RTR gate reads); the provider's own completion evidence is stored as the new `PROVIDER_COMPLETION_EVIDENCE` role with its kind (e.g. `DOCUSIGN_CERTIFICATE_OF_COMPLETION`) — never relabelled as the Aramo `EXECUTION_CERTIFICATE`. Migration `documents/20261018140000_provider_completion_evidence_role` (registered in the Pact provider). |
| A1-21 | Callbacks are hints: HMAC-verified (DocuSign Connect, raw body, constant time) → the envelope must be one this platform routed → the callback account must be the account that tenant connected → completion is confirmed by reading the envelope from the provider API. Idempotent per provider envelope. Uniform 204 (no oracle). |
| A1-22 | Provider failures are typed `ESIGN_SEND_UNAVAILABLE` with `PROVIDER_REFUSED` (4xx, with the provider error code), `PROVIDER_UNAVAILABLE` (5xx/429/network) or `PROVIDER_DISCONNECTED`; never a fallback to another provider. An accepted external send is recorded in the metering stream as `esign.external.envelope.sent.<provider>` (operational only; the tenant's own provider plan governs its quota). |
| A1-23 | Validation status: contract-tested against the documented DocuSign OAuth, eSignature REST v2.1 and Connect HMAC behaviour. **Live sandbox validation is pending** (no developer-account credentials). Items to confirm in the sandbox: Connect payload shape (both the wrapped `data.*` and flat shapes are accepted), signature-tab placement on the last page, and the reminder resend body. |

## 4. Release dependencies

Once deployed, every Aramo Sign send (RTR, Offer, sender console) is refused `ESIGN_NOT_SUBSCRIBED` until the tenant has an open subscription. Opening production subscriptions is commercial provisioning and needs separate authorization (directive :166, :185). See `doc/runbooks/RELEASE-esign-allowance.md`.
