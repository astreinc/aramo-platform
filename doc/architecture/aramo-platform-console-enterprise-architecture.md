# Aramo Platform Console Enterprise Architecture

**Status:** ALIGNED-REFERENCE (north-star target architecture — not a build directive)
**Version:** 1.1 · **Date:** 2026-07-09
**Provenance:** Deep-research reference architecture (2026-07-09) grounded against repository reconnaissance of `aramo-platform` @ `platform-console`, adjudicated by Lead/Architect, adopted by PO. Supersedes the ungrounded draft of the same date.
**Governance relationship:** Implementation increments are governed by PO ruling instruments, repository reconnaissance, and LOCKED build directives filed to program canonical. This document informs those artifacts; it does not replace them.

---

## Architecture scope

This document defines the Enterprise Target Architecture for the Aramo SaaS platform.

It intentionally describes the destination state rather than the implementation sequence.

Implementation is governed separately through architecture decisions, repository reconnaissance, and incremental build directives.

The architecture is divided into two independent tracks:

1. **Operational Control Plane** — tenant lifecycle, platform console, identity, provisioning, audit, routing, support, and governance. **This is the current engineering focus.**
2. **Commercial Control Plane** — plans, pricing, subscriptions, billing providers, invoicing, usage charging, and customer self-service. **This is a future phase** that requires product strategy, pricing decisions, and billing-provider selection before implementation.

Recommendations in this document should not be interpreted as authorization to build every capability immediately.

---

## Part I — Foundations already in place

Aramo is not starting from zero. The repository already provides:

| Substrate | Current posture |
|---|---|
| Platform backend boundary | `apps/platform-admin`, scope-keyed (`platform:*`), separate from tenant `api`; `scope:platform` nx boundary tag with CI-enforced Platform⊥ATS import wall |
| Entitlements | `TenantEntitlement` boolean capabilities (`core`, `ats`, `portal`, `sourcing`) with a live `EntitlementGuard` / `@RequireCapability` runtime enforcement path |
| Metering | `UsageEvent` raw writes (write-only today; no reader/rollup) |
| Audit | Generic audit writer (actor, tenant, subject, JSON payload); actor type currently `'user'`-only |
| Identity & invitations | Membership invitation lifecycle (`INVITED`/`ACCEPTED`/`ACTIVE`); `acceptInvitationByToken` emits `identity.invitation.accepted`; reconcile-by-verified-email with account-takeover-safe link guard |
| Host & TLS | Wildcard `*.aramo.ai` DNS; Caddy on-demand TLS with `ask` endpoint for tenant hosts; per-tenant slug + HRD |
| Session posture | Host-only secure cookies; access cookie attributes already `__Host-`-qualifying (Secure, Path=/, no Domain); refresh/PKCE deliberately path-limited to `/auth`; per-consumer redirect derivation |
| Platform identity | Seeded platform owner; `super_admin` role with `platform:*` scopes; sentinel platform tenant |

The missing work is orchestration: turning these substrates into an operating model.

---

## Part II — Three independent state machines

The single most important architectural rule: **tenant lifecycle, commercial lifecycle, and subscription lifecycle are three separate state machines.** They interact through policy; they are never collapsed into one field, and no commercial state ever lands on the Tenant object.

### A. Tenant lifecycle (operator-owned; Operational Control Plane — current)

Intentionally minimal. Five states:

| State | Meaning | Set by |
|---|---|---|
| `PROVISIONED` | Tenant exists, owner invite issued, owner has not accepted | System on provision |
| `ACTIVE` | Owner accepted; tenant live | System on owner acceptance; platform admin |
| `SUSPENDED` | Blocked, reversible | Platform admin (reason required) |
| `OFFBOARDING` | Scheduled wind-down; export/retention workflow active | Platform admin |
| `CLOSED` | Terminal; retention/disposition policy takes over | Platform admin or automated retention job (future) |

`TRIAL`, `PAST_DUE`, `PAYMENT_FAILED` are subscription states, not tenant states. `ONBOARDING` is not durable tenant state. `REQUESTED` belongs before tenant creation (commercial track). These are modeled independently.

**Transitions:**

