# CCP-A10 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.1 A10 row (`:82`).

| | |
|---|---|
| **Slice** | CCP-A10, platform-admin Pact provider (D11) |
| **Authority** | PBD §2.1 + §5.1 row A10; PLATFORM-UX-1 Amendment A1, A1-3 (lifts `:88` for CCP slices; "Provider verification SHALL run in CI") |
| **Branch / baseline** | `wip/ccp-a10` cut at `628a2c1c` (CCP-A3 A3-8). Pre-execution: `doc/ccp/slices/CCP-A10-pre-execution.md` |
| **Local commit SHAs** | this commit (A10-4) |
| **HALT conditions hit** | None. No code contradicts the instruments. No CCP route is left without a contract (§3, enforced mechanically by the coverage gate). |

## 1. Changes per increment (proposed commit map)

| # | Proposed commit | Files | SHA |
|---|---|---|---|
| A10-0 | `CCP-A10: pre-execution check` | `doc/ccp/slices/CCP-A10-pre-execution.md` (new) | `429afca2` |
| A10-1 | `CCP-A10: @aramo/platform-admin test-bootstrap alias for the pact provider` | `tsconfig.base.json`, `vitest.shared.ts`, `eslint.config.mjs` (pact/provider `allow:` list) | `0b6cd1d6` |
| A10-2 | `CCP-A10: platform-web consumer contracts for every CCP route, allowed and refused` | `pact/consumers/platform-web-consumer/{package.json,project.json,tsconfig.json,vitest.config.ts}`, `src/platform-commercial.consumer.test.ts` (new); `package.json` (`pact:consumer`) | `db2c10cc` |
| A10-3 | `CCP-A10: platform-admin Pact provider verifier and CCP route coverage gate` | `pact/provider/src/verify-platform-admin.ts` (new); `pact/provider/vitest.config.ts` (`include`) | `66a376c0` |
| A10-4 | `CCP-A10: acceptance evidence` + `CCP-A10: regenerate repo map` | `doc/ccp/slices/CCP-A10-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` | this commit (A10-4) |

**Unchanged:** every `apps/` and `libs/` source (A10 is test-only), `openapi/`, `ci/`, `.github/workflows/ci.yml`, `pact/provider/src/verify-api.ts` (no migration changes a returned shape), the other 4 verifiers, every existing consumer, `doc/ccp/decisions.md`.

**CI wiring.** CI runs `npm run pact:consumer` (`.github/workflows/ci.yml:602`) and `npm run pact:provider` (`:635`), and moves `pact/pacts/` between the two jobs as an artifact (`:610-614`, `:630-634`). The new consumer is appended to the `pact:consumer` script and the new verifier is in the `pact/provider` vitest `include`, so CI runs both with **no workflow edit** (the existing verifiers are wired identically). A1-3 "Provider verification SHALL run in CI" is met by that wiring.

## 2. Design

**Provider (`pact/provider/src/verify-platform-admin.ts`).** Boots the real platform-admin `AppModule` (as `main.ts`: cookie-parser, the global `ValidationPipe`) on a Postgres testcontainer (`ARAMO_POSTGRES_TEST_IMAGE`). The schema is the shared CCP helper's: identity chain, metering init, subscription chain including A2 and A3, whole-file and in order; the platform sentinel tenant; the CCP A1 §4.1 role/scope catalog. **No resolver override:** the real `JwtAuthGuard` resolves scopes from the seeded RBAC through the identity resolver, `RolesGuard` checks them, the tier tripwire runs, and the real `CommercialChangeRequestService` decides every service-level refusal (live eligibility, attestation, separation of duties). Seven attested operators (6 CCP roles + super_admin) and one recruiter-tier principal get real RS256 tokens. The `requestFilter` rewrites the consumer's placeholder cookie (`aramo_access_token_platform=pact-<role>`, `aramo_access_token_recruiter=pact-recruiter`) to the matching real token. Sweepers off, mailer `stub`, no Redis.

