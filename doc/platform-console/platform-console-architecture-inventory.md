# Aramo Platform — Repository Architecture Map & Gap Analysis

**Type:** Substrate recon (read-only inventory) · **Date:** 2026-07-08
**Branch:** `platform-console` (integration branch off `main@bdc8142`; HEAD `8832534`, CI green)
**Purpose:** Ground Increment-2 platform-console directives against the actual codebase — what tenant / auth / billing / domain architecture exists today, the confirmed gaps versus the target platform-console design, and the exact files each workstream touches.

Nx monorepo footprint: **4 apps · ~55 libs · 37 Prisma schemas / 107 migrations · Terraform IaC**.

> No billing system exists — `stripe/paddle/subscription/invoice` produce no models or integration (the two incidental hits are a word in `examination.repository.ts` and placeholder copy in the settings `SeamSections.tsx`). No SCIM / SAML / MFA / impersonation — auth is Cognito OIDC only (the SSO/MFA hits are e2e/test/placeholder + `doc/auth-mfa-recon.md`).

---

## 1. Repo map

```
aramo-platform/
├── apps/
│   ├── api/            NestJS — the TENANT backend (/v1/*). All ATS/CIP domain HTTP surface.
│   │                   main.ts · controllers/ · talent-identity/ · talent-anchor/
│   │                   └─ public-tenant-cert.controller.ts  ← GET /v1/tenants/cert-eligible (Caddy ask)
│   ├── auth-service/   NestJS — OIDC/session broker (/auth/:consumer/*). Cognito hosted-UI ↔ Aramo session.
│   │                   app/auth/{auth.controller, session-orchestrator, cognito-verifier, redirect-uri,
│   │                             jwt-issuer, pkce, refresh-orchestrator, cookie-verifier}.service.ts
│   ├── platform-admin/ NestJS — the PLATFORM/ADMIN backend (/platform/*). Tenant provisioning + platform-admin invites.
│   │                   app/platform/{platform.controller, platform-invitation.service, cognito/cognito-admin}
│   └── ats-web/        Vite/React SPA — the TENANT frontend (:4201). NO server; leaf HTTP consumer.
│                       src/{shell,settings,org,teams,users,requisitions,pipeline,submittals,talent,…}
│
├── libs/  (nx scope tags: shared · boundary · cip · ats · platform)
│   ├── identity/       ★ tenant + user + membership + role + scope + invitation + audit + slug. The spine.
│   ├── auth/           JwtAuthGuard, consumer types, PLATFORM_TENANT_SENTINEL_ID.
│   ├── authorization/  @RequireScopes + RolesGuard (scope-keyed authz).
│   ├── entitlement/    capability flags {core,ats,portal,sourcing} + EntitlementGuard.
│   ├── metering/       UsageEvent (write-only telemetry).
│   ├── auth-storage/   refresh-token store.  · mailer/ · audit/ · events/ · outbox-publisher/
│   ├── identity-index/ PII-free PERSON_CLUSTER cross-tenant index (I14 wall).
│   ├── talent-*/ , requisition/ , submittal/ , engagement/ , pipeline/ , examination/ … (ATS/CIP domains)
│   └── fe-foundation/  shared FE primitives (the only lib ats-web imports).
│
├── deploy/     caddy/Caddyfile (ingress + on-demand TLS) · systemd/singlebox-compose.sh · backup/
├── infrastructure/  Terraform: modules/{vpc,alb,ecs-*,rds,elasticache-redis,ecr,secrets-manager,iam,s3}
│                    · environments/{dev,staging,prod}
├── infrastructure-lightsail/   the current single-box target
├── docker-compose.{yml,prod.yml,images.yml}   local · singlebox-prod · image-overlay
├── openapi/ (common,ats,portal,ingestion,auth) · pact/ (consumers/ats-web + provider) · ci/
│    · .github/workflows/ci.yml
└── doc/  adr/ (0001–0020 + LOCKED) · runbooks/ · 00–08 conventions · *-recon.md
```

**Three deployables, three consumer types.** `api` (tenant, `/v1`), `auth-service` (`/auth`), `platform-admin` (`/platform`). The `consumer_type` axis is `{recruiter, portal, ingestion, platform}` (`libs/auth/src/lib/auth-context.types.ts:14`). Physical separation of platform vs tenant is the ADR-0016 boundary; enforced in code by the `scope:platform` nx wall (Increment-1) and `assertConsumerIsPlatform`.

---

## 2. Architecture as implemented today

