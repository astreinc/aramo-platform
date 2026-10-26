# CCP-FIX1 — acceptance evidence

| | |
|---|---|
| **Scope** | Production-code defects found by the CCP-D5 runbook dry-runs (`wip/ccp-d5` `e7eee3fb`: `doc/ccp/runbook-dry-runs-20261025.md` §9, `doc/ccp/slices/CCP-D5-acceptance.md`), plus TD-D3-10 / D5-OBS-4 (apply-deadline alerts), TD-D5-4 (executable compensations), and the Lead's mid-task items O-D4-1 (= item 2) and O-D4-2 (item 6) from CCP-D4 |
| **Branch / baseline** | `wip/ccp-fix1` at `013bd6f3` (the integrated program) |
| **Governing text** | `doc/ccp/decisions.md` (all rulings; "Architect final rulings … TD-ACC-1"); `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED.md` (AD-1…AD-8) |
| **Local commit SHAs** | **None.** Nothing committed, pushed or stashed. Gate 5 stop. |
| **Production** | **Not touched.** No production run, migration, bootstrap or deploy. |
| **HALT conditions hit** | None. |

## 1. Item 1 — D5-DEF-3: the operator scripts through the real runner

**Defect.** `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:31` parsed `process.argv.slice(2)`. Through `deploy/jiti-tsconfig-runner.mjs` (the `npm run` path) `argv[2]` is the entry path, so every invocation was refused `INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts"}`.

**Fix.** A `scriptArgs()` helper, the same rule the A11 scripts use (`ccp-astre-backfill.ts:15-18`, `ccp-astre-fact-check.ts:13-16`): the arguments are everything after the script's own entry in `argv` (`argv[2]` when there is no match).

**The other runner scripts.**
- `usage:rollup` and `billing:price-parity` read flags with `process.argv.includes(…)`. The entry path is never a flag, so they do not have the bug.
- `billing:cutover-check` reads no arguments.
- `ccp:astre-backfill` and `ccp:astre-fact-check` already locate their entry.
- None of these needed a change.

**Test.** `libs/subscription/src/tests/ccp-fix1-script-runner.integration.spec.ts`: 7 tests, 7 passed. It runs every script through the REAL runner (`node deploy/jiti-tsconfig-runner.mjs <entry> …`) against one Postgres 17 testcontainer carrying the full chain (`applyCcpA6Schema`). For each script, a valid invocation succeeds and an invalid one is refused:

| Test | Script | Valid | Invalid |
|---|---|---|---|
| FIX1-RUN-1 | `ccp:bootstrap-platform-owner` | — | an unknown `--user` flag, a missing `--human-ref-hash`, a malformed hash: each exit 2 `INVALID_ARGUMENT` naming the bad flag (never the entry path); the footprint over 9 tables is unchanged |
| FIX1-RUN-2 | `ccp:bootstrap-platform-owner` | exit 0 `granted platform_owner`, 1 `COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED` event, 1 platform_owner role row; a re-run (`--flag=value` form) exits 0 `no-op` and writes nothing | — |
| FIX1-RUN-3 | `usage:rollup` | `--reconcile-only` prints its status line and writes no run | `--reconcile-only --rebuild` exit 2 |
| FIX1-RUN-4 | `billing:cutover-check` | exit 0 | no `DATABASE_URL` → exit 2 |
| FIX1-RUN-5 | `billing:price-parity` | `--strict` prints the strict-mode summary | no `DATABASE_URL` → exit 2 |
| FIX1-RUN-6 | `ccp:astre-backfill` | `--dry-run` prints the plan byte for byte | no `--dry-run` → exit 2 REFUSED |
| FIX1-RUN-7 | `ccp:astre-fact-check` | exit 0, the report byte for byte | a non-local URL with no `--po-authorization-ref` → exit 2 REFUSED |

## 2. Item 2 — D5-DEF-2 (= O-D4-1): a governed path to the apply-deadline policy v2

