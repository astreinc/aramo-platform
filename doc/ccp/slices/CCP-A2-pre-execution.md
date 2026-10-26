# CCP-A2 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A2: commercial audit + CommercialPolicyVersion v1 |
| **Schedule** | Program Build Directive §5, row A2 |
| **Baseline** | `feat/ccp-commercial-control-plane` at `f1527e76` (CCP-A1 complete, 10 local commits on `origin/main` `78dbd6d3`). `origin/main` re-fetched: `78dbd6d3`. |

## Prerequisites
| Prerequisite | Evidence | Status |
|---|---|---|
| A1 evidence recorded | `doc/ccp/slices/CCP-A1-acceptance.md` (commit `6b024ac3`) | ✅ |
| Charter §7 values (D5) | Policy v1: discount escalation 20%; credit escalation $500 (USD); support extension 14 days; once per 90 days; 30 days cumulative; approval expiry 72 h; past-due grace 7 days | ✅ |
| **Boundary semantics (Charter §14 item 2)** | **Confirmed by the PO on 2026-10-24** (see below) | ✅ |

## Boundary semantics (PO-confirmed 2026-10-24)
| Rule | Semantics |
|---|---|
| Discount escalation | A discount **≥ 20%** escalates to the owner (inclusive). 19.99% does not. |
| Credit escalation | A credit **≥ $500.00** (USD minor units ≥ 50000) escalates to the owner (inclusive). |
| Support extension length | An extension of **≤ 14 days** is within limit. 15 days or more escalates. |
| Extension frequency | **Rolling 90 days:** within limit only if no in-limit extension was applied to the same tenant × product in the 90 days before now. |
| Cumulative cap | **Rolling 12 months:** in-limit extensions for a tenant × product total **≤ 30 days** in any rolling 365-day window. An extension that would exceed the cap escalates. |
| Approval expiry | A request expires **72 h** after it is submitted. At exactly 72 h it is expired. |
| Past-due grace | **7 days**, and it remains a policy value (today the code reads it from env `BILLING_PAST_DUE_GRACE_DAYS`, default 7). |

All values are **policy data** in CommercialPolicyVersion v1, not code constants.

## Correction-1 trigger check (PBD §2.4)
None has arisen. No separate LOCKED directive is required.

## Path:line re-verification (recorded by the slice executor before the first commit)
Re-verified 2026-10-24 on `feat/ccp-commercial-control-plane` at `744a6040` (clean tree; no drift from `f1527e76` other than the docs-only CCP-UI record `8b2fc883` and the repo-map regeneration `744a6040`).

**P-6.1 The `subscription` schema and its nx position**
| Fact | `path:line` | Verified |
|---|---|---|
| Single-schema Prisma datasource `schemas = ["subscription"]` | `libs/subscription/prisma/schema.prisma:27` | ✅ |
| `libs/subscription` is `scope:shared` | `libs/subscription/project.json:6` | ✅ |
| `scope:shared` may depend only on `scope:shared` | `eslint.config.mjs:109` | ✅ (the line the Charter row 20 cites) |
| ADR-0024 store is `scope:boundary` (not importable from `scope:shared`, D10) | `libs/policy-store/project.json:6` | ✅ |
| `MatchingPolicyVersion` lives in a `scope:cip` lib (pattern is cloned, never imported) | `libs/skills-taxonomy/project.json:6` | ✅ |
| `scope:platform` may depend on `scope:shared` | `eslint.config.mjs:90` | ✅ |
| platform-admin already imports `@aramo/subscription` (no new cross-lib edge) | `apps/platform-admin/src/app/platform/platform.module.ts:13`, `:51`; 3-place wiring present: `tsconfig.base.json:82`, `vitest.shared.ts:159`, `apps/platform-admin/tsconfig.app.json:18` | ✅ |

**P-6.2 Existing subscription migrations (8) and where they are registered**
`20261018120000_init_subscription_allowance`, `20261019100000_subscription_lifecycle_billing`, `20261019140000_sign_commercial_catalog_a1`, `20261020130300_sign_naming_keys`, `20261022100100_billing_account_country_guard`, `20261022110100_billing_flag_domain_reason`, `20261023100000_sign_personal_free`, `20261023120000_legal_acceptance_in_app`. The latest migration in any lib is `20261024170000` (talent-record), so A2 takes `20261024180000`.

