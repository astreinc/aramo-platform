# CCP-A1 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the CCP-A1 schedule §10.5 (`Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md`).

| | |
|---|---|
| **Slice** | CCP-A1, commercial roles and scopes (catalog only) |
| **Branch / baseline** | `feat/ccp-commercial-control-plane`, from `origin/main` `78dbd6d3` (no drift at execution) |
| **Local commit SHAs** | committed locally on `feat/ccp-commercial-control-plane`: `eb6f96d5` CCP-A1: pre-execution record (P-0…P-7;  prod id/key check read-only;  TD-A1-1); `fe9554e7` CCP-A1 A1-0: pin catalog totals 25/205/984 and fix super_admin-only test traps; `e3e60a81` CCP-A1 A1-1: six commercial platform roles and fifteen commercial scopes in the DTO catalog; `a56addc9` CCP-A1 A1-2: seed the commercial role/scope catalog (definitions only;  no operator grant); `27f4fba4` CCP-A1 A1-3: guarded, idempotent, fail-closed commercial role catalog migration; `63b19bbd` CCP-A1 A1-4: catalog-consistency section 6 and orphan-scope reservations for the 15 commercial scopes; `3b98e04e` CCP-A1 A1-5: matrix, migration and per-role tenant-read authorization tests (incl. negative controls); `e5e83e1b` CCP-A1 A1-6: regenerate repo map |
| **Pre-execution record** | `doc/ccp/slices/CCP-A1-pre-execution.md` (P-0…P-7, P-6 path:line re-verification) |
| **HALT conditions hit** | None. Count bases 19 / 190 / 939 / 10 / 180 held (P-6). No id or key collision (P-7 and the in-repo scan). The bump set is empty (§6.4.5, measured). No CCP role is allowed on a refused route (§4.2.1, measured). No seed change goes beyond catalog definitions. |

## 1. Changes per increment (schedule §9)

The lead commits. This table maps each file to the increment it belongs to.

| # | Increment | Files |
|---|---|---|
| A1-0 | Pins first | `libs/identity/src/tests/seed-scrub.integration.spec.ts` (25 / 205 / 984); `seed.spec.ts` (24 sorted keys); `identity.integration.spec.ts` (role table 25, full scope list 205, `roleScope` 984, platform list 25, tenant 180 unchanged, the `:649-659` tripwire fix plus the symmetric assertion, and the `:718` fix, TD-A1-2); `identity.service.spec.ts` (`PLATFORM_ROLE_KEYS` 7, SEED minus ATS 13); `commercial-scope-seed.spec.ts` and `search-pr1-seed.spec.ts` (205); `roles1-role-model.spec.ts` (984); `d5-non-invertibility.spec.ts` (13) and `role-catalog.spec.ts` (platform-partition skip) (TD-A1-3) |
| A1-1 | DTOs | `libs/identity/src/lib/dto/role.dto.ts` (§6.1); `libs/identity/src/lib/dto/scope.dto.ts` (§6.2, including the row 17 comment, §7.2) |
| A1-2 | Seed | `libs/identity/prisma/seed.ts` (§6.3: role ids `…0002c0`–`…0002c5`, scope ids `…000326`–`…000334`, `CCP_PLATFORM_ROLE_SEED_BUNDLES`, `CCP_A1_ROLE_DESCRIPTIONS`, `CCP_A1_SCOPE_DESCRIPTIONS`, `ccpA1RoleScopeId`, 6 role and 15 scope upserts, 1 grant loop, header line) |
| A1-3 | Migration | `libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql` (new); `libs/common/src/lib/testing/identity-migrations.ts` (registration after `:128`) |
| A1-4 | Gates | `libs/identity/scripts/scope-catalog-consistency.mjs` (section 6); `ci/scripts/verify-orphan-scopes.ts` (15 `ACTIVE_RESERVED` entries) |
| A1-5 | Tests | `libs/identity/src/tests/ccp-a1-commercial-role-catalog.spec.ts` (new); `libs/identity/src/tests/ccp-a1-commercial-role-catalog-migration.integration.spec.ts` (new); `libs/identity/src/tests/identity.service.spec.ts` (§7.3(a), §7.1); `apps/platform-admin/src/tests/ccp-a1-platform-role-authorization.spec.ts` (new, §4.2.1 and §7.3(c)); `apps/platform-admin/src/tests/platform-invitation.service.spec.ts` (§7.3(b)); `apps/api/src/tests/ccp-a1-platform-governance-authorization.spec.ts` (new, §4.2.1 apps/api half) |
| A1-6 | Repo map | `doc/generated/repo-map.{files,coupling,projects}.json` (regenerated, see TD-A1-10) |

