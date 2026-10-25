# CCP-A7 — pre-execution check (entitlement revoke + provenance + resurrection guard)

| | |
|---|---|
| **Slice** | CCP-A7: D1 revoke (`revoked_at` + `TenantEntitlementEvent`), additive `granted_source` provenance, resurrection guard |
| **Schedule** | `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §5.1 row A7 (binding), §2, §6, §7 |
| **Baseline** | worktree `wip/ccp-a7` at program HEAD `078d4f78` (A1–A6, A9, A10 merged). Parallel slices: B1, B2, B5, D1, A8, C1, B4. |
| **Recorded** | 2026-10-25, before any A7 change |

## 1. Prerequisites

| Prerequisite (row A7) | Evidence | Status |
|---|---|---|
| A6 evidence | `doc/ccp/slices/CCP-A6-acceptance.md` (TD-A6-7: the ledger is A7's; TD-A6-8: `SUBSCRIPTION_END` does not revoke) | ✅ |
| Charter D1 | `Aramo-CCP-Program-Charter-v1_0-LOCKED.md:138`: "`revoked_at` on the entitlement row, plus a `TenantEntitlementEvent` ledger (ADD-only). Follow-ons: `skipDuplicates` becomes an upsert, 2 readers are re-pointed, the Intelligence sync changes … The migration SHALL be registered in `pact/provider/src/verify-api.ts`. Seed-prod and reconcile SHALL NOT bring back a governed revoke (G4)." | ✅ |
| Conv. C-20 | `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md:185-189`: the signup grant is not commercial; provenance records "a non-commercial source, such as signup provisioning"; reconciliation SHALL NOT treat it as payment evidence and SHALL NOT revoke it because no subscription exists | ✅ |
| Provenance set may be extended additively | `Aramo-Platform-Console-Enterprise-Architecture-Successor-Record-v1_2-CCP-H1-LOCKED.md:98` ("MAY be extended **additively**, for example with `PROVISIONING` … The exact values SHALL be fixed in the CCP-A7 pre-execution record … No existing value SHALL be renamed"), `:109`; `Aramo-Authorization-Model-DDR-Amendment-v1_2-CCP-Commercial-Authority-LOCKED.md:199` (open issue 4) | ✅ |
| Chain for a governed revoke | `doc/ccp/decisions.md:20` TD-A3-2: "product grant and revoke … use the **Finance-only** chain" (already resolved by `resolveRequiredChain`, default branch) | ✅ |
| `ENTITLEMENT_REVOKE` in the closed action set | `libs/subscription/src/lib/commercial/commercial-change-request.ts:32` ("A7 — governed revoke (D1)"), `:78`; DB CHECK `20261025120000_ccp_a3_change_request_approval/migration.sql:87` | ✅ |

## 2. The `granted_source` value list (fixed here, per the Successor Record `:98`)

`entitlement."TenantEntitlement"` has **no** `granted_source` column at baseline (`libs/entitlement/prisma/schema.prisma:51-66`: `tenant_id`, `capability`, `granted_at` only). So no stored value can be renamed. The existing **named** set is the Part IV enumeration (`Aramo-Platform-Console-Enterprise-Architecture.md:196`, mirrored at `doc/architecture/aramo-platform-console-enterprise-architecture.md:198`). The spelling `MIGRATION` is also already used in the A9 bootstrap audit payload (`libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts:159`), and is kept exactly.

| Value | Origin | Commercial? | Written by (after A7) |
|---|---|---|---|
| `MANUAL` | Part IV `:196` (kept) | yes | the governed `ENTITLEMENT_GRANT` apply (A6 path), with `change_request_id` |
| `PLAN` | Part IV `:196` (kept) | yes | the governed `SUBSCRIPTION_OPEN` / `SUBSCRIPTION_CHANGE` apply (the plan's product bundle), with `change_request_id` |
| `PROMOTION` | Part IV `:196` (kept) | yes | no writer in A7 (reserved; needs a governed path) |
| `MIGRATION` | Part IV `:196` (kept) | no | the A7 backfill of every pre-A7 row (provenance unknown), and the DB default for an out-of-band raw write |
| **`PROVISIONING`** | **added** (D4, Successor Record `:98`) | no | the platform provisioning saga (`platform-invitation.service.ts:403`) and the seed reconcile (`seed-entitlements.ts`, seed-prod STAGE D) |
| **`SIGNUP`** | **added** (Conv. C-20 "signup provisioning") | no | the self-service signup grants (`sign-signup.service.ts:390`; `personal-signup.service.ts:490`, `:549`, `:580`) |

Commercial = `PLAN`, `MANUAL`, `PROMOTION` (DB CHECK: exactly these carry a `change_request_id`). No value is renamed (row A7 HALT condition: not triggered).

## 3. Reader and writer recon (`path:line`, at `078d4f78`)

**Repository-level readers of the entitlement store (the "2 readers"): exactly 2.**

| # | Reader | Fan-out | Re-point |
|---|---|---|---|
| R1 | `libs/entitlement/src/lib/entitlement.repository.ts:26` `getCapabilities` (findMany by tenant) | `EntitlementGuard` `entitlement.guard.ts:74`; `TenantEntitlementReader` `libs/identity/src/lib/tenant-entitlement-reader.service.ts:16` → mint/refresh gate `apps/auth-service/src/app/auth/identity-principal-directory.adapter.ts:92`, resolver `libs/identity/src/lib/authorization/identity-effective-authorization-resolver.ts:128`, `product-availability.service.ts:111`, `role-catalog.service.ts:56`, `identity.service.ts:585`, `apps/sign-service/src/app/integrations/sign-api.guard.ts:61`, `sign-token.service.ts:318`, `:328`; Intelligence publisher `intelligence-publisher.handler.ts:87`, inbound `intelligence-inbound-sync.service.ts:102`, verification `intelligence-verification.service.ts:59` | add `revoked_at: null` (same lib, no nx edge, no caller change): **mechanical** |
| R2 | `libs/entitlement/src/lib/entitlement.repository.ts:42` `listTenantIdsWithCapability` | the Intelligence full REPLACE sync `intelligence-entitlement-sync.service.ts:53` | add `revoked_at: null`: **mechanical**. This IS the "Intelligence sync" change: a revoked tenant leaves the REPLACE payload and TI deactivates it; the publisher's R1 gate (`:87`) stops the per-ingest UPSERT |

Both re-points are in the owning lib, cross no nx edge, and are not coupled to another grounded directive (the IC-2 PR-6 refresh/mint contract at `identity-principal-directory.adapter.ts:76-81` already says "a removed entitlement cannot be resurrected by refresh"). They stay in the mechanical bucket.

**Raw-SQL readers outside the repository (not part of the "2"; recorded as TD-A7-1):**

| Reader | Treatment |
|---|---|
| `deploy/seed-prod.sh:237` Gate 3 count | re-pointed to active rows (`AND revoked_at IS NULL`); part of the "resurrection guard in seed-prod" |
| `libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/migration.sql:217` APPLIED backstop | A6 migration is immutable; the new A7 guard migration keeps the A6 body verbatim and **adds** an active-row check block (TD-A7-2) |
| `libs/subscription/src/tests/support/ccp-a6.ts:134` snapshot oracle | test-only; unchanged (A6 snapshots never contain a revoke) |

**Writers:** `entitlement.repository.ts:55-61` (`createMany … skipDuplicates: true`, the "skipDuplicates → upsert" site), `grant-capabilities-in-tx.ts:36-39` (`ON CONFLICT DO NOTHING`), and 83 raw `INSERT` fixture sites in tests/pact/tools (`git grep -n 'INSERT INTO "?entitlement"?\.\\?"TenantEntitlement'`).

**Resurrection paths at baseline (each closed by A7):**
1. `seed-prod.sh:288` STAGE D → `reconcileTenantEntitlements` (`reconcile-entitlements.ts:76-83`) grants every capability `getCapabilities` does not return. After R1, a revoked capability would read as "missing" and be re-granted → the upsert never clears a revoke without a change request (SQL + DB trigger).
2. Signup resumption (`personal-signup.service.ts:490`, `:580`) re-grants on an existing tenant → same guard.
3. Provisioning saga (`platform-invitation.service.ts:403`) → same guard.
4. A raw `DELETE` of a revoked row followed by any re-insert → DB trigger refuses deleting a revoked row.

## 4. Choices this record fixes

| # | Choice | Decision | Confirmation needed |
|---|---|---|---|
| C-1 | Revoke representation | `revoked_at`, `revoked_by`, `revoke_change_request_id` on the row (ADD); the row is kept; grant provenance `granted_source`, `granted_by`, `change_request_id` (ADD) | no (D1 / Recon §1 `:95`) |
| C-2 | Who may revoke | only a governed `ENTITLEMENT_REVOKE` apply (Finance-only chain, TD-A3-2). DB CHECK: a revoked row carries `revoke_change_request_id` | no |
| C-3 | What may be revoked | the product bundle minus `core`: for `sign`, `['sign']` (`PRODUCT_CAPABILITIES` `product-registry.ts:86`). `core` is the shared, non-commercial default capability (D4, C-20 owner reaches billing) → refused `CAPABILITY_NOT_REVOCABLE` | no (narrowest reading) |
| C-4 | Re-grant | only governed (a change request): `ENTITLEMENT_GRANT` (→ `MANUAL`) or `SUBSCRIPTION_OPEN`/`_CHANGE` (→ `PLAN`) clears `revoked_*` and re-stamps provenance. An already-active row is never re-stamped | no |
| C-5 | Ungoverned grants on a revoked row | refused silently at SQL (`ON CONFLICT … DO UPDATE … WHERE revoked AND change_request_id IS NOT NULL`), backed by a BEFORE UPDATE trigger; the repository records a `RESURRECTION_REFUSED` ledger event | no |
| C-6 | Ledger | `entitlement."TenantEntitlementEvent"`, append-only, written by an AFTER trigger on `TenantEntitlement` (every writer, including raw SQL) plus the app-written `RESURRECTION_REFUSED` | no |
| C-7 | `SUBSCRIPTION_END` | unchanged: it does **not** auto-revoke (C-20; A6 comment `commercial-apply.service.ts:446-447`). A governed end that must also remove access is followed by an `ENTITLEMENT_REVOKE` | flagged for the lead (TD-A7-5) |
| C-8 | Guard function | new migration `20261026000100_ccp_a7_entitlement_revoke_apply` keeps the `20261025200000` body verbatim and adds only the A7 branch (`ENTITLEMENT_REVOKE`: the A6 apply transitions and rules, its APPLIED backstop) + the active-row backstop block; mirrored in `canTransitionFor`; A9-U-4 updated | no (lead instruction) |
| C-9 | Application record | `CommercialChangeApplication.capabilities_revoked TEXT[]` ADDED (no overload of `capabilities`; CLAUDE.md ADD-not-rename) | no |

## 5. Correction-1 trigger check (§2.4)

None. No architectural change beyond the D1 design, no new commercial decision (C-3 and C-7 take the narrowest reading of the LOCKED text), no contract amendment. No existing `granted_source` value is renamed; no resurrection path is introduced.

## 6. Migration timestamps

`libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance` and `libs/subscription/prisma/migrations/20261026000100_ccp_a7_entitlement_revoke_apply`. Not executed against production (ruling A0-C15).