| From | To | Trigger | Guardrails |
|---|---|---|---|
| — | `PROVISIONED` | Provision flow (tenant created + owner invite issued) | Reserved slug check passes; owner invite exists |
| `PROVISIONED` | `ACTIVE` | `identity.invitation.accepted` for a `tenant_owner` membership | Automatic; idempotent; only if still `PROVISIONED` |
| `ACTIVE` | `SUSPENDED` | Platform admin action | Mandatory reasonCode + reasonText |
| `SUSPENDED` | `ACTIVE` | Platform admin action | Mandatory reasonCode |
| `ACTIVE` | `OFFBOARDING` | Platform admin action or end-of-term policy | Close date + retention policy code required |
| `SUSPENDED` | `OFFBOARDING` | Platform admin final-closure path | Same as above |
| `OFFBOARDING` | `CLOSED` | Effective date reached or operator close | Retention clock set |
| `PROVISIONED` | `CLOSED` | Abandoned provision, duplicate, legal request | Cause recorded |

**Activation trigger (normative, repository-grounded — v1.1 erratum, R9):** activation is invoked **inline** at the acceptance point (`InvitationLifecycleService.acceptInvitation`, immediately after `acceptInvitationByToken` commits), **not** via an event subscriber — no event bus exists for identity audit events and none is built (R9). The `identity.invitation.accepted` payload is enriched with `tenant_id` + `role_keys` (R10); activation fires only when `role_keys` includes `tenant_owner` AND the tenant is still `PROVISIONED`, and is idempotent (re-accept / non-owner / already-`ACTIVE` are no-ops). Because acceptance is pre-authentication, activation completes before first login. Do **not** key activation to `activateAcceptedMembershipsForUser` — that path processes all of a user's accepted memberships and cannot distinguish the owner; it may serve only as a compensating fallback.

**Login gate (normative — prevents the PROVISIONED deadlock):**

| Tenant state | Session mint |
|---|---|
| `PROVISIONED` | **Allowed** (owner invitation-acceptance / first-login flow must proceed — blocking here deadlocks activation) |
| `ACTIVE` | Allowed |
| `SUSPENDED` | Denied — typed `TENANT_SUSPENDED` error |
| `OFFBOARDING` | Allowed until effective date (configurable) |
| `CLOSED` | Denied — typed closed-tenant error |

**Enforcement staging:** immediate objective is the **mint gate only** — prevent new sessions; existing sessions expire naturally on the 15-minute access-token TTL, which effectively freezes tenant activity within one TTL of suspension. The request-level **write guard** across tenant APIs is a recorded future enhancement, not part of the initial lifecycle delivery. Operator transitions are explicit action endpoints (suspend/reactivate/start-offboarding/close), never free-form status updates; invalid transitions hard-fail and emit audit.

### B. Commercial lifecycle (CRM-owned; Commercial Control Plane — future)

`Lead → Opportunity → Customer → Former Customer`. Lives with the account/CRM concept, never on Tenant. Not modeled in the current phase.

### C. Subscription lifecycle (billing-provider-mirrored; Commercial Control Plane — future)

**Mirror the billing provider's source-of-truth states; never invent a homemade status model.** Stripe: `trialing / active / past_due / unpaid / paused / incomplete / canceled`. Chargebee/Paddle: equivalents. Internal `Subscription.status` mirrors the provider; Aramo policy maps subscription states to access behavior (grace periods, read-only, lock) — policy that *may* eventually drive a tenant suspension, but through an explicit operator-visible action, never by aliasing the fields.

---

## Part III — Operational Control Plane (current engineering focus)

### Tenant schema additions

Follow the repo's established convention: string status enforced by an application-level transition service (matching `domain_verification_status`, `invite_status`), not a DB enum — state additions stay code changes, not migrations.

```prisma
// additions to Tenant
status                  String    @default("PROVISIONED")
status_reason_code      String?
status_reason_text      String?
status_changed_at       DateTime  @default(now())

// milestone snapshot columns (current-state; audit answers "how did we get here")
owner_accepted_at       DateTime?
activated_at            DateTime?
suspended_at            DateTime?
offboarding_started_at  DateTime?
closed_at               DateTime?

// retention ARCHITECTURE only — policy values are counsel-gated
retention_policy_code   String?
retention_delete_after  DateTime?
legal_hold              Boolean   @default(false)
```

`is_active` is retained as a compatibility field during migration (ADD-not-rename) and retired only after validation. Backfill: `is_active=false → SUSPENDED (reason MIGRATED_FROM_IS_ACTIVE_FALSE)`; owner membership `ACCEPTED/ACTIVE → ACTIVE`; else `PROVISIONED`.

