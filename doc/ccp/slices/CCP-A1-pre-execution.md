# CCP-A1 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A1, commercial roles and scopes (catalog only) |
| **Schedule** | `Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md` (SHA-256 `44ac30ce8e06…`) |
| **Authority** | `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (SHA-256 `8149cef2faf4…`), effective as of A0 filing on 2026-10-24 |
| **Branch / baseline** | `feat/ccp-commercial-control-plane`, cut from `origin/main` `78dbd6d3`. This is the first slice, so there is no earlier slice to measure drift against. `origin/main` was re-fetched at cut and is still `78dbd6d3`. |

## Prerequisites
| # | Prerequisite | Evidence | Status |
|---|---|---|---|
| P-0 | Implementation authority in force | All 5 A0 waves (18 instruments) are filed in `Aramo/locked/`, and their sidecars were verified in place on 2026-10-24. Filing record: `Aramo/documents/CCP-A0-Amendment-Package-20261024/LOCK-Filing-Staging-20261024/00-LOCK-Filing-Record.md`. | ✅ |
| P-1 | CCP program gate discharged (H1) | Charter, architecture successor v1.2, and the Inc-3 Closure and Charter successor records are LOCKED (wave 1). | ✅ |
| P-2 | Commercial billing authority moved off super_admin (R1) | `Aramo-Authorization-Model-DDR-Amendment-v1_2-CCP-Commercial-Authority-LOCKED.md` (wave 1) | ✅ |
| P-3 | Role catalog and grant rules | Row 2 proposal LOCKED (wave 1). `Aramo-Platform-Console-Increment-1-Closure-Record-Amendment-A1-CCP-Role-Grants-v1_0-LOCKED.md` and `Aramo-T2-F1-H3-…-Amendment-A1-CCP-Confirmation-v1_0-LOCKED.md` LOCKED (wave 2). A0-C1 applies: catalog definitions only in `seed.ts`; no operator grant. | ✅ |
| P-4 | ROLES-1 gates cited | Charter citation-only row 19 (wave 1) | ✅ |
| P-5 | Bundle matrix approved | Ruling A0-C4: 25 / 205 / 984 | ✅ |
| P-6 | Exact baseline verification | Counts at `origin/main` `78dbd6d3`: `CATALOG_ROLE_COUNT = 19`, `CATALOG_SCOPE_COUNT = 190`, `CATALOG_ROLE_SCOPE_COUNT = 939` (`libs/identity/src/tests/seed-scrub.integration.spec.ts:58,64,69`); `PLATFORM_ROLE_KEYS = ['super_admin']` (`libs/identity/src/lib/dto/role.dto.ts:133`). No commits touch identity, subscription, entitlement, platform-admin or platform-web between `78dbd6d3` and the cut. The full re-verification of the schedule's §5 and §6 `path:line` items is recorded in the section below, before any code. | ✅ counts; see below |
| P-7 | Production id and key availability | PO-authorized **read-only** query on 2026-10-24 against `aramo-prod-postgres`, inside a `BEGIN TRANSACTION READ ONLY … ROLLBACK`. **0 rows** for: role ids `…0002c0`–`…0002c5`; role keys `platform_owner`, `finance_admin`, `commercial_ops`, `catalog_manager`, `support_admin`, `read_only_auditor`; scope ids `…000326`–`…000334`; and the 15 commercial scope keys. | ✅ |

## Typed divergence recorded at pre-execution
- **TD-A1-1: the production catalog differs from the seed catalog.** Prod has **19 roles, 194 scopes, 973 role-scope rows**; the seed and tests at `78dbd6d3` have 19 / 190 / 939. This is known prior drift: the prod catalog has historically differed from the seed simulation.
- It does **not** block A1:
  - The A1 migration uses **fixed ids** and is **fail-closed** (schedule §6.4.3).
  - P-7 shows that none of the A1 ids or keys exist in prod.
  - After the migration, prod is expected to hold 19+6 roles, 194+15 scopes and 973+45 role-scope rows. That expectation is recorded for the eventual production migration authorization (C15).
- The seed-scrub tests still pin the seed totals (25 / 205 / 984).

## Choices left to the record
None for CCP-A1. Ruling A0-C4 fixes the matrix and ruling A0-C1 fixes the seed boundary.

## Correction-1 trigger check (PBD §2.4)
No unanticipated architectural change, new regulatory or commercial decision, or governing-contract amendment has arisen. **No separate LOCKED directive is required.**

## Path:line re-verification (P-6, recorded by the slice executor before the first commit)
Re-verified in the worktree at `78dbd6d3` (HEAD = `origin/main`, no drift) on 2026-10-24, before any code change. ✓ = the anchor holds the content the schedule names.

### Count bases (HALT check)
| Base | Schedule | Measured | Method | |
|---|---|---|---|---|
| Role rows | 19 | 19 | `seed-scrub.integration.spec.ts:58` `CATALOG_ROLE_COUNT = 19`; 18 `SEED_ROLE_KEYS` + retired `sign_owner` | ✓ |
| Scopes | 190 | 190 | `SEED_SCOPE_KEYS.length` (tsx eval); `seed-scrub.integration.spec.ts:64` | ✓ |
| RoleScope rows | 939 | 939 | pinned at `identity.integration.spec.ts:496`, `roles1-role-model.spec.ts:180`, `seed-scrub.integration.spec.ts:69` (3 files, no other `939` pin in `libs/ apps/ ci/ pact/ scripts/ deploy/`) | ✓ |
| Platform scopes | 10 | 10 | `PLATFORM_SCOPE_KEYS.length` | ✓ |
| Tenant scopes | 180 | 180 | `SEED_SCOPE_KEYS` minus `platform:*`; `identity.integration.spec.ts:602` | ✓ |

No count base differs. **No HALT.**

Partition counts also measured by tsx eval of `role.dto.ts`: `SEED_ROLE_KEYS` 18, `PLATFORM_ROLE_KEYS` 1, `TENANT_ASSIGNABLE_ROLE_KEYS` 17, `ATS_PRODUCT_ROLE_KEYS` 11, `ESIGN_PRODUCT_ROLE_KEYS` 3, SEED minus ATS 7. All match §5 "Today".

### §3 substrate facts
| Item | Result |
|---|---|
| `role.dto.ts:53-86` `SEED_ROLE_KEYS`; `'super_admin',` at `:77`; retired `sign_owner` at `:95` | ✓ |
| `role.dto.ts:133` `PLATFORM_ROLE_KEYS = ['super_admin']`; `:126-132` comment; `:134-136` derivation | ✓ |
| `role.dto.ts:149-151` `sign_` prefix; `:169-175` ATS filter; `:102` `ORG_ROLE_KEYS` | ✓ |
| `scope.dto.ts:4` header rule; `:27-516` `SEED_SCOPE_KEYS`; `:523-541` `PLATFORM_SCOPE_KEYS`; `:546` `SCOPE_KEY_FORMAT` | ✓ |
| `scope.dto.ts:157-164` AUTHZ-2 comment, text byte-equal to schedule §7.2 "Current text"; `:166` "super_admin only"; `:189` last platform key; `:527-530` "future seed-only addition" | ✓ |
| `seed.ts:843-857` super_admin bundle (10); `:585-600` RoleScope ids; `:950-973` id map; `:860-988` `ROLE_SCOPE_ROW_IDS` | ✓ |
| `identity.service.ts:560-574` `platform_role_not_assignable` 400 | ✓ |
| `platform-invitation.service.ts:500` comment, `:504-517` pool guard, `:826` `role_keys: ['super_admin']` | ✓ |
| `invite-user.request.dto.ts:31` `TENANT_ASSIGNABLE_ROLE_KEYS` allow-list | ✓ |
| `role-catalog.service.ts:62-64` `platform:*` exclusion | ✓ |
| `consumer-scope-policy.ts:22` platform carries only `platform:*`; `:87` prefix; `:91` `filterScopesForConsumer` | ✓ |
| `jwt-issuer.service.ts:27-32` `authz_version`, not scopes | ✓ |
| `App.tsx:74-82` entry gate (`:76` check); `identity.tsx:84`; `platform.controller.ts:95-96` `/platform/me` | ✓ |
| `seed.ts:1609-1629` `COMMERCIAL_SEED_BUNDLES` / `COMMERCIAL_SEED_ROLE_SCOPE_ROW_IDS` | ✓ |

### §4.2 / §4.2.1 route anchors
| Item | Result |
|---|---|
| R-1…R-5 `platform.controller.ts:95-96, 165-166, 185-186, 252-253, 280-281`; R-6 `platform-sign.controller.ts:26-27` (all `platform:tenant:read`) | ✓ |
| provision `:122-124`, `:195-197`, `:224-226`; lifecycle `:299-301`, `:322-324`, `:344-346`, `:369-371`, `:397-398`; `platform-personal.controller.ts:41-42`; admin invite `:504-506` | ✓ |
| `skill-governance.controller.ts:80-81`; `platform-document-templates.controller.ts:223-224`; `matching-policy.controller.ts:47-48` | ✓ |

### §5 pin sites
| Item | Result |
|---|---|
| `seed-scrub.integration.spec.ts:58, 64, 69` | ✓ |
| `seed.spec.ts:89-109` sorted role list (18 entries) | ✓ |
| `identity.integration.spec.ts:146-168` role-table list (19 entries) | ✓ |
| `identity.integration.spec.ts:200` full sorted scope list (190 entries; two lines carry 2 entries each) | ✓ |
| `identity.integration.spec.ts:496` (939), `:602` (180), `:611-624` platform list, `:634-647` super_admin bundle | ✓ |
| `identity.service.spec.ts:773`, `:774-775`, `:924`, `:928-929`, `:931` | ✓ |
| `commercial-scope-seed.spec.ts:18`, `search-pr1-seed.spec.ts:41` (190) | ✓ |
| `roles1-role-model.spec.ts:180` (939), `:127-129` ATS derivation | ✓ |

### §6 change-list anchors
| Item | Result |
|---|---|
| `seed.ts:25-32` AUTHZ-2 header; `:72-110` `SEED_IDS.roles`; `:200-218` platform scope ids (0x320–0x325 used) | ✓ |
| Ids `…0002c0`–`…0002c5` and `…000326`–`…000334`: no occurrence in `libs/ apps/ ci/ pact/ scripts/ deploy/` | ✓ |
| The 6 role keys and 15 scope keys: no occurrence in backend code. Only hits: `scope.dto.ts:164` (the deferral comment) and two platform-web UI fixtures (`apps/platform-web/e2e/fixtures/session.ts:31`, `apps/platform-web/src/App.spec.tsx:19`, both `read_only_auditor` as a role label; untouched by A1) | ✓ |
| `seed.ts:3106-3159` `ROLES1_ATS_GRANT_SOURCES`; `:3239-3244` `orgUx1RoleScopeId`; `:3295` `runIdentitySeed`; `:3411-3412` super_admin `upsertRole`; `:3512-3523` platform `upsertScope` calls (`:3513` "(super_admin only)"); `:3700-3704` "NO scope.created"; `:4797-4809` ORG-UX-1 grant loop; `:5237-5241` `upsertScope` `update: {}` | ✓ |
| `identity-migrations.ts:128` last entry `20261024100000_sign_personal_geo_step_up` | ✓ |
| ATS-QA-1 migration `:3-22` header and splitDdl rules at `:21-22` | ✓ |
| `scope-catalog-consistency.mjs:66-69` pin read, `:72-83` bijection, `:98-103` tuple tally, `:105-117` `ROLE_SCOPE_ASSIGNMENTS` parse, `:167-197` section 5 | ✓ |
| `verify-orphan-scopes.ts:49-124` `CLASSIFICATIONS`, `:76-79` SKILL-TAX-1F-B2 note, `:160-169` UNEXPLAINED ORPHAN | ✓ |
| `identity.integration.spec.ts:649-659` tripwire (`key: { not: 'super_admin' }` at `:652`) | ✓ |
| `authorization-version.ops.ts:32-47` | ✓ |
| `deploy/seed-prod.sh:224` single super_admin assertion | ✓ |
| `verify-vocabulary.sh:304-305` and `:387-391` exemptions | ✓ |
| §7.8: `verify-orphan-scopes.ts:89` is the `requisition:approve` entry; `scope-catalog-consistency.mjs:160-161` is inside `EXAM_CREATE_EXPECTED_EXPLICIT` (as the schedule states) | ✓ |

### Drift notes
- **TD-A1-2 (extra pin site, not a count base).** `identity.integration.spec.ts:718` selects `key: { not: 'super_admin' }, NOT: { key: { startsWith: 'sign_' } }` and pins `14` tenant roles. It is not listed in schedule §5 or §6.7.2, but it is the same trap as `:649-659`: with 6 more platform roles it would read 20. A1 applies the same fix (`notIn: [...PLATFORM_ROLE_KEYS]`), so the pin stays 14.
- No other drift.