### Tenant model & lifecycle
- `Tenant` (`libs/identity/prisma/schema.prisma:44`): `id, name, is_active:Boolean, slug?@unique, allowed_domain?, identity_provider?, domain_verification_status:String="UNVERIFIED", + profile fields`. **No `status`/lifecycle column** — `is_active` boolean is the only lever.
- **Provisioning is fully synchronous** — `PlatformInvitationService.provisionTenantAndInviteOwner` (`apps/platform-admin/src/app/platform/platform-invitation.service.ts:77`): Cognito `adminCreateUser` → identity tx (Tenant + owner user + membership, `tenant_owner` role) → `EntitlementRepository.grantCapabilities({core,ats,portal})` → soft-disable (`is_active=false`) on entitlement failure. No queue/saga.
- **Membership lifecycle**: `invite_status ∈ {INVITED, ACCEPTED, ACTIVE}` (String guard, not enum; `schema.prisma:187`). INVITED→ACCEPTED at `acceptInvitationByToken` (emits `identity.invitation.accepted`); ACCEPTED→ACTIVE at first login (`activateAcceptedMembershipsOnSession`, silent, no owner distinction).

### Auth / RBAC / SSO
- **Cognito hosted-UI OIDC** brokered by auth-service. PKCE + encrypted state cookie; per-consumer `redirect_uri` derivation (`AUTH_PUBLIC_BASE_URL`, Increment-1 D). Reconcile-by-verified-email links the federated sub to a pre-provisioned user (no open JIT); D2 no-op link guard (account-takeover-safe).
- **Scope-keyed RBAC** — `@RequireScopes` → `RolesGuard` reads JWT scopes (`libs/authorization/src/lib/roles.guard.ts`). Roles are pure seed data → scope bundles. Tenant catalog: 12 roles / ~88 scopes. **Platform catalog: exactly `super_admin` + `{platform:tenant:provision, platform:tenant:read, platform:admin:invite}`**.
- **No SCIM, no SAML, no MFA** (MFA is a recon doc only: `doc/auth-mfa-recon.md`). **No impersonation / break-glass.**
- JwtAuthGuard: Bearer-first, `aramo_access_token` cookie fallback (`libs/auth/src/lib/jwt-auth.guard.ts:142`). Cookies: access `Secure(prod)/Lax/Path=/`, refresh `Strict/Path=/auth`, pkce `Lax/Path=/auth` — all host-only (no Domain).

### Domains / routing
- **Single Caddy `*.aramo.ai` wildcard** (`deploy/caddy/Caddyfile:14-63`) with `on_demand_tls` gated by `GET /v1/tenants/cert-eligible?domain=<host>` — a host gets a cert **only if its slug resolves to a tenant**. `astre.aramo.ai` flows through this (slug `astre`). HRD: `identity_provider` per tenant pins the Cognito IdP at login.
- Slug rules: `deriveSlugOrThrow` — trim/lowercase, `/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/`, ≤63 chars (`libs/identity/src/lib/util/tenant-slug.ts:47`). **No reserved-slug list** — `admin`/`www`/`api` are claimable.
- FE is same-origin: `ats-web` vite proxies `/auth`→3001, `/v1`→3000, `/platform`→3002 (dev). No `admin.aramo.ai` host exists.

### Billing — ABSENT
- `entitlement` = **boolean capability flags**, not tiered plans/limits. `metering.UsageEvent` = **write-only** (submittal/pipeline/activity/engagement write; nothing reads/rates/invoices). **No plan/product/subscription/invoice model, no Stripe/Paddle, no webhooks.**

### Audit
- Append-only `IdentityAuditEvent` (`actor_id?, actor_type, event_type, subject_id, event_payload:Json`) + `IdentityAuditService.writeEvent/writeGlobalEvent` (`libs/identity/src/lib/audit/identity-audit.service.ts:24`). Generic, keyset-paginated. Constraints: `actor_type` hardcoded `'user'` (system events use raw Prisma); `event_type` a closed alias; reason/before-after are payload conventions, not columns.

### Infra / CI/CD
- Terraform (ADR-0012/0016): VPC, ALB, ECS, **RDS Postgres 15.x**, ElastiCache, ECR, Secrets Manager. Current prod target = **single-box** (`docker-compose.prod.yml`, `postgres:17`, systemd launcher). CI (`.github/workflows/ci.yml`): full gate on push to `[main, platform-console]`; GHCR publish ref-gated to `main`.

---

## 3. Confirmed gaps vs a platform-console target