**Retention governance boundary:** the columns exist now; retention *policies* (windows, purge behavior, data-class rules) do not — counsel determines them later. `CLOSED` means frozen shut, disposition TBD. `legal_hold=true` suspends any future deletion and records the reason. No purge job ships before the counsel-gated retention directive.

### Audit model

Widen the audit substrate for lifecycle use:

- Actor taxonomy: `'user' | 'system' | 'provider'` (system actors required the moment automatic activation writes audit; provider actors reserved for future billing webhooks).
- Event types: `tenant.provisioned`, `tenant.owner_invite.sent`, `tenant.owner_invite.accepted`, `tenant.activated`, `tenant.suspended`, `tenant.reactivated`, `tenant.offboarding_started`, `tenant.closed`, `tenant.retention_scheduled`, `tenant.retention_executed`, `tenant.lifecycle_transition_rejected`.
- Structured payload (normative): `before` / `after` (status + is_active), `reason` (code + text), `context` (source, requestId/correlationId, ip, userAgent), `related` (membershipId, invitationId, transitionId; subscriptionId in the future commercial phase).
- Rejected transitions are logged, not just successful ones. Never log secrets, tokens, or payment details.

Snapshot columns answer "what is the current state"; append-only audit answers "how did we get here." Both are kept; they answer different questions.

### Platform authorization

New scope `platform:tenant:lifecycle:manage`, separate from `platform:tenant:provision` — provisioning power ≠ lifecycle power. Endpoint→scope mapping:

| Method | Endpoint | Scope |
|---|---|---|
| GET | `/platform/tenants` (list/search/filter by status, slug, owner, capability) | `platform:tenant:read` |
| GET | `/platform/tenants/:id` | `platform:tenant:read` |
| GET | `/platform/tenants/:id/audit` | `platform:tenant:read` |
| POST | `/platform/tenants` (provision + invite owner) | `platform:tenant:provision` |
| POST | `/platform/tenants/:id/resend-owner-invite` | `platform:tenant:provision` |
| POST | `/platform/tenants/:id/suspend` | `platform:tenant:lifecycle:manage` |
| POST | `/platform/tenants/:id/reactivate` | `platform:tenant:lifecycle:manage` |
| POST | `/platform/tenants/:id/start-offboarding` | `platform:tenant:lifecycle:manage` |
| POST | `/platform/tenants/:id/close` | `platform:tenant:lifecycle:manage` |

Provisioning motions: the one-call provision-and-invite remains the default; **create-now-invite-later** (provision without invite, send invite when customer readiness is confirmed) is supported as a provider-console action for the sales-assisted/enterprise motion, which is Aramo's primary near-term motion. Finer-grained platform roles (`finance_admin`, `support_admin`, `security_admin`, `read_only_auditor`) are a future seed-only addition on the existing role/scope substrate; `super_admin` suffices while the platform team is one person.

### Host architecture and routing

| Host | Role | TLS/routing |
|---|---|---|
| `admin.aramo.ai` | Platform console | **Dedicated Caddy site block, ordinary TLS — never behind the wildcard `ask` path** |
| `<tenant>.aramo.ai` | Tenant workspaces | Wildcard site + on-demand TLS `ask` endpoint, tenant hosts only |
| `aramo.ai` / `www` | Public commercial front door | **Future phase** — sales-assisted onboarding remains primary; no public checkout in the current phase |

**Reserved slugs (enforced in `deriveSlugOrThrow` before any public provisioning):** `admin`, `www`, `api`, `auth`, `app`, `platform`, `support`, `status`, `mail`, `docs`, `assets`. The `ask` endpoint rejects reserved and unknown slugs.