**Defect.** `POLICY_EDITABLE_KEYS` (`commercial-policy-governance.service.ts:47-59`) left out `apply_expiry_hours`, so `updateDraft` refused it `policy_key_not_editable` (`:197-199`). The PATCH DTO (`apps/platform-admin/src/app/platform/dto/commercial-governance.dto.ts:15-24`) also accepted only the 8 original keys. A request with the key was therefore a 400 at the `forbidNonWhitelisted` pipe before it reached the service. As a result, AD-1's v2 ("v1 plus the key") could not be authored without SQL.

**Fix.**
- `POLICY_EDITABLE_KEYS` now includes `COMMERCIAL_POLICY_OPTIONAL_KEYS` (`apply_expiry_hours`).
- The key has no handoff §5.6 range. It is validated exactly as the strict A2 / A6-R parser validates it: an integer from 1 to 87,600 h (`intIn(…, 1, MAX_HOURS)`). Anything else, `null` included, fails closed with `policy_value_invalid`.
- No default is seeded and no v2 is created.
- `PolicyDraftContentPatchDto` gains `@IsOptional() @IsInt() apply_expiry_hours`. The response type `CommercialPolicyContentDto` gains the optional key.
- The draft-update audit diff now covers the optional key. An absent value is recorded as `null`.

**Contracts.**
- OpenAPI `CommercialPolicyContent` gains the optional `apply_expiry_hours` (1…87,600). Without it, a v2 read would have broken that schema's `additionalProperties: false`.
- `UpdateCommercialPolicyDraft.content` gains the same key.
- The Pact consumer `platform-governance.consumer.test.ts` gains 2 interactions:
  - "a policy draft given an apply deadline by a finance admin" (200);
  - "a policy draft apply deadline refused as malformed" (400 `policy_value_invalid`).

**UI (B5 policy screen).**
- `POLICY_FIELDS` gains an optional "Apply deadline (TTL)" field, with the parser's range.
- `policyRows` lists an optional field only when this version or the active version declares it, or in the draft editor (`includeOptional`). An undeclared value reads "Not set".
- In the editor the input is empty with a "Not set" placeholder. Left blank, nothing is sent.
- The activation diff shows `Apply deadline (TTL) · Not set → 72 h`.

**Tests.**
- **`ccp-fix1-policy-apply-deadline.integration.spec.ts` (2 / 2).**
  - FIX1-POL-1:
    - The key is editable.
    - v1 and a fresh draft carry no key; the draft content equals the seed.
    - 7 malformed values (`0`, `-1`, `1.5`, `'72'`, `null`, `true`, `87601`) are each refused `policy_value_invalid`, with the draft and the audit count unchanged.
    - The bounds 1 and 87,600 are accepted.
    - A non-author is refused.
  - FIX1-POL-2, end to end:
    - A draft v2 with `apply_expiry_hours = 72` (content = v1 + the key; checksum verified).
    - POLICY_ACTIVATE by finance_admin, which itself snapshots v1 (TD-ACC-1).
    - Finance, then Owner, approve. The draft is still DRAFT.
    - An approver's apply is refused `NOT_REQUESTER`. The requester applies: v2 ACTIVE, v1 RETIRED.
    - A NEW SUBSCRIPTION_OPEN snapshots v2 (policy id and checksum).
    - Its deadline is final approval + 72 h. At deadline − 1 ms it is APPROVED and `apply_actionable`. Exactly at the deadline the apply is refused APPLY_EXPIRED: the request is APPLY_EXPIRED with exactly 1 expiry event, and no subscription is opened.
- **`apps/platform-admin/src/tests/ccp-b5-governance-routes.integration.spec.ts`: new FIX1-RI-APPLY-TTL over HTTP (file: 5 / 5).**
  - `0`, `87601` and `null` are each 400 `policy_value_invalid`.
  - `1.5` and `'72'` are 400 at the DTO gate.
  - read_only_auditor gets 403.
  - The checksum is unchanged.
  - Then 200 with the key, and the list returns it.