| Capability | Status | Note |
|---|---|---|
| Tenant lifecycle state machine | **ABSENT** | only `is_active` bool; no PROVISIONED/ACTIVE/SUSPENDED/CLOSED |
| Public self-signup + first-admin | **ABSENT** | provisioning is platform-admin-only (`platform:tenant:provision`); no public signup surface |
| `admin.aramo.ai` host | **ABSENT** | no non-tenant host; platform-admin only reachable via dev proxy |
| Billing / plans / subscriptions / invoices / webhooks | **ABSENT** | greenfield; entitlements are booleans, metering unread |
| SCIM / SAML / directory sync | **ABSENT** | Cognito OIDC only |
| Impersonation / support break-glass | **ABSENT** | no read-only or assume-session tooling |
| Reserved-slug guard | **ABSENT** | tenant can claim `admin` and collide with a future admin host |
| Async provisioning pipeline | **ABSENT** | synchronous; BullMQ exists elsewhere but not wired here |
| `{tenant}.aramo.ai` routing | **PARTIAL** | wildcard + on-demand TLS works; no per-tenant app-shell host binding beyond HRD |
| Entitlement enforcement | **PRESENT** | `EntitlementGuard` live |
| Audit ledger | **PRESENT** | generic emit, needs `actor_type` widening + reason/diff convention |

---

## 4. Exact files to modify (per workstream)

### Tenant lifecycle (add `Tenant.status` + transitions)
- `libs/identity/prisma/schema.prisma` (Tenant — add `status` + migration under `libs/identity/prisma/migrations/`)
- `libs/identity/src/lib/tenant.service.ts` + `tenant.repository.ts` + `dto/tenant.dto.ts` (transitions, guards)
- hook point: `libs/identity/src/lib/identity.service.ts` (`acceptInvitationByToken` — add `tenant_owner`-role branch to fire PROVISIONED→ACTIVE) + `identity.repository.ts` (`activateAcceptedMembershipsForUser`)
- `apps/platform-admin/src/app/platform/platform.controller.ts` (suspend/reactivate endpoints + scopes) + `libs/identity/prisma/seed.ts` (new `platform:tenant:*` scopes)
- ⚠️ curated migration lists: `pact/provider/src/verify-api.ts` + per-lib integration spec apply-lists (regenerated client SELECTs the new column).

### Public signup + first-admin invite
- New public controller in `apps/api/src/controllers/` (or a new `apps/platform-admin` public route) — mirrors `public-tenant-cert.controller.ts` (unauthenticated) pattern
- `apps/platform-admin/src/app/platform/platform-invitation.service.ts` (extract a `selfServeProvision` path from `provisionTenantAndInviteOwner`)
- `libs/identity/src/lib/util/tenant-slug.ts` (+ **reserved-slug list**) · `libs/mailer/` (verification email) · `openapi/` (new spec) · `pact/consumers/`
- ⚠️ current provision requires an authenticated `platform` caller (`assertConsumerIsPlatform`) — public signup must bypass that without weakening the platform routes.

### `admin.aramo.ai` (non-tenant host)
- `deploy/caddy/Caddyfile` (dedicated `admin.aramo.ai { tls …; reverse_proxy platform-admin:3002 }` block, NOT on-demand)
- `libs/identity/src/lib/util/tenant-slug.ts` (reserve `admin`) · `docker-compose.prod.yml` (expose platform-admin behind Caddy) · `infrastructure/` (DNS/cert if not wildcard-covered)

### `{tenant}.aramo.ai` (already largely works)
- `deploy/caddy/Caddyfile` (wildcard + ask — no change) · `apps/api/src/controllers/public-tenant-cert.controller.ts` (eligibility) · `apps/auth-service/src/app/auth/auth.controller.ts` (`resolveIdentityProvider` HRD) — extend only if per-tenant FE shell binding is wanted.

### Billing integration (greenfield)
- New `libs/billing/` (schema: Plan/Subscription/Invoice + provider webhooks) · a metering **reader/rollup** over `libs/metering/UsageEvent` · `apps/platform-admin` or `apps/api` webhook controller · `libs/entitlement` (bridge plan→capabilities) · `infrastructure/modules/secrets-manager` (provider keys).

### Audit logging (extend existing)
- `libs/identity/src/lib/audit/identity-audit.service.ts` (widen `actor_type` beyond `'user'`; add reason/before-after payload convention) · the `EventType` alias · call sites in `tenant.service.ts` / `platform-invitation.service.ts` for lifecycle events. (Or the standalone `libs/audit/` + `libs/events/` + `libs/outbox-publisher/` if a cross-domain event bus is preferred.)