**Cert-eligibility (v1.1 erratum, R11):** `/v1/tenants/cert-eligible` (`findActiveBySlug`) remains satisfied for `SUSPENDED` (a suspended tenant's UX must still render over TLS) and refuses `CLOSED`; the `is_active` predicate is retained alongside `status` during migration (ADD-not-rename).

### Session and auth posture

- Rename the access cookie to `__Host-aramo_access_token` (attributes already qualify: Secure, Path=/, no Domain). Refresh and PKCE cookies stay path-limited to `/auth` and intentionally not `__Host-`.
- Cookies remain host-only, so `admin.aramo.ai` and tenant hosts are naturally session-isolated.
- Regenerate session identifiers on privilege change (initial auth, admin elevation, future impersonation/support sessions).
- `redirect_uri` is derived per consumer from `AUTH_PUBLIC_BASE_URL`; multi-host production (tenant hosts + admin host) requires host-derived base resolution — production-gating for the platform console's release, tracked separately.

### Platform console application (`apps/platform-web`)

Separate frontend app, tagged `scope:platform` (CI-enforced: no tenant business-module imports), talking only to the platform backend. Design system and primitives reused from tenant apps (shared libs only), with a distinct platform accent and explicit PLATFORM marker so an operator with both consoles open never confuses power levels.

Initial screens: login (platform-only) · tenant list (search/filter/status/slug/owner state/capability summary) · tenant detail (lifecycle, owner, entitlements, audit timeline, host/domain facts) · provision flow (plan-selection placeholder only) · lifecycle action dialogs (suspend/reactivate/offboard/close, reason-coded, confirmation-gated) · audit view. A SaaS-owner dashboard (onboarding funnel, operational health) follows once lifecycle data exists to display.

### Tenant console (`ats-web`) alignment — deliberately small

Not a redesign: typed `TENANT_SUSPENDED` handling at login with an explicit lifecycle message; a lifecycle banner for `OFFBOARDING`/notice states; read-only UX and operator-contact affordance where applicable; continued entitlement-backed capability checks; no platform scopes or dead-end platform links ever exposed in tenant UI.

---

## Part IV — Commercial Control Plane (future phase — NOT part of the current increment roadmap)

**Gating decisions that must precede any build in this part:** business pricing model, billing-provider selection (Stripe vs Chargebee vs invoice-manual), and commercial model approval. Nothing below is authorized for implementation until those are ruled.

### Three-layer entitlement architecture (the durable core idea)

1. **Catalog layer** — `Plan` / `PlanCapability` / `PlanLimit` define what an offer includes.
2. **Materialization layer** — `TenantEntitlement` (existing) becomes the effective current access set, extended with provenance: `granted_source: MANUAL | PLAN | PROMOTION | MIGRATION`, `granted_at`, `revoked_at`, `expires_at`. Answers "is this capability from the plan, a sales concession, or a promotion?"
3. **Runtime layer** — the existing `EntitlementGuard` continues to enforce, unchanged.

The current boolean capability substrate is therefore an asset, not debt: plans project into it; the guard never learns about billing. This keeps Aramo billing-provider-neutral.

### Commercial objects (target shape)

`BillingAccount` (tenant↔provider customer) · `Plan` (versioned, FLAT/HYBRID/USAGE) · `PlanCapability` · `PlanLimit` (included/soft/hard quantities, overage pricing) · `Subscription` (provider-mirrored status, period dates, cancel-at-period-end) · `SubscriptionItem` · `UsageRollupDaily`. Provider-specific code lives in adapters (`BillingWebhookService`, `UsageSyncService`, catalog/subscription mapping) — never in the core domain services.

### Metering prerequisite

`UsageEvent` is telemetry today (write-only). No usage-based pricing until: a metric registry mapping event types to business metrics; a watermark-based daily rollup worker; period aggregation for invoice windows; a platform dashboard read API; and only then a provider sync adapter. Rollups stay read-only until totals reconcile to raw events.

### Migration strategy (when authorized)

Phase A: commercial schema lands with zero runtime change (legacy default plan + one MANUAL subscription per tenant backfilled). Phase B: plan→entitlement projection with `granted_source='PLAN'`, manual grants intact. Phase C: plan/subscription surfaces in the platform console, overrides retained. Phase D: metered/usage-rated items, only after rollups are proven. No big-bang cutover; the entitlement guard never breaks.

---

## Part V — Delivery governance

- The **Operational Control Plane** items in Part III map to the platform-console track's increments, each governed by its own recon + LOCKED directive under the program's PR-based discipline. The current increment covers: lifecycle schema + transition service + action endpoints + activation hook + audit widening + reserved slugs + `platform:tenant:lifecycle:manage`, followed by the `platform-web` frontend.
- The **Commercial Control Plane** (Part IV) opens as its own charter lane only after its gating PO decisions, with its own instruments and directives.
- Standing engineering rules apply to everything here: recon-before-authoring; ADD-not-rename for overloaded columns; new Prisma schemas append to both `prisma:generate` and `prisma:validate` chains; new cross-lib dependencies get 3-place wiring; boundary tags on every new project; counsel-gated items (retention policy, data disposition) never ship ahead of counsel.

---

*End of document. Changes to this architecture are made by superseding version, adjudicated by Lead/Architect and adopted by PO, consistent with the program's ADR discipline.*
