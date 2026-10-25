# CCP-A2 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.1 A2 row.

| | |
|---|---|
| **Slice** | CCP-A2, commercial audit + CommercialPolicyVersion v1 |
| **Branch / baseline** | `feat/ccp-commercial-control-plane` at `744a6040` (P-6 re-verification in `doc/ccp/slices/CCP-A2-pre-execution.md`). During execution the lead committed `025fa7cf` and `d58b467d` (TD-A1-12 seed description, decision register `doc/ccp/decisions.md`, repo map). They touch no A2 file; the P-6 `seed.ts:3252`, `:3264`, `:3296` citations still hold; the repo map was regenerated on top of `d58b467d`. The register's row A2-B matches the semantics implemented here. |
| **Local commit SHAs** | committed locally: `1cff99e8` CCP-A2 A2-0: P-6 path:line re-verification; `a2f04add` CCP-A2 A2-1: commercial audit + CommercialPolicyVersion migration (v1 ACTIVE seed) and Prisma models; `11307c9c` CCP-A2 A2-2: fail-closed policy parser, pure boundary checks, policy and audit repositories; `585cd1bb` CCP-A2 A2-3: policy, boundary-table and real-Postgres trigger tests; `49a26909` CCP-A2 A2-4: commercial audit read route (platform:commercial:audit:read), OpenAPI and gates; `4b93db34` CCP-A2 A2-5: per-role allowed/refused tests for the audit read route |
| **HALT conditions hit** | None. The boundary semantics are PO-confirmed (2026-10-24). No import of `@aramo/policy-store`, no new nx edge (platform-admin already depends on `@aramo/subscription`), and no policy value held as a code constant (proved by a source-scan test, §3). |

## 1. Changes per increment (proposed commit map)