**Unchanged, verified by `git diff 78dbd6d3`:** `libs/identity/prisma/seed-platform-owner.ts`, `libs/identity/prisma/seed-astre.ts`, `deploy/seed-prod.sh` (the `:224` assertion count stays 1), everything under `apps/platform-admin/src/app` (including `platform-invitation.service.ts:826`), `apps/platform-web`, the non-test sources under `apps/api/src`, and `pact/`. No app code changed. No route, OpenAPI or api-surface-manifest change. No new cross-lib dependency.

## 2. §5 table as measured

| Quantity | Expected after A1 | Measured | Where measured |
|---|---|---|---|
| Role rows | 25 | 25 | seed simulation (`ccp-a1-commercial-role-catalog.spec.ts`); real PG (`seed-scrub.integration.spec.ts` `CATALOG_ROLE_COUNT`) |
| `SEED_ROLE_KEYS` | 24 | 24 | unit |
| `PLATFORM_ROLE_KEYS` | 7 | 7 | unit |
| `TENANT_ASSIGNABLE_ROLE_KEYS` | 17 | 17, same order as at `78dbd6d3` | unit |
| `ATS_PRODUCT_ROLE_KEYS` | 11 | 11 | unit |
| SEED minus ATS | 13 | 13 | unit |
| Scopes | 205 | 205 | unit; real PG; `scope-catalog-consistency.mjs` |
| `PLATFORM_SCOPE_KEYS` | 25 | 25 | unit; real PG platform list |
| Tenant scopes | 180 | 180 | unit; real PG (`identity.integration.spec.ts:602`) |
| RoleScope rows | 984 | 984 | seed simulation; real PG |
| super_admin bundle | 10 | 10, 0 commercial | unit; real PG; consistency script INV-1 |

Bundle sizes measured from the seed: platform_owner 11, finance_admin 10, commercial_ops 8, catalog_manager 4, support_admin 6, read_only_auditor 6 (45 rows; 39 commercial). Holders per commercial scope, in §1 order: 6, 1, 2, 1, 5, 1, 2, 1, 1, 2, 5, 1, 2, 6, 3 (total 39).

**§10.2 regression fingerprints.** The SHA-256 of the sorted pre-A1 rows, computed by running the `78dbd6d3` seed and the A1 seed through a recording client, is identical before and after:

| Row set | Count | SHA-256 |
|---|---|---|
| RoleScope rows of the 19 existing roles (`id|role_id|scope_id`) | 939 | `e4de0c78d6196a80f94b7847199f6539b9ae9e54f618e354ca8abf1eb6975e90` |
| Role rows of the 19 existing roles (`id|key|description|is_active`) | 19 | `e6aba93cecadec1f782a5e3caa90e4ce7745234807c8afd62a94f3b19c440bef` |
| Scope rows of the 190 existing scopes (`id|key|description`) | 190 | `09508e83113503c5e2f2a55bf39db0bb3db2fc46559248a62996e21976ef9e74` |

These are pinned in `ccp-a1-commercial-role-catalog.spec.ts`. The tenant role-catalog projection is byte-identical with and without the 6 roles for capability sets `core`, `core+ats`, `core+sign` and `core+ats+sign` (§7.3(d) test).

