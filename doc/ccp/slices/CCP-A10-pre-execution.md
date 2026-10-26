# CCP-A10 — pre-execution check

Required by PBD §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A10: platform-admin Pact provider |
| **Schedule** | Program Build Directive §5.1, row A10 (`Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md:82`); execution order row 11 (`:56`, prerequisite A3) |
| **Authority** | PBD §2.1 (implementation authority for CCP-A1…A11); `Aramo-PLATFORM-UX-1-…-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` A1-3 (`:54-59`) lifts the PLATFORM-UX-1 `:88` "add no Pact work here" clause for CCP slices and requires "a Pact provider verifier for `apps/platform-admin`; consumer contracts for every CCP route, including refusal interactions. Provider verification SHALL run in CI." (D11) |
| **Baseline** | worktree `ccp-a10`, branch `wip/ccp-a10`, cut at `628a2c1c` (CCP-A3 A3-8). Drift since the previous slice: none (A3's last commit is the base). `origin/main` merge-base `78dbd6d3`. Working tree clean at start; `npm run prisma:generate` exit 0. |

## Prerequisites (§5.1 A10 row)
| Prerequisite | Evidence | Status |
|---|---|---|
| A3 evidence | `doc/ccp/slices/CCP-A3-acceptance.md` (commits `1346294f` … `628a2c1c`); TD-A3-17 defers the 7 change-request contracts to A10 | ✅ |
| A2 route without a contract | `doc/ccp/slices/CCP-A2-acceptance.md:143` and TD-A2-11 (`:174`) defer the audit-feed contract to A10 | ✅ |
| PLATFORM-UX-1 `:88` lifted for CCP | Amendment A1, A1-3 (`:54-59`); the substrate fact at `:35` ("0 of them verify `apps/platform-admin`") is still true at `628a2c1c` | ✅ |

## path:line re-verification (at `628a2c1c`)
| Relied on | Location | Verified |
|---|---|---|
| CCP routes that exist now (8) | `apps/platform-admin/src/app/platform/platform-commercial-audit.controller.ts:19` + `:24` (`GET /platform/commercial/audit-events`); `platform-commercial-change-request.controller.ts:44` (`platform/commercial/change-requests`), `:49` POST, `:77` GET, `:101` GET `:id`, `:112` submit, `:120` withdraw, `:128` approvals, `:142` reject | ✅ 1 + 7 |
| OpenAPI for them | `openapi/platform.yaml:2037`, `:2122`, `:2223`, `:2250`, `:2281`, `:2310`, `:2348` | ✅ |
| Optional non-CCP route | `platform.controller.ts:95` `GET /platform/me` | ✅ |
| Existing verifiers (4) | `pact/provider/src/verify.ts`, `verify-api.ts`, `verify-sign.ts`, `verify-ti.ts`; vitest discovery list `pact/provider/vitest.config.ts:15` | ✅ none verifies platform-admin |
| Runner wiring | `package.json:23` (`pact:consumer`, sequential `vitest run --root pact/consumers/<x>`), `package.json:24` (`pact:provider` = `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider`) | ✅ |
| CI wiring | `.github/workflows/ci.yml:602` (`npm run pact:consumer`), `:635` (`npm run pact:provider`); pact files flow consumer → provider as the `pact-files` artifact (`:610-614`, `:630-634`) | ✅ CI runs the npm scripts, so no workflow edit is needed |
| App-bootstrap aliases | `tsconfig.base.json:34-35`, `vitest.shared.ts:46`, `:49` (`@aramo/sign-service`, `@aramo/talent-intelligence-service`) | ✅ pattern for `@aramo/platform-admin` |
| eslint test-bootstrap allowlist | `eslint.config.mjs:230-262` (`pact/provider/src/**` `allow:` list) | ✅ |
| Auth on platform routes | `libs/auth/src/lib/jwt-auth.guard.ts:196-249` (Bearer first, then the `X-Aramo-Consumer`-selected `aramo_access_token_<consumer>` cookie), `:104-109` (header/claim mismatch → 401), `:392-414` (tier tripwire, 403 `tenant_token_on_platform_route`); `libs/authorization/src/lib/roles.guard.ts:79-94` (403 `missing_scopes`) | ✅ |
| platform-web transport | `libs/fe-foundation/src/api/client.ts:116` sets `X-Aramo-Consumer`; `apps/platform-web/src/main.tsx:14-15` (consumer `platform`); `apps/platform-web/src/platform-api.ts:3-5` (session cookie, `/platform/*` only) | ✅ |
| Shared CCP real-Postgres helper | `libs/subscription/src/tests/support/ccp-a3-database.ts` (`applyCcpA3Schema`, `addOperator`, `CCP_BUNDLES`); precedent of a cross-project relative import with a boundary disable: TD-A3-19 | ✅ |

## Choices the schedule leaves to the record
| Choice | Decision | Needs confirmation? |
|---|---|---|
| Provider boot | The **real** platform-admin `AppModule` (real `JwtAuthGuard`, real `RolesGuard`, the real identity RBAC resolver, the real `CommercialChangeRequestService`) on Postgres 17 with the identity + metering + subscription chains (A2, A3 included) applied whole-file through the shared A3 helper. No resolver override: authority is resolved from the seeded RBAC exactly as in production. | No (test-only) |
| Principals | One attested operator per CCP role + super_admin in the platform sentinel tenant, plus one recruiter-tier principal. The consumer sends a placeholder session cookie per role; the provider `requestFilter` swaps in a real RS256 token. | No |
| Consumer name | `platform-web` (consumer) → `platform-admin` (provider); pact file `pact/pacts/platform-web-platform-admin.json` | No |
| Optional `GET /platform/me` | Included (one allowed interaction): trivial, same harness | No (A1 amendment `:112` leaves it to A10) |
| Other non-CCP platform-admin routes | Not covered (A10 row "Out") | No |

## Correction-1 trigger check (PBD §2.4)
None. A10 is a test-only change: no architectural change, no new regulatory or commercial decision, no governing-contract amendment. The `eslint.config.mjs:226-227` comment ("Future cross-app test bootstraps require separate amendment") is satisfied by Amendment A1 (A1-3), which is LOCKED and names this verifier.