- **`apps/platform-web` `governance.spec.tsx` (37 / 37).**
  - FIX1-W-1 covers the model.
  - FIX1-W-2: in the editor, blank sends nothing and `72` PATCHes `{ apply_expiry_hours: 72 }`.
  - Expectation change: B5-W-5's draft editor now has 8 inputs (7 + the optional field).
- **B5 Playwright.** visual parity, axe and keyboard together: 30 / 30 passed (`ccp-b5-parity` 18, `ccp-b5-axe` 9, `ccp-b5-journeys` 3). No mask was added and no reference re-captured.

## 3. Item 3 — D5-DEF-1: `deploy/migrate-prod.sh` and a missing `.env` key

**Defect.** `read_env` (`grep … | tail | cut | sed`) exited 1 under `set -euo pipefail` when the key had no line. In `migrate_intelligence()` the assignment `TI_USER="$(read_env INTELLIGENCE_DB_USER)"` runs in the main shell, so the script died before `${TI_USER:-aramo_intelligence}` could apply. The shared migrations were applied and gated; then the script exited 1 with only the generic banner, and the Talent Intelligence step never ran. Reproduced with the `HEAD` script and a fake `docker`: 3 docker calls (status, apply, status), then exit 1 at the TI header.

**Fix.** Each missing-key path now has an explicit, defined decision, and nothing is applied half-way:
- `read_env` returns empty with exit 0 for an absent key: `{ grep … || true; }`.
- New `resolve_intelligence_env`, called by `main()` right after `DBURL`, **before any docker call**:
  - `INTELLIGENCE_DB_USER` absent or empty → the documented default `aramo_intelligence`, announced in one line naming the env file. This is the same default `docker-compose.prod.yml:550` and `tools/ensure-intelligence-db.sh:51` use; `.env.prod.example:69` ships the line commented out.
  - An invalid role name (outside `[a-z_][a-z0-9_]*`) → FATAL exit 2, "Nothing was applied".
  - `INTELLIGENCE_DB_PASSWORD` absent → FATAL exit 2, "Nothing was applied". The TI container cannot start without it (compose `:?` guard), so the shared apply no longer runs first.
- `migrate_intelligence` reuses the resolved values. Everything else is unchanged: the gates, `--until`, the URLs and the messages.

**Test.** `deploy/migrate-prod.test.sh`: 27 passed, 0 failed (19 existing + 8 new):
- DEF1-1 … DEF1-6 run under the script's own `set -euo pipefail`: absent key → empty, exit 0; absent `POSTGRES_USER`/`POSTGRES_DB` → the unchanged `aramo` defaults; TI user commented out or empty → explicit default; password absent → exit 2; invalid user → exit 2.
- DEF1-7 runs `main()` with a fake `docker` on `PATH`: a missing TI password → exit 2 with **0 docker calls**.
- DEF1-8 runs `main()` the same way: `INTELLIGENCE_DB_USER` absent → shared apply and gate, then ensure, apply and gate for TI with `INTELLIGENCE_DB_USER=aramo_intelligence`, exit 0.

**No production run.**

## 4. Item 4 — apply-deadline alerts (closes TD-D3-10, D5-OBS-4)

**Types.** Two D3 alert types, both APPROVAL family on subject `change_request`:
- `APPLY_DEADLINE_NEARING`;
- `APPLY_DEADLINE_PASSED`.

**Source.** APPROVED or APPLY_FAILED requests with a final approval, of an expirable type (`isApplyExpirable`, the guard mirror), whose SNAPSHOTTED policy version declares `apply_expiry_hours`. The deadline is computed exactly as `applyDeadlineOf` computes it: the version is read through the strict parser and its checksum must equal the request's snapshot. A request with no key (v1, AD-2) is never alerted, and neither is an unreadable or mismatched snapshot (its apply is refused INTEGRITY). APPLYING is never read (AD-4).
- **NEARING:** `now < deadline ≤ now + CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES` (reused; default 720 min = 12 h).
- **PASSED:** `deadline ≤ now` (half-open, AD-3), while the row still reads APPROVED or APPLY_FAILED (the expiry is lazy, AD-7).
- Both types share one source cap; a truncated source resolves nothing.