## 3. §4.2.1 per-role allowed and refused matrix, as measured

The real `JwtAuthGuard` (signed platform token, server-side scope resolution) and the real `RolesGuard` (`@RequireScopes`) run for a principal holding exactly one role. The role's scopes are its §4.1 bundle, passed through the production `filterScopesForConsumer` (platform consumer).

| Route | Scope | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin (control) |
|---|---|---|---|---|---|---|---|---|
| R-1 `GET /platform/me` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| R-2 `GET /platform/tenants` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| R-3 `GET /platform/dashboard` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| R-4 `GET /platform/tenants/:id` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| R-5 `GET /platform/tenants/:id/audit` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| R-6 `GET /platform/tenants/:id/sign` | tenant:read | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `POST /platform/tenants` | tenant:provision | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/invitations` | tenant:provision | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/resend-owner-invite` | tenant:provision | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/suspend` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/reactivate` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/start-offboarding` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/tenants/:id/close` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `GET /platform/tenants/:id/domain` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `GET /platform/personal-review` | tenant:lifecycle:manage | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `POST /platform/admins/invitations` | admin:invite | 403 | 403 | 403 | 403 | 403 | 403 | admitted |
| `GET /platform/skills` (apps/api) | skill:read | 403 | 403 | 403 | 403 | 403 | 403 | 200 |
| `GET /platform/document-templates/document-types` (apps/api) | document_template:read | 403 | 403 | 403 | 403 | 403 | 403 | 200 |
| `GET /platform/matching-policy` (apps/api) | matching_policy:read | 403 | 403 | 403 | 403 | 403 | 403 | 200 |

- Every 403 is `INSUFFICIENT_PERMISSIONS`, with `missing_scopes` equal to exactly the route's scope, and the route's service is never called.
- "admitted" means the guard let the request through: the status is not 403 and the code is not `INSUFFICIENT_PERMISSIONS`. The handler then answers on its own terms, for example 400 on an empty body.
- Tenant paths, §7.3, per role:
  - (a) `IdentityService` tenant invite, role replace and invitation acceptance: 400 `platform_role_not_assignable`, zero writes. 6 tests in `identity.service.spec.ts`.
  - (b) `PlatformInvitationService` invite into a tenant: 400 before any Cognito or identity call. 6 tests.
  - (c) `InviteUserRequestDto` refuses the key (`isIn`). 6 tests.
  - (d) The tenant role catalog lists none of the 6.
  - (e) `filterScopesForConsumer` yields none of the 15, and no `platform:*` scope, for `recruiter`, `org`, `sign`, `portal` and `ingestion` (both `tenantHasEsign` values). It yields exactly the bundle for `platform`.

**CCP-FU-1 (least-privilege console entry): TRACKED, OPEN.** A1 does not deliver it. The matrix above is the evidence that the v1 dependency on `platform:tenant:read` grants R-1 to R-6, tenant audit included, to all six roles (ruling A0-C5).

## 4. Migration (§6.4) and §8, as measured on real Postgres

`ccp-a1-commercial-role-catalog-migration.integration.spec.ts`, 16 tests:

- registered last, after ATS-QA-1 and the geo step-up;
- one statement under both the regex splitter and the quote-aware splitter, with no `$$`;
- on an empty catalog: a no-op (NOTICE "no role catalog yet");
- migrate after seed: 0 / 0 / 0 inserted, 0 bumped, snapshot unchanged;
- on the pre-A1 state (production per P-7): 6 / 15 / 45 inserted, rows and ids identical to the seed's, descriptions byte-identical, every `AuthorizationVersion` row unchanged;
- re-run: 0 inserted, 0 bumped;
- seed after migration: converges, snapshot unchanged;
- fail-closed fixtures, each RAISEs with the snapshot unchanged: role id with a different key; role key on a different id; scope id with a different key; scope key on a different id; a non-empty bump set (a membership already holding `platform_owner`: "1 principal(s) would change effective scopes"); an extra grant on a CCP bundle; a role description edited;
- the 939 pre-A1 RoleScope rows and the 19 pre-A1 roles are untouched, and super_admin holds 10 scopes with 0 commercial;
- **§8 NC-4, role revocation:**
  - `finance_admin` is granted through `IdentityService.replaceMembershipRoles` with `allow_platform_roles: true` (a test-container fixture only);
  - the real `IdentityEffectiveAuthorizationResolver` returns exactly the 10-scope bundle on the platform consumer, and none of the 15 on the recruiter consumer;
  - after removal, the version advanced, the old token is `stale`, and the new resolution holds none of the 15.