**Provider states (5).** `platform operators are provisioned` (no-op; seeded once); `the commercial policy activation is audited` (the A2 migration's seed row); `a commercial tenant without an open change request exists` `{tenant_id}`; `a draft change request exists` and `a pending change request exists` → `{ requestId }`, created (and submitted) through the service's own HTTP surface as commercial_ops, each on a **fresh commercial tenant** (append-only rows, Q14). The consumer injects `requestId` with `fromProviderState`.

**Consumer (`pact/consumers/platform-web-consumer`).** `platform-web` → `platform-admin`, pact file `pact/pacts/platform-web-platform-admin.json` (V4). Raw fetches that mirror the fe-foundation `apiClient` transport (`X-Aramo-Consumer: platform`, the consumer-isolated session cookie), per the sign-workspace / sign-web / ats-web convention.

**CCP route coverage gate.** The verifier's first test walks the booted `AppModule`'s controller metadata, takes every route under `/platform/commercial`, and fails unless the pact holds, for each, at least one allowed (2xx) interaction, one super_admin refusal (403) and one tenant-tier refusal (403). This makes the A10 HALT condition ("a CCP route without a contract at the program acceptance review") a failing test rather than a review step.

## 3. Contract inventory (exact counts)

**Consumer-contract count (platform-web → platform-admin pact): 32 interactions.** 31 on the 8 CCP routes, 1 on `GET /platform/me` (non-CCP, optional). 8 allowed CCP interactions and 23 refused.

| Route | Allowed | Role refusals | super_admin | Tenant tier | No session | Total |
|---|---|---|---|---|---|---|
| `GET /platform/commercial/audit-events` (A2) | 200 read_only_auditor | 403 commercial_ops, `missing_scopes` [`platform:commercial:audit:read`] | 403 | 403 | 401 `AUTH_REQUIRED` | 5 |
| `POST /platform/commercial/change-requests` | 201 commercial_ops (DRAFT credit) | 403 finance_admin `requester_scope_missing` | 403 | 403 | | 4 |
| `GET /platform/commercial/change-requests` | 200 finance_admin (`state=PENDING_APPROVAL`) | | 403 | 403 | | 3 |
| `GET …/change-requests/{id}` | 200 finance_admin (step 0 `caller` eligible) | | 403 | 403 | | 3 |
| `POST …/{id}/submit` | 200 requester → PENDING_APPROVAL | 403 finance_admin `not_requester` | 403 | 403 | | 4 |
| `POST …/{id}/withdraw` | 200 requester → WITHDRAWN | | 403 | 403 | | 3 |
| `POST …/{id}/approvals` | 201 finance_admin → APPROVED (finance-only chain) | 409 requester `SELF_APPROVAL`; 409 support_admin `STEP_SCOPE_MISSING` | 403 | 403 | | 5 |
| `POST …/{id}/reject` | 200 finance_admin → REJECTED | 409 support_admin `STEP_SCOPE_MISSING` | 403 | 403 | | 4 |
| **CCP subtotal** | **8** | **7** | **8** | **8** | **1** | **31** |
| `GET /platform/me` (non-CCP) | 200 platform_owner | | | | | 1 |
| **Total** | 9 | 7 | 8 | 8 | 1 | **32** |

The super_admin refusals assert `missing_scopes` = [the route scope] (`platform:commercial:audit:read` or `platform:approval:read`): super_admin holds no commercial scope (INV-1, PBD §12). The tenant-tier refusals assert `details.reason` = `tenant_token_on_platform_route` (the guard's tier tripwire, `jwt-auth.guard.ts:392-414`).

**Provider-verified count (platform-admin provider): 32 of 32 interactions, from 1 pact** (`platform-web-platform-admin.json`). The platform-admin provider verifies no other consumer's pact, and no other provider verifies this pact. The two numbers are kept distinct (CLAUDE.md): the repository now holds 14 consumer pact files; platform-admin verifies 1 of them.

| Provider | Pacts verified | Change in A10 |
|---|---|---|
| api (`verify-api.ts`) | 8 | none |
| sign-service (`verify-sign.ts`) | 3 | none |
| auth-service (`verify.ts`) | 1 | none |
| talent-intelligence-service (`verify-ti.ts`) | 1 | none |
| **platform-admin (`verify-platform-admin.ts`)** | **1** (new) | new |

## 4. Tests and gates run and not run

All counts exact.

**Run:**

| Run | Command | Result |
|---|---|---|
| New consumer | `vitest run --root pact/consumers/platform-web-consumer` | 1 file, 32 / 32; pact file written with 32 interactions |
| New provider | `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts` | 2 / 2 tests (coverage gate + verification); **32 / 32 interactions verified, 0 failures** (refusal interactions included) |
| Negative control (provider) | pact file mutated: super_admin `GET audit-events` expected 200; the tenant-tier `reject` interaction removed | **both tests fail as required:** verification `expected 200 but was 403` (1 pact failure); coverage gate `CCP routes without a full contract: GET /platform/commercial/audit-events, POST /platform/commercial/change-requests/:id/reject`. The pact was regenerated afterwards |
| All consumers | `npm run pact:consumer` | exit 0; 14 suites, 14 pact files |
| All providers (regression) | `npm run pact:provider -- --maxWorkers=2` | exit 0; 452 / 452 interactions over 14 pacts (§4.1) |
| lint | `nx run-many -t lint -p aramo-pact-provider platform-web-consumer-pact --skip-nx-cache` | 0 errors; 3 warnings, all pre-existing in `verify-api.ts` (`:14`, `:2205`, `:2449`); the new files have none |
| typecheck | `tsc -p pact/provider/tsconfig.json --noEmit`; `tsc -p pact/consumers/platform-web-consumer/tsconfig.json --noEmit` | exit 0, 0 errors each (the provider check type-checks the platform-admin import graph) |
| `contract-parity:check` | temporary index | 677 live routes (675 governed), 508 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (unchanged from A3) |
| `orphan-scopes:check`, `tests:integration:check`, `pg-test-image:check`, `env:passthrough-check` | | ok; 49 roots; all callers use `ARAMO_POSTGRES_TEST_IMAGE`; 107 + 3 + 2 env (no new var) |
| `bash scripts/verify-vocabulary.sh` | | exit 0; Tier 1, Tier 2, front-door clean |
| `repo-map:generate` / `repo-map:check` | temporary index | see §4.2 |

### 4.1 Regression: every Pact provider verification

`npm run pact:provider -- --maxWorkers=2` (all 5 verifiers, one run, 1464.31 s): **exit 0; 5 / 5 files, 6 / 6 tests; 452 interactions verified across 14 pacts, 0 failures.**

| Provider (verifier) | Pact (consumer → provider) | Interactions verified |
|---|---|---|
| sign-service (`verify-sign.ts`) | aramo-core → sign-service | 11 |
| | sign-web → sign-service | 6 |
| | sign-workspace → sign-service | 11 |
| talent-intelligence-service (`verify-ti.ts`) | intelligence-integration → talent-intelligence-service | 21 |
| **platform-admin (`verify-platform-admin.ts`, new)** | **platform-web → platform-admin** | **32** |
| auth-service (`verify.ts`) | auth-service-consumer → aramo-auth-service | 6 |
| api (`verify-api.ts`) | ingestion-consumer → aramo-core | 2 |
| | prohibited-source-type → aramo-core | 1 |
| | portal-thin → aramo-core | 12 |
| | ats-web → aramo-core | 324 |
| | requisition-import-consumer → aramo-core | 1 |
| | platform-governance-consumer → aramo-core | 13 |
| | sign-service → aramo-core | 10 |
| | intelligence-webhook → aramo-core | 2 |
| **Total** | 14 pacts | **452** (420 pre-existing + 32 new) |

The 5 verifiers share one vitest process (`pool: 'forks'`, `isolate: false`); the new verifier saves and restores every env var it sets, and the four existing verifiers stay green alongside it.

### 4.2 Repo map

`npm run repo-map:generate` under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 9 new paths (real index untouched, as TD-A3-20): `doc/generated/repo-map.{files,coupling,projects}.json` modified (+180 / −1 lines: alias total 84 → 85 with `@aramo/platform-admin`; the new `platform-web-consumer-pact` project; the `aramo-pact-provider → @aramo/platform-admin` import). `repo-map:check ok`, self-test ok. Re-run `npm run repo-map:generate` if the staged set differs.

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite and the platform-admin integration suite: A10 changes no `apps/` or `libs/` source and no migration (test-only, PBD A10 row "Test-only change").
- CI: not pushed (lead merges).

**Sufficiency.** The verifier runs the production authorization path end to end (real guards, real RBAC resolution, real service, real Postgres with the A2/A3 triggers), so a contract break in a shape, a status or a refusal reason fails CI. Residual risk: the consumer is a contract of the platform-web transport, not driven through a platform-web module (B-slices will add the typed client; see §5).

## 5. Extending the contracts (later slices)

Every later CCP slice that adds or changes a route under `/platform/commercial` (A4–A9, A11, C1–C7, B-slice backends) SHALL, in the same commit set:

1. **Add interactions** in `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`: one `describe` per new route with the allowed call and the route's role-level refusals (a role missing the scope, the requester/step authority refusals, `SELF_APPROVAL` where an approval is involved), and **append the route to `GATE_ROUTES`**, which generates its super_admin and tenant-tier refusals. Split into a second `*.consumer.test.ts` file in the same project when the file grows; all write to the same pact.
2. **Add provider states** in `pact/provider/src/verify-platform-admin.ts` `stateHandlers`, seeding through the service's own HTTP surface where one exists, each mutating state on its own fresh tenant (append-only rows; Q14). Return generated ids for `fromProviderState`.
3. **Schema.** If the slice adds a subscription migration, add it to `SUBSCRIPTION_CHAIN` / the apply list in `libs/subscription/src/tests/support/ccp-a3-database.ts` (one shared helper; the verifier inherits it). A migration under `/v1` that changes a returned shape is still registered in `verify-api.ts` (§6.1).
4. **Run** `vitest run --root pact/consumers/platform-web-consumer` then `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts`. The coverage gate fails until every new CCP route has an allowed, a super_admin and a tenant-tier interaction.
5. **Report** the slice's consumer-contract count and the platform-admin provider-verified count separately, as in §3.
6. When a B-slice adds the typed platform-web client for these routes, keep the consumer's request shapes byte-aligned with it (or drive the interactions through it, as `intelligence-integration-consumer` does with its client).

## 6. Recovery and rollback

Test-only change (PBD A10 row): revert the A10 commits. No runtime code, migration, route, OpenAPI or CI workflow changes, so nothing deployed depends on it.

## 7. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| TD-A10-1 | `eslint.config.mjs:226-227` says future cross-app test bootstraps "require separate amendment". | Satisfied, not bypassed: the LOCKED PLATFORM-UX-1 Amendment A1 (A1-3) names this verifier. The allowlist entry cites it. |
| TD-A10-2 | The verifier imports the shared CCP real-Postgres helper from `libs/subscription/src/tests/support/` by relative path with an `enforce-module-boundaries` disable. | Same precedent as TD-A3-19; CLAUDE.md "one shared test helper". |
| TD-A10-3 | `@aramo/platform-admin` is wired in `tsconfig.base.json` and `vitest.shared.ts` (+ the eslint allowlist), not in a `tsconfig.lib.json` dist-path: `pact/provider` is not a built project, as with `@aramo/sign-service` and `@aramo/talent-intelligence-service`. | The third place of the 3-place law does not exist for this importer. |
| TD-A10-4 | The consumer is raw fetches, not driven through a platform-web module: there is no typed platform-web client for the CCP routes yet (B-slices), and an app module is not import-invokable from a pact project. | Harness convention (sign-workspace, sign-web, ats-web). §5 item 6. |
| TD-A10-5 | "Tenant tier refused" is the ats-web session shape (`X-Aramo-Consumer: recruiter` + `aramo_access_token_recruiter`) → 403 `tenant_token_on_platform_route`. A recruiter cookie under `X-Aramo-Consumer: platform` would instead be 401 `consumer_header_mismatch` (`jwt-auth.guard.ts:104-109`); not contracted. | Executor choice: the tier tripwire is the refusal the A10 row names. |
| TD-A10-6 | The audit-feed read is filtered to `event_type=COMMERCIAL_POLICY_VERSION_ACTIVATED` (the A2 migration seed) and the list read to `state=PENDING_APPROVAL`, so each page has one row shape. | Determinism; both filters are part of the route's contract. |
| TD-A10-7 | `GET /platform/me` (non-CCP) is contracted (allowed only). No other non-CCP platform-admin route is. | A10 row "Out" (optional); Amendment A1 `:112`. |

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added.