**Auto-resolving.**
- NEARING resolves "apply deadline reached (see APPLY_DEADLINE_PASSED)", or "change request state now X".
- PASSED resolves when the lazy expiry or an apply moves the request on.

**Evidence and contracts.**
- The evidence is exactly `state, action_type, final_approved_at, apply_deadline, apply_expiry_hours, policy_version_id`. It carries no money and no payload.
- The migration CHECK, the TS model, OpenAPI (both enums and the approval metrics `open_alerts_by_type`), the alert-type query DTO (derived) and the Pact metrics shape are all updated.

**Tests.**
- **`ccp-fix1-apply-deadline-alerts.integration.spec.ts` (3 / 3).**
  - FIX1-AL-1:
    - No alert 1 ms before the 12 h lead.
    - NEARING at exactly the lead (`threshold_minutes 720`, detail "must be applied within 720 min").
    - The evidence keys are exact, with no money.
    - A refresh brings the detection count to 2.
    - At the deadline: NEARING is RESOLVED and PASSED is OPEN; the metrics read 0 / 1.
    - A read → APPLY_EXPIRED, and the next scan resolves PASSED. Exactly 1 expiry event.
  - FIX1-AL-2: an APPLY_FAILED request (injected fault) carries APPLY_FAILED and NEARING alerts; the retry applies and both resolve "change request state now APPLIED".
  - FIX1-AL-3: no alert at the lead, at the deadline or 10,000 h later for any of:
    - a v1-snapshotted APPROVED request;
    - an APPLYING request;
    - a PENDING_APPROVAL request.
- **Expectation changes (closed set 8 → 10).**
  - `ccp-d3-alerts.spec.ts` D3-U-1 (`toHaveLength(10)`; the approval-family list).
  - `ccp-d3-operational-alerts.integration.spec.ts` (the approval metrics keys).
  - The mocked metrics in `ccp-d3-observability-authorization.spec.ts`.
  - D3 specs: 23 / 23 together with FIX1-AL.

## 5. Item 5 — TD-D5-4: every compensation as executable SQL

**Files.** 14 new reviewed SQL files next to the existing 7:
- 12 in `libs/subscription/src/tests/fixtures/`: `ccp-{a2,a3,a9,a6,b2,a7,a8,c1,b4,a6r,c2,d3}-compensating.sql`;
- `libs/identity/src/tests/fixtures/ccp-a9-compensating.sql`;
- `libs/entitlement/src/tests/fixtures/ccp-a7-compensating.sql` (new directory).

**Pattern.**
- Each file names the migration it reverses and its prose source, and says it is not a forward migration and needs PO authorization (A0-C15).
- `SET LOCAL lock_timeout`.
- A first DO block that RAISEs, changing nothing, while dependent data exists. Where the order matters, it also refuses while the later migration that depends on it is still applied (12 such ordering refusals).
- Then an additive reverse. A replaced guard body or CHECK is restored verbatim from the **preceding migration in apply order**.

The refusal conditions per file and the prose-vs-migration divergences are listed in `doc/ccp/program-gate-20261025.md` §6 / §7.

**Proof.** `libs/subscription/src/tests/ccp-full-compensation-chain.integration.spec.ts`: 24 / 24 on a fresh Postgres 17.
- **FULL-0:** the full chain applies.
- **ORDER-1:** the 12 ordering refusals hold.
- **COMP-21 … COMP-1:** each of the 21 compensations, in reverse order:
  - is refused, with nothing changed, on seeded dependent data (19 data refusals; D1 has none, since everything it drops is derived);
  - then applies with 0 errors;
  - and the identity, subscription and entitlement schemas then equal the fingerprint taken just before that migration. A1 is checked by its 6 / 15 / 45 → 0 row counts.