- **§8 NC-2, reused identities:** the pair report in `ccp-a1-commercial-role-catalog.spec.ts` lists 6 of the 15 pairs whose union can both initiate and decide in a domain. A3 refuses these at approve time; A1 documents them.
  - `platform_owner`+`commercial_ops` and `finance_admin`+`commercial_ops`: subscription, entitlement, billing;
  - `platform_owner`+`catalog_manager` and `finance_admin`+`catalog_manager`: catalog;
  - `platform_owner`+`support_admin` and `finance_admin`+`support_admin`: subscription.

  `finance_admin`+`platform_owner` has no initiator but decides in all 4 domains: this is the A3 double-step case. Adding super_admin to any CCP role changes no overlap (INV-1).

**Pact registration:** none. No returned shape changes, so the migration is not registered in `pact/provider/src/verify-api.ts`. The verifier's identity chain is unchanged.

## 5. Gate outputs (§10.5)

| Gate | Result |
|---|---|
| `node libs/identity/scripts/scope-catalog-consistency.mjs` | PASS. id-map 205, `SEED_SCOPE_KEYS` 205, pin 205, bijection OK, id uniqueness OK; section 6: "CCP A1 matrix: 6 roles, 45 role-scope rows; INV-1 super_admin commercial scopes: 0; INV-2 checked". |
| Section 6 negative control (mutated scratch copy) | Adding `platform:catalog:approve` to catalog_manager: FAIL (matrix drift, INV-2, 46 ≠ 45 rows). Adding `platform:billing:approve` to super_admin: FAIL (INV-1, size 11 ≠ 10, non-CCP holder). |
| `npm run -s orphan-scopes:check` | `orphan-scopes:check ok` |
| `SELF_TEST=1 npm run -s orphan-scopes:check` | `self-test ok` |
| `npm run -s contract-parity:check` | exit 0. 669 live routes (667 governed), 500 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified. |
| `npm run -s repo-map:check` | ok once the 7 new A1 paths are in the index (TD-A1-10) |
| `bash scripts/verify-vocabulary.sh` | exit 0: "OK: vocabulary discipline verified." Tier 1 clean, Tier 2 clean. |

## 6. Tests run and not run (§10.3)

Docker 29.1.2 was available locally. Every count below is exact.

**Ran:**