| Consumer | How it lists subscription migrations | A2 action |
|---|---|---|
| `pact/provider/src/verify-sign.ts:50-56` (`migrationsOf`), `:595` | directory glob, every subscription migration in order | none: the new migration is picked up automatically |
| `pact/provider/src/verify-api.ts` | lists **no** subscription migration (0 matches for `subscription`) | none: the API provider never reads the subscription schema, and A2 changes no returned shape of an existing route |
| `tools/db-sync-local.sh:58`, `deploy/migrate-prod.sh:25` | glob over `libs/*/prisma/migrations`, timestamp order | none (production execution is not authorized, PBD §7.5) |
| `libs/subscription/src/tests/*.integration.spec.ts` (5 specs) and `apps/platform-admin/src/tests/{sign,personal}-signup.integration.spec.ts:59-62`, `:79-82` | explicit per-spec lists | none: A2 only adds new tables; no existing spec reads them. The new A2 integration spec lists the full chain plus the A2 migration |
| `libs/common/src/lib/testing/*-migrations.ts` | no subscription list exists | none |

**P-6.3 The MatchingPolicyVersion files cloned**
| Element | `path:line` |
|---|---|
| Version table, status CHECK, `version_number >= 1`, JSON object CHECK | `libs/skills-taxonomy/prisma/migrations/20261023140000_matching_policy/migration.sql:26-42` |
| Unique `version_number`; one-ACTIVE partial unique index | same file `:45`, `:48` |
| Append-only audit table + event-type CHECK | same file `:51-62` |
| Content guard trigger (DELETE rejected; content columns immutable; NULL-safe `IS DISTINCT FROM`) | same file `:70-96` |
| Audit UPDATE/DELETE rejected unconditionally | same file `:98-113` |
| v1 ACTIVE seed with fixed ids, `ON CONFLICT DO NOTHING`, plus seed audit row | same file `:117-143` |
| Advisory-lock key and version numbering under the lock | `libs/skills-taxonomy/src/lib/matching-policy.repository.ts:50`, `:78-112` |
| One-ACTIVE swap in one transaction (A3 reuses this for activation) | same file `:118-158` |
| Prisma models | `libs/skills-taxonomy/prisma/schema.prisma:242-283` |
| Seed-equals-source proof precedent | `apps/api/src/tests/matching-policy-seed.spec.ts:31-43` |

Divergence from the clone, by the A2 row: the CCP version also carries `content_checksum`, and the content is immutable **once the row leaves DRAFT** (the A2 row says "DB-immutable once ACTIVE"; the Matching guard freezes content from insert). DELETE is rejected in every state, as in the clone.

**P-6.4 platform-admin controller patterns**
| Pattern | `path:line` |
|---|---|
| Class-level `@UseGuards(JwtAuthGuard, RolesGuard)` | `apps/platform-admin/src/app/platform/platform-sign.controller.ts:18`; `platform.controller.ts:73` |
| Per-route `@RequireScopes('platform:…')` | `platform-sign.controller.ts:27` |
| Tier check: `consumer_type !== 'platform'` → `AramoError('INSUFFICIENT_PERMISSIONS', …, 403, { details: { reason: 'tier_mismatch' } })` | `platform-sign.controller.ts:29-34`; `platform.controller.ts:522-545` |
| Global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` | `apps/platform-admin/src/main.ts:24-30` |
| Opaque, versioned, filter-pinned keyset cursor precedent | `apps/api/src/skill-governance/skill-review-queue.service.ts:55-107` |
| Controller manifest classification (`AP`) | `ci/config/api-surface-manifest.json:106-110` |
| OpenAPI `PlatformForbidden` response | `openapi/platform.yaml:3236-3244` |

**P-6.5 The scope and its holders**
| Fact | `path:line` |
|---|---|
| `platform:commercial:audit:read` in the DTO catalog | `libs/identity/src/lib/dto/scope.dto.ts:209`, `:576` |
| Holders: `platform_owner`, `finance_admin`, `read_only_auditor` (not `commercial_ops`, `catalog_manager`, `support_admin`, nor `super_admin`) | `libs/identity/prisma/seed.ts:3252`, `:3264`, `:3296` (bundles `:3240-3298`) |
| Orphan-scope reservation (ACTIVE_RESERVED, "enforced from CCP A2") | `ci/scripts/verify-orphan-scopes.ts:84` |

**P-6.6 Grace today (untouched by A2)**
`PAST_DUE_GRACE_DAYS_DEFAULT = 7` at `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:63`; env read `BILLING_PAST_DUE_GRACE_DAYS` at `:218-220`; `subscriptionSends` treats grace as half-open (`grace_until > at`) at `libs/subscription/src/lib/allowance.service.ts:70`. A2 records the grace value in policy v1 and adds a pure boundary helper with the same half-open edge; it does not re-point the lifecycle read (a later slice wires it, with the env-parity check, Charter §7).

**Result.** No contradiction between the instruments and the code. No HALT condition: the boundary semantics are PO-confirmed (above); nothing needs `@aramo/policy-store` or a new nx edge; all policy values go in migration data.