- **REAPPLY:** all 21 re-apply with 0 errors and restore each forward fingerprint.

`ccp-merge-train-compensation.integration.spec.ts` stays 4 / 4. The compensation table in `doc/ccp/program-gate-20261025.md` now points every row at its SQL file.

**One fix to an existing file.** `ccp-a4-compensating.sql` restored A3's interim CHECK as `product_key = 'sign'`; A3 wrote `product_key IS NULL OR product_key IN ('sign')`. The two accept the same rows, but the schema did not match the pre-A4 state, and COMP-4 caught it. The file now restores A3's text. `ccp-a4-product-dimension` passes 20 / 20.

## 6. Item 6 — O-D4-2: one spelling for the apply-deadline refusal

**Convention found.** CCP apply refusals map to HTTP 409 `COMMERCIAL_CHANGE_REQUEST_CONFLICT` in two families:

| Family | `details.reason` | `details.refusal` | Codes |
|---|---|---|---|
| Typed `CommercialApplyRefusedError` refusals | `apply_refused` | the code | NOT_APPROVED, APPROVER_NO_LONGER_ELIGIBLE, … |
| Request-level `CommercialChangeRequestError` codes | the snake-case code | none | `apply_expired`, `not_requester`, `requester_no_longer_authorized`, `action_not_applicable` |

Both families carry `details.explanation`. CCP-A6-R's apply-deadline refusal is the second family:
- `CommercialChangeRequestError('APPLY_EXPIRED')` (`commercial-apply-records.ts:141`, `:147`);
- mapped to `reason: 'apply_expired'` with the explanation, the state, and `expired_by_this_attempt` when the attempt itself expired the request (`platform-commercial-apply.controller.ts:94-97`).

The conversion route alone used a conversion-only class, `ConversionApplyRefusedError('APPLY_EXPIRED')`, reported as `reason: 'apply_refused'` + `refusal: 'APPLY_EXPIRED'` with no explanation.

**Fix (A6-R convention).**
- `CommercialConversionService` now throws exactly the A6-R refusal: `CommercialChangeRequestError('APPLY_EXPIRED', explanationOf('APPLY_EXPIRED'), { state })` for an already-expired request, and `applyExpiredNow(head)` for the attempt that expires it. The conversion controller then falls through to `applyHttpError`.
- `ConversionApplyRefusedError` and `ConversionRefusalCode` are removed. They had no other use, and both are dropped from `libs/subscription` `index.ts`.
- The audit row is unchanged: refusal `APPLY_EXPIRED`, and no second row after an expiring attempt.

**Contracts.**
- OpenAPI `CommercialConversionConflict` now lists `apply_expired`, "the same body as CommercialApplyConflict, no details.refusal".
- Pact consumer: 2 interactions, one per route, each with the same 409 body: an apply-expired subscription open at `…/apply`, and an apply-expired conversion at `…/convert`.
- 2 provider states place an APPROVED request in APPLY_EXPIRED raw, with triggers off for that one statement.

**Tests.**
- `ccp-c2-conversion-routes.integration.spec.ts` FIX1-RI-EXPIRED (file: 4 / 4). Both routes, under a v2 fixture with final approvals moved 73 h back, return identical bodies:
  - at the expiring attempt: 409, `apply_expired`, the same explanation, `state APPLY_EXPIRED`, `expired_by_this_attempt true`, no `refusal`;
  - on the next attempt: identical again.
- `ccp-c2-conversion.spec.ts` C2-U-5 drops its class assertion.
- `ccp-b5r-apply-expiry.integration.spec.ts` drops the removed class from its outcome helper; the expected string still matches `/APPLY_EXPIRED$/`.

## 7. Validation