| Run | Command | Result |
|---|---|---|
| identity unit | `nx test identity --skip-nx-cache` | 60 files, 694 tests passed (before the new specs were added) |
| identity unit + integration, full lib | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/identity --maxWorkers=3` | **83 / 83 files, 946 / 946 tests passed** (`seed-scrub.integration.spec.ts`, `identity.integration.spec.ts`, every identity migration spec, the new CCP A1 migration spec) |
| identity full lib, first attempt | the same, default parallelism | 70 files passed, 13 failed on infrastructure only ("Health check not healthy after 120000ms" and hook timeouts, from 83 parallel containers); 874 passed, 3 failed, 69 skipped. The 13 files re-run at `--maxWorkers=2`: 13 / 13 files, 126 / 126 tests. The clean full run above supersedes it. |
| CCP A1 migration spec, after a lint-only edit | `ARAMO_RUN_INTEGRATION=1 … ccp-a1-commercial-role-catalog-migration.integration.spec.ts` | 1 / 1 file, 16 / 16 tests |
| platform-admin unit | `vitest run --root apps/platform-admin` | 8 / 8 files, 195 / 195 tests (includes the §4.2.1 spec, 119 tests, and the §7.3(b) additions) |
| platform-admin integration | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/platform-admin --maxWorkers=2` | 15 / 15 files, 306 / 306 tests |
| api unit | `vitest run --root apps/api` | 148 files passed and 149 skipped (integration-gated); 1260 tests passed, 1390 skipped. Includes the §4.2.1 governance spec (21 tests). |
| common unit | `vitest run --root libs/common` | 12 files passed, 1 skipped; 83 tests passed, 2 skipped |
| auth-service unit | `vitest run --root apps/auth-service` (consumes `SEED_SCOPE_KEYS`) | 22 / 22 files, 304 / 304 tests |
| lint | `nx run <p>:lint --skip-nx-cache` for identity, platform-admin, common, api | 0 errors in all 4 (warnings are pre-existing; the one warning A1 introduced was fixed) |
| build (CI-simulated, dist paths) | `nx run-many -t build -p common identity platform-admin api --skip-nx-cache` | 4 projects and the 74 tasks they depend on succeeded; `dist` `role.dto.js` carries the new keys (HEAD marker checked) |
| typecheck | `nx run-many -t typecheck -p common identity platform-admin api --skip-nx-cache` | 4 / 4 succeeded |

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite. Per CLAUDE.md on `main` and ruling A0-C16 (in force, commit `09bcde67`), CI runs it.
- apps/api integration specs. A1 changes no apps/api source. It adds one unit spec only, and apps/api consumes the A1 migration only through `IDENTITY_MIGRATIONS`. That consumption is covered by the platform-admin and identity integration runs above, where the block is a no-op on an empty catalog.
- Pact provider verification (API, Sign, Auth). There are 0 occurrences of the 6 role keys or the 15 scope keys under `pact/`, no returned-shape change, and `verify-api.ts` is untouched. The ROLES-1 `:149` counts (API 7 pacts, Sign 3, Auth 1) are not re-verified here; CI verifies them. This is a gap for the program acceptance review.

**Sufficiency.** A1 is catalog-only: DTO constants, seed, one fixed-id migration and gates. Every surface it touches is exercised against real Postgres (identity, platform-admin) and through the real guard chain (platform-admin, apps/api). The residual risks are the not-run full api integration suite and Pact verification; both run in CI before merge.