---

## 5. Risky assumptions & hidden coupling

1. **Curated migration lists** — adding any column means the regenerated Prisma client SELECTs it, and CI 500s unless the migration is added to `pact/provider/src/verify-api.ts` AND each per-lib integration spec's hardcoded apply-list. This bites every schema change.
2. **`AUTH_COGNITO_REDIRECT_URI` deprecation fallback** — still read across compose files, tfvars, 5 specs, the pact verifier; canonical is now `AUTH_PUBLIC_BASE_URL`. Removing it ripples widely.
3. **`assertConsumerIsPlatform` + scope-namespace partition** is the *only* thing separating platform from tenant tokens — public signup / any new unauthenticated provisioning path must not erode it. Entitlement-at-mint is still **[LB] open** (consumer_type is URL-derived).
4. **No reserved-slug guard** — a tenant can claim `admin`/`www`; must land *before* `admin.aramo.ai`.
5. **`identity` stays LEAF** via port injection (it documents *not* importing `@aramo/settings`; `apps/api` threads it). New identity deps must follow the port pattern or they break the `scope` boundary lint.
6. **Each Prisma module = its own PG schema** (`identity."User"`, 31 schemas) — cross-module joins don't exist; the identity-index PERSON_CLUSTER is the only cross-tenant bridge (I14: no tenant_id/PII).
7. **`aramo_access_token` cookie is `__Host-`-ready** (Secure+Path=/+no Domain) but refresh/pkce use `Path=/auth` — a `__Host-` adoption is access-only unless their path is broadened.
8. **Postgres version drift** (R8): prod single-box `17` vs RDS Terraform `15.x` vs local `aramo-pg 16` — unify before any migration relying on version-specific behavior.

---

## 6. Docs & diagrams referenced

No rendered architecture diagrams (`.drawio`/`.png`/`.mmd`) exist in-repo. The authoritative design/decision docs:

- **`doc/adr/0016-rds-substrate-conventions.md`** + `doc/adr/Aramo-ADR-0016-…-LOCKED.md` — platform/tenant physical separation, Postgres 15.x.
- **`doc/adr/0017-…`** (I15 CIP⊥ATS wall) · **`doc/adr/0018-background-jobs-substrate.md`** · **`doc/adr/0020-build-for-tenant-50-governing-principle.md`** (multi-tenant, not Astre-specific).
- **`doc/runbooks/{run-layer,local-run,singlebox-ops}.md`** — the containerized runtime + one-command local stack.
- **`doc/step4-singlebox-runnable-prod-stack.md`** · **`doc/step4-deploy-substrate-recon.md`** — prod deploy shape.
- **`doc/auth-{reconcile-spine,mfa,local-mock-idp}-recon.md`** — auth substrate + explicit MFA gap.

---

## 7. Architecture (from actual code)

```
                         Internet
                            │
                 ┌──────────▼───────────┐
                 │  Caddy  *.aramo.ai    │  on_demand_tls
                 │  (deploy/caddy)       │  ask → /v1/tenants/cert-eligible
                 └───┬───────────┬───────┘   (slug must resolve to a Tenant)
         /auth/*     │   /v1/*   │            [ admin.aramo.ai → ABSENT ]
        ┌────────────▼──┐   ┌────▼─────────┐   ┌──────────────────────┐
        │ auth-service  │   │     api      │   │   platform-admin     │
        │  :3001 OIDC   │   │  :3000 /v1   │   │  :3002 /platform     │
        │  Cognito ↔    │   │  ATS/CIP     │   │  provision+invite    │
        │  session      │   │  domains     │   │  (super_admin only)  │
        └──────┬────────┘   └──────┬───────┘   └──────────┬───────────┘
               │  scopes/roles     │ RequireScopes+       │ assertConsumerIsPlatform
               │  reconcile        │ EntitlementGuard     │ + scope:platform wall
               └──────────┬────────┴──────────────────────┘
                          ▼
        libs/identity  (Tenant · User · Membership · Role · Scope ·
                        Invitation · IdentityAuditEvent · slug)
        libs/entitlement (capability flags)   libs/metering (UsageEvent, write-only)
        Postgres — 31 per-module schemas       [ billing/plans → ABSENT ]

  ats-web (React SPA, :4201) — leaf HTTP consumer, same-origin proxy → api/auth/platform
```