| # | Proposed commit | Files |
|---|---|---|
| A2-0 | `CCP-A2: P-6 path:line re-verification` | `doc/ccp/slices/CCP-A2-pre-execution.md` |
| A2-1 | `CCP-A2: commercial audit + CommercialPolicyVersion migration (v1 ACTIVE seed) and Prisma models` | `libs/subscription/prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A2-2 | `CCP-A2: fail-closed policy parser, pure boundary checks, policy and audit repositories` | `libs/subscription/src/lib/commercial/commercial-policy.ts`, `commercial-policy-boundaries.ts`, `commercial-policy.repository.ts`, `commercial-audit.repository.ts` (all new); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| A2-3 | `CCP-A2: policy, boundary-table and real-Postgres trigger tests` | `libs/subscription/src/tests/commercial-policy.spec.ts`, `commercial-policy-boundaries.spec.ts`, `commercial-audit-policy.integration.spec.ts`, `fixtures/commercial-policy-seed.ts` (all new) |
| A2-4 | `CCP-A2: commercial audit read route (platform:commercial:audit:read), OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-audit.controller.ts`, `dto/commercial-audit.dto.ts` (new); `apps/platform-admin/src/app/platform/platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` |
| A2-5 | `CCP-A2: per-role allowed/refused tests for the audit read route` | `apps/platform-admin/src/tests/ccp-a2-commercial-audit-authorization.spec.ts` (new) |
| A2-6 | `CCP-A2: acceptance evidence` + `CCP-A2: regenerate repo map` | `doc/ccp/slices/CCP-A2-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` (see TD-A2-7) |

**Unchanged:** `pact/` (no edit needed, see §6), `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts` (env-driven grace untouched), every existing migration, `libs/identity` (no seed or catalog change), `apps/platform-web`, `apps/api` sources.

## 2. Policy v1 (Charter §7, D5) as seeded

Row `subscription."CommercialPolicyVersion"` id `019a0000-0000-7000-8000-0000000cc201`, `version_number` 1, `status` ACTIVE.

Content (canonical JSON, keys sorted; units: basis points, USD minor units, days, hours):
```json
{"approval_expiry_hours":72,"credit_escalation_threshold_minor":50000,"currency":"USD","discount_escalation_threshold_bps":2000,"format_version":1,"past_due_grace_days":7,"support_extension_cumulative_max_days":30,"support_extension_cumulative_window_days":365,"support_extension_frequency_window_days":90,"support_extension_max_days":14}
```

| D5 value | Key | v1 |
|---|---|---|
| Discount escalation 20% | `discount_escalation_threshold_bps` | 2000 |
| Credit escalation $500 (USD) | `credit_escalation_threshold_minor` + `currency` | 50000, `USD` |
| Extension max 14 days | `support_extension_max_days` | 14 |
| Once per 90 days | `support_extension_frequency_window_days` | 90 |
| 30 days cumulative (rolling 12 months, PO) | `support_extension_cumulative_max_days` / `_window_days` | 30 / 365 |
| Approval expiry 72 h | `approval_expiry_hours` | 72 |
| Past-due grace 7 days | `past_due_grace_days` | 7 |

**Checksum** (SHA-256 of the canonical JSON): `bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5`. Recomputed by `commercial-policy.spec.ts` from the literal parsed out of the migration, and on real Postgres by `getActivePolicy()` (`commercial-audit-policy.integration.spec.ts`). The same checksum is carried by both seed audit rows (3 occurrences in the migration, asserted).

Seed audit rows: `CommercialPolicyAuditEvent` `…cc202` and `CommercialAuditEvent` `…cc203`, both `COMMERCIAL_POLICY_VERSION_ACTIVATED`, actor `system`, correlation `migration:20261024180000_ccp_a2_commercial_audit_policy`. The seed is idempotent: re-running the seed block inserts 0 rows (tested).

## 3. Trigger and fail-closed test outputs (real Postgres 17)

`libs/subscription/src/tests/commercial-audit-policy.integration.spec.ts`, **22 / 22 passed**. The A2 migration is applied on top of the full subscription chain (all 8 existing migrations plus the metering init). The exception texts below are asserted verbatim.

| Statement | Result (verbatim) |
|---|---|
| `UPDATE CommercialAuditEvent …` (any column, including `payload = payload`) | `CommercialAuditEvent is an append-only commercial audit ledger (UPDATE rejected)` |
| `DELETE FROM CommercialAuditEvent …` | `CommercialAuditEvent is an append-only commercial audit ledger (DELETE rejected)`; row count unchanged |
| `UPDATE CommercialPolicyAuditEvent …` | `CommercialPolicyAuditEvent is an append-only governance ledger (UPDATE rejected)` |
| `DELETE FROM CommercialPolicyAuditEvent …` | `CommercialPolicyAuditEvent is an append-only governance ledger (DELETE rejected)` |
| `DELETE FROM CommercialPolicyVersion` (ACTIVE, DRAFT, RETIRED) | `CommercialPolicyVersion is append-only (DELETE rejected)` |
| UPDATE `content` / `content_checksum` / `note` of the ACTIVE row; of a RETIRED row; DRAFT→ACTIVE combined with a content change | `CommercialPolicyVersion content is immutable once it leaves DRAFT (create a new version instead)` |
| UPDATE `version_number` | `CommercialPolicyVersion identity is immutable` |
| ACTIVE→DRAFT, DRAFT→RETIRED, RETIRED→DRAFT | `CommercialPolicyVersion status ACTIVE -> DRAFT is not allowed` (and the same form for the other two) |
| DRAFT content edit | allowed |
| DRAFT→ACTIVE + ACTIVE→RETIRED in one transaction; RETIRED→ACTIVE (rollback path) | allowed |
| A second ACTIVE row, by INSERT or by UPDATE | unique violation on `CommercialPolicyVersion_one_active_key`; ACTIVE count stays 1 |
| ACTIVE without `activated_at`; malformed checksum; non-object content | `active_activated_check`, `content_checksum_check`, `content_check` |
| 5 concurrent `createDraftVersion` calls | version numbers 2, 3, 4, 5, 6 (advisory lock), 5 `COMMERCIAL_POLICY_VERSION_CREATED` rows, ACTIVE unchanged |
| `createDraftVersion` with malformed content | refused before any write: 0 new rows, 0 new audit rows |
| No ACTIVE version | `getActivePolicy()` → `CommercialPolicyUnavailableError` `MISSING` |
| Malformed ACTIVE document | `MALFORMED` |
| ACTIVE document with a stored checksum that does not match | `CHECKSUM_MISMATCH` |
| Audit append: unknown `policy_version_id`; user actor without id; bad `event_type`; bad `subject`; actor type `robot` | FK `CommercialAuditEvent_policy_version_id_fkey`; refused in the repository; `actor_type_check`; `user_actor_check` |
| Audit append inside a rolled-back transaction | 0 rows (the event commits with the change it records) |
| Audit read: each filter alone and combined; `from` inclusive, `to` exclusive; newest first; role keys sorted | as expected |
| Keyset paging, 7 rows with 4 sharing one millisecond, page size 3 | 3 pages, 7 distinct ids, each exactly once; a cursor replayed under other filters or a garbage cursor → `CommercialAuditCursorError` |

Unit, `commercial-policy.spec.ts` (**31 / 31**): seed equals D5; checksum equals the recomputation; key-order independence; 19 MALFORMED fixtures (non-object ×3, missing key, unknown key, format version, currency ×2, string, fractional, zero and over-range thresholds, negative credit, zero days, null expiry, negative and NaN grace, incoherent cap, incoherent windows); `MISSING`, `NOT_ACTIVE`, `MALFORMED`, `CHECKSUM_MISMATCH` on the row parser. It also scans the 3 policy source files: none of the literals 2000, 50000, 14, 90, 30, 365, 72 or 7 appears outside comments.

## 4. Boundary-test table

`libs/subscription/src/tests/commercial-policy-boundaries.spec.ts`, **37 / 37 passed**. The policy is the v1 document parsed out of the migration. Time steps are 1 ms; amount steps are one unit (1 bp, 1 cent, 1 day).

| Rule (PO semantics) | Exact | Just-below | Just-above |
|---|---|---|---|
| Discount ≥ 20% escalates | 2000 bp → **escalates** | 1999 bp (19.99%) → in limit | 2001 bp → escalates |
| Credit ≥ $500.00 escalates | 50000 → **escalates** | 49999 → in limit | 50001 → escalates |
| Extension ≤ 14 days in limit | 14 → **in limit** | 13 → in limit | 15 → escalates (LENGTH) |
| Frequency: none in the rolling 90 days before now (age of the prior extension) | 90 d → **in limit** (window elapsed) | 90 d − 1 ms → escalates (FREQUENCY) | 90 d + 1 ms → in limit |
| Cumulative ≤ 30 days (total including the request) | 30 → **in limit** | 29 → in limit | 31 → escalates (CUMULATIVE) |
| Cumulative window, 365 days (age of a 14-day prior; 14 + 14 requested + 14 other) | 365 d → **aged out**, 28 in limit | 365 d − 1 ms → counts, 42, escalates | 365 d + 1 ms → aged out, 28 in limit |
| Approval expiry 72 h (time since submitted) | 72 h → **expired** | 72 h − 1 ms → pending | 72 h + 1 ms → expired |
| Past-due grace 7 days (time since past due) | 7 d → **grace ended** | 7 d − 1 ms → within grace | 7 d + 1 ms → ended |

Additional rows: 0% and 100% discount; $0.00 credit; a non-USD credit escalates (`CURRENCY_NOT_COVERED`); a prior applied now, and a prior dated in the future, both count against frequency (fail closed); LENGTH + FREQUENCY + CUMULATIVE reported together, with the counter snapshot; invalid inputs (fractional, negative, over-range) throw `CommercialPolicyInputError`; and a different policy document moves every boundary (the values are data).

## 5. Per-role matrix: `GET /platform/commercial/audit-events`

`apps/platform-admin/src/tests/ccp-a2-commercial-audit-authorization.spec.ts`, **21 / 21 passed**. It runs a signed platform token through the real `JwtAuthGuard`, the real `RolesGuard` and `AramoExceptionFilter`. Each principal holds exactly one role, with the A1 §4.1 bundle, passed through the production `filterScopesForConsumer`.

| Role | Result |
|---|---|
| platform_owner | **200** |
| finance_admin | **200** |
| read_only_auditor | **200** |
| commercial_ops | 403 `INSUFFICIENT_PERMISSIONS`, `missing_scopes` = [`platform:commercial:audit:read`]; repository not called |
| catalog_manager | 403, same; repository not called |
| support_admin | 403, same; repository not called |
| **super_admin** | **403**, same; repository not called (no commercial scope, INV-1, PBD §12) |
| no token | 401 |
| platform_owner on a recruiter-tier token | 403; repository not called |

Also asserted: every filter reaches the repository typed (`from`/`to` as `Date`, `exception_only` as boolean); 9 malformed queries return 400 `VALIDATION_ERROR` without reaching the repository (bad uuid ×2, lower-case `event_type`, non-ISO `from`, `exception_only=yes`, `limit` 201, `limit` 0, unknown parameter, `from` ≥ `to`); a refused cursor returns 400 with `details.reason` `invalid_cursor`.

The orphan-scope reservation for `platform:commercial:audit:read` is removed (`ci/scripts/verify-orphan-scopes.ts`). The gate now detects literal enforcement; 14 CCP reservations remain.

## 6. Tests and gates run and not run

Docker 29.1.2 was available. All counts are exact.

**Run:**

| Run | Command | Result |
|---|---|---|
| subscription unit | `vitest run --root libs/subscription` | 6 files passed, 6 skipped (integration-gated); 103 passed, 89 skipped |
| subscription unit + integration, full lib | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=2` | **12 / 12 files, 192 / 192 tests** (includes the A2 spec, 22) |
| platform-admin unit | `vitest run --root apps/platform-admin` | 9 / 9 files, 216 / 216 tests (includes the A2 spec, 21) |
| platform-admin unit + integration | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/platform-admin --maxWorkers=2` | **16 / 16 files, 327 / 327 tests** (the AppModule-booting specs construct the widened SubscriptionModule) |
| lint | `nx run-many -t lint -p subscription platform-admin --skip-nx-cache` | 0 errors in both (39 and 89 warnings, all pre-existing `no-non-null-assertion`; the new files have none) |
| build, CI-simulated (dist paths) | `nx run-many -t build -p subscription platform-admin --skip-nx-cache` | 2 projects + 28 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `CommercialAuditRepository` (HEAD marker checked) |
| build, other subscription consumers | `nx run-many -t build -p api sign-service --skip-nx-cache` | 2 projects + 76 dependency tasks succeeded |
| typecheck | `nx run-many -t typecheck -p subscription platform-admin --skip-nx-cache` | 2 / 2 succeeded |
| Prisma | `prisma validate` + `prisma generate` (subscription schema) | valid; generated |
| `npm run -s orphan-scopes:check` | under a temporary index with intent-to-add entries (TD-A2-7) | `orphan-scopes:check ok`; `SELF_TEST=1` → `self-test ok` |
| `npm run -s contract-parity:check` | same temporary index | 670 live routes (668 governed), 501 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A1: 669 / 667 / 500) |
| `npm run -s openapi:drift-check` | | `openapi:drift-check ok (9 files)` |
| `redocly lint openapi/platform.yaml` | | valid; 2 warnings, both pre-existing and identical at `744a6040` (`no-server-example.com`, `no-ambiguous-paths`) |
| `npm run -s env:passthrough-check` | | ok: 107 passthrough + 3 required-interp + 2 guarded, all documented (A2 adds no env var) |
| `bash scripts/verify-vocabulary.sh` | | exit 0, Tier 1 / Tier 2 / front-door clean |
| `npm run repo-map:generate` / `repo-map:check` | temporary index | see TD-A2-7 |

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite: CI runs it (CLAUDE.md; ruling A0-C16). A2 changes no apps/api source. The api build succeeded. The apps/api specs that glob every migration (for example `s2-erasure-integrity`) will apply the A2 migration in CI: the new tables have no talent-keyed column, and the seed rows hold no talent data.
- Pact provider verification (`verify-sign`, `verify-api`). `verify-sign.ts:595` applies every subscription migration by directory glob, so A2 is picked up without an edit. The same whole-file, in-order apply is exercised by the A2 integration spec. `verify-api.ts` applies no subscription migration, and A2 changes no returned shape of an existing route, so no registration is needed. **There is no Pact contract for the new route yet:** platform-admin has no Pact provider until CCP-A10, which must add consumer contracts for this route and its refusals.

**Sufficiency.** Every A2 surface ran against real Postgres (triggers, one-ACTIVE, advisory lock, fail-closed read, keyset paging) and through the real guard chain (route matrix). The residual risks are the CI-only full api suite and the deferred A10 contract.

## 7. Recovery and rollback

- **Policy:** a later version is reverted by re-activating the prior version (RETIRED → ACTIVE is allowed at the DB, and tested). From A3 on, that is a change request. A2 ships no activation path.
- **Code:** revert the A2 commits. The route and repositories are read-mostly; nothing outside A2 calls them.
- **Compensating migration (documented, not shipped).**
  - Run in one transaction:
    1. `DROP TABLE subscription."CommercialAuditEvent";`
    2. `DROP TABLE subscription."CommercialPolicyAuditEvent";`
    3. `DROP TABLE subscription."CommercialPolicyVersion";`
    4. `DROP FUNCTION subscription.reject_commercial_audit_event_mutation(), subscription.reject_commercial_policy_audit_event_mutation(), subscription.guard_commercial_policy_version();`
  - Guard it to `RAISE` if any `CommercialAuditEvent` row exists other than seed `…cc203`, or once A3 tables reference a policy version.
  - It destroys an audit ledger, so it needs its own authorization. It is never executed against production under this directive (PBD §7.5).

## 8. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| TD-A2-1 | **Edge convention for rolling windows.** The PO record fixes the expiry edge ("at exactly 72 h it is expired") but not the millisecond edge of the 90-day, 365-day and grace windows. A2 applies the same half-open convention to all of them: a period that has fully elapsed at `now` no longer covers `now`. So a prior extension exactly 90 days old has aged out, and grace has ended at exactly 7 days. This matches `subscriptionSends` (`grace_until > at`, `allowance.service.ts:70`). | **Needs PO confirmation** (an interpretation at the boundary instant, not a value). It is tested at exact, −1 ms and +1 ms, so a different ruling is a one-operator change plus a table update. |
| TD-A2-2 | Charter §7 says a discount or credit "above the threshold" escalates; the PO-confirmed semantics are **≥** (inclusive). | Implemented as ≥, per the binding pre-execution record (Charter §14 item 2 delegates this to the PO). Recorded for the Architect. |
| TD-A2-3 | A credit in a currency other than the policy's (`USD`) **escalates** (`CURRENCY_NOT_COVERED`) instead of being converted or refused. | A fail-closed choice by the executor. No instrument covers non-USD credits. |
| TD-A2-4 | The A2 row says "DB-immutable once ACTIVE". The trigger freezes content once a row **leaves DRAFT** (ACTIVE and RETIRED alike) and refuses a combined activate-and-edit. MatchingPolicyVersion instead freezes content from insert. DRAFT stays editable. | Stricter than the row on RETIRED; looser than the clone on DRAFT, as the row's wording permits. No A2 path edits drafts. |
| TD-A2-5 | Additions beyond the brief's field list: `CommercialPolicyVersion.content_checksum`; CHECKs on the audit row (`actor_type` ∈ {user, system}, a user actor needs an id, UPPER_SNAKE `event_type`, `<kind>:<id>` `subject`); `policy_version_id` NOT NULL with a same-schema FK; `created_at` as `TIMESTAMPTZ(3)` so the keyset cursor round-trips exactly. The migration also writes a `CommercialAuditEvent` seed row for the v1 activation. `event_type` is format-checked, not a closed set, so later slices add types without a migration. | Each is tested. If the Lead wants a closed `event_type` set, later slices widen the CHECK additively. |
| TD-A2-6 | "Exactly one ACTIVE" is enforced at the DB as **at most one** (partial unique index, as instructed and as in the clone), and made exactly one by the seed. A lifecycle UPDATE that only retires the ACTIVE row would leave zero. The parser then fails closed (`MISSING`, tested). | No A2 path retires. A deferred constraint trigger (count = 1 at commit) is a possible A3 hardening when activation lands. |
| TD-A2-7 | Repo map, orphan-scope and contract-parity gates read `git ls-files` / `git grep`, and the slice must not stage. They ran under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 13 new paths; the real index is untouched. | When the lead stages the files, the gates pass as recorded. If the staged set differs, re-run `npm run repo-map:generate`. |
| TD-A2-8 | `createDraftVersion` (with its advisory lock and `CREATED` audit row) exists in the repository but is **not exposed over HTTP**. There is no activation method. | This satisfies "a version number taken under an advisory lock" without pulling A3's activation in. |
| TD-A2-9 | Grace: v1 records `past_due_grace_days` 7, and `pastDueGraceUntil` / `isWithinPastDueGrace` exist. The live lifecycle still reads `BILLING_PAST_DUE_GRACE_DAYS` (`subscription-lifecycle.service.ts:218-220`), unchanged. | As instructed. Wiring to policy, with the env-parity check, is a later slice (Charter §7). |
| TD-A2-10 | The route's per-role tests restate the A1 §4.1 bundles, as the A1 spec does (TD-A1-7). The repository is mocked in the route spec; the real repository is proven on Postgres. | `libs/identity` pins the seed to the same matrix. |
| TD-A2-11 | No Pact consumer contract for the new route. | Deferred to CCP-A10 by schedule (D11). Flagged for the program acceptance review. |

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door all clean. No exemption was added. The only exemption touching `libs/subscription` is the Stripe wire pair at `scripts/verify-vocabulary.sh:193-194` (`stripe-wire.ts`, `stripe-wire.spec.ts`); A2 does not touch either file. The project write hook flagged two Tier-2 tokens in comment and test-name text during authoring; both were reworded before any gate run.