## 7. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| TD-A1-1 | The production catalog (19 / 194 / 973) differs from the seed (19 / 190 / 939). | Recorded at pre-execution. Non-blocking: the migration is fixed-id and fail-closed. |
| TD-A1-2 | An extra pin site not listed in §5: `identity.integration.spec.ts:718` pinned 14 tenant roles with `key: { not: 'super_admin' }`. | Same trap as `:649-659`. Fixed with `notIn: [...PLATFORM_ROLE_KEYS]`; the pin stays 14. |
| TD-A1-3 | Two more `super_admin`-only test traps not listed in §5: `d5-non-invertibility.spec.ts:354` (count of roles absent from the compensation bundle, 7) and `role-catalog.spec.ts:31-33` ("every tenant key except super_admin has catalog metadata"). | The 6 roles hold no compensation scope, so the count becomes 13 with a delta note. The metadata test now skips `PLATFORM_ROLE_KEYS`. No catalog metadata was added for the 6 roles, because they are never projected by the tenant catalog. |
| TD-A1-4 | §6.3.5 / §6.3.6 are implemented as loops over the new exported constants `CCP_A1_ROLE_DESCRIPTIONS` and `CCP_A1_SCOPE_DESCRIPTIONS`, not as 6 + 15 literal call lines. | Same rows and the same position (after super_admin; after `platform:matching_policy:write`). The constants exist so that the migration and the specs can prove byte-equality. |
| TD-A1-5 | No seed `role.created` audit rows for the 6 roles. | The schedule is silent for roles; §6.3.6 forbids seed audit rows for scopes. Precedent: the Sign roles and row `…02b0` carry none. |
| TD-A1-6 | The migration's fail-closed set is wider than §6.4.3. Besides id/key conflicts, it also RAISEs if `platform:tenant:read` is absent, if any ensured row's text or `is_active` differs from the seed definition, or if any CCP bundle differs from the §4.1 matrix. | Stricter only. Each RAISE has a refused-fixture test. The bump set is computed and RAISEs if non-empty (§6.4.5). No version is ever bumped. |
| TD-A1-7 | §4.2.1 app-level tests restate the §4.1 bundles. The seed constant is not exported to apps, and a relative import would cross an nx boundary. Services behind the routes are mocked. | The identity spec pins the seed to the same matrix, so drift fails one side. The real DB-backed role-to-scope resolution for a CCP role is proven in the migration integration spec (NC-4 test, real resolver). |
| TD-A1-8 | The apps/api governance-route tests are a new spec in `apps/api`. The task brief said to put the tests in platform-admin. | The schedule (§4.2.1) explicitly names `apps/api` for the platform governance routes, and platform-admin cannot import apps/api controllers (nx boundary). The 6 `platform:tenant:read` routes are in platform-admin as instructed. |
| TD-A1-9 | The `super_admin` control "byte-identical before and after" is established by the bundle fingerprint (§2) plus scope-only guard admission. A pre-A1 run of the new HTTP specs does not exist. | super_admin's 10-scope bundle and its RoleScope ids are byte-identical, and the guard decision is a pure function of the scope set. |
| TD-A1-10 | Repo map: the generator reads `git ls-files`, and the slice must not stage or commit. The map was regenerated under a temporary index with intent-to-add entries for the 7 new A1 paths (the real index is untouched). | With the files untracked, `repo-map:check` reports drift. Once the lead stages the A1 files, it passes. If the staged set differs, re-run `npm run repo-map:generate`. |
| TD-A1-11 | §7.2 replacement text is applied verbatim, and schedule §11 issue 3 is still open: Architect confirmation of the two "superseded" mappings. | Not resolved by the executor. Flagged for the Architect. |
| TD-A1-12 | Schedule §11 issue 6: the `platform:tenant:read` seed description (`seed.ts:3513`, "(super_admin only)") is now stale, because 6 more roles hold the scope. | Left unchanged, as the schedule says, because `upsertScope` uses `update: {}` and editing it would make fresh databases diverge. The migration does not update it either. The `scope.dto.ts:168` inline comment is updated per §6.2.2. |
| TD-A1-13 | §7.4 "no grant in any fixture": the test-container integration specs assign CCP roles to throwaway test memberships (the NC-4 test and the bump-set fixture). | These are the test-only fixtures that §8 and §4.2.1 require (`identity.service.spec.ts:768` precedent). No seed, seed fixture, migration or deploy script grants a CCP role. `A0-C1` is asserted by a test: no seed membership, dev fixtures included, holds a CCP role. |
| TD-A1-14 | The task brief cites the tripwire as `identity.integration.spec.ts:651-659`; the schedule cites `:649-659`. | The filter is at `:652`, inside the `:649-659` block. Both refer to the same code. |

## 8. Vocabulary result
`bash scripts/verify-vocabulary.sh`: exit 0, Tier 1 and Tier 2 clean. No `TIER2_EXCLUDES` entry was added. Inventory of the exemptions that touch A1 files (per CLAUDE.md and schedule §7.5):
- `verify-vocabulary.sh:304-305` (`scope.dto.ts`, `prisma/seed.ts`);
- `:387-391` (`role.dto.ts`, `scope.dto.ts`, `prisma/seed.ts`, `seed.spec.ts`, `identity.integration.spec.ts`).

All new text, including the text in exempt files, is clean. The new specs refer to the portal-user role through `SEED_ROLE_KEYS`, never by its literal key.