Everything below was run in the worktree on the final tree.

| Check | Result |
|---|---|
| `ARAMO_RUN_INTEGRATION=1` libs/subscription (`--maxWorkers=2`) | 52 files, 773 / 773 passed |
| `ARAMO_RUN_INTEGRATION=1` apps/platform-admin (`--maxWorkers=2`) | 38 files, 745 / 745 passed |
| `ARAMO_RUN_INTEGRATION=1` libs/identity (`--maxWorkers=2`) | 84 files, 950 / 950 passed |
| Guard-union probe `ccp-guard-union.integration.spec.ts` | 4 / 4 (GUARD-UNION-1…4) |
| apps/platform-web `src/commercial-governance` | 37 / 37 |
| B5 Playwright: visual + axe + keyboard | 30 / 30 |
| `deploy/migrate-prod.test.sh` | 27 passed, 0 failed |
| Pact consumers: `pact/pacts` deleted first, then `npm run pact:consumer` (serial) | 14 runs, 0 failed; platform-web 172 / 172 |
| Pact providers | `verify-platform-admin` 2 / 2 (platform-web → platform-admin: 173 interactions); `verify-sign` 1 / 1; the other 3 provider files passed in the full provider run |
| Gates | `openapi:validate`, `openapi:lint`, `openapi:drift-check`, `error-codes:check`, `orphan-scopes:check`, `repo-map:check` (after `repo-map:generate`), `env:passthrough-check`, `contract-parity:check`, `verify:vocabulary`: all exit 0 |
| Lint | subscription, platform-admin, aramo-platform-web, identity, entitlement: 0 errors. One warning, in `commercial-apply.service.ts:25`, a file this work did not touch |
| Build | subscription, platform-admin, aramo-platform-web (30 dependent tasks): success |
| `tsc --noEmit` | `pact/provider`, `pact/consumers/platform-web-consumer`, `apps/platform-web/e2e`: clean |

**Environment notes.**
- **Provider timeouts.** In the first full provider run, `verify-sign` (180 s) and `verify-platform-admin` (600 s) timed out while other worktrees on the machine were running their own provider and integration suites. Both passed when re-run serially and alone.
- **Port collision.** One `verify-platform-admin` re-run failed all 173 interactions with `400 text/html "WebSockets request was expected"`: another session's process was answering on the provider's ephemeral port. The next re-run passed 2 / 2.
- **Pact expectation change.** B1's inbox row regex `ANY_STATE` gains `APPLY_EXPIRED`, which OpenAPI's `CommercialChangeRequestState` already lists. The FIX1 provider states leave APPLY_EXPIRED rows in the mixed inbox page.

## 8. Typed divergences

| ID | Divergence | Why |
|---|---|---|
| DV-FIX1-1 | The two alert types were added by editing the CCP-D3 migration `20261026090000` in place (its type CHECK), not with a new migration. | It is undeployed, and CCP-D1-R set the precedent. This keeps the 21-migration chain, and the D5 runbooks' `--until 20261027000200…` count, valid. Any local database that already applied D3 has a stale checksum and is re-synced from fresh. |
| DV-FIX1-2 | The TI password check moved before the shared-database apply. Before, a missing password failed after the shared apply. | Item 3 asks that nothing be applied half-way. A deploy without the password could not have started the TI container. |
| DV-FIX1-3 | `apply_expiry_hours: null` in a draft PATCH is refused as malformed. A draft that declares the key cannot drop it again. | The item says malformed input fails closed, and AD-1 says a key a version declares must be well-formed. Removing it means a new draft copied from v1. |
| DV-FIX1-4 | Item 6 removes the public `ConversionApplyRefusedError` / `ConversionRefusalCode` exports. | It was a single-code class kept only for the spelling the Lead asked to unify. |
| DV-FIX1-5 | `ccp-a4-compensating.sql` (an existing, already-executable file) was corrected. | It did not restore A3's exact CHECK text (§5). |
