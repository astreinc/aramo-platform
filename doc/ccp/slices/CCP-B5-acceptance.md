# CCP-B5 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.3 B5 row (mandatory: last-owner refusal surfaced; export is read-only; parity; role-change trace) plus the common Phase B set.

| | |
|---|---|
| **Slice** | CCP-B5, commercial role management + audit explorer + the policy screen (B5-P), with the backend apply of `POLICY_ACTIVATE` (TD-A9-16) |
| **Worktree / baseline** | `.claude/worktrees/ccp-b5`, branch `wip/ccp-b5`, baseline `b4a3f5f0` (pre-execution record `doc/ccp/slices/CCP-B5-pre-execution.md`) |
| **Local commit SHAs** | pending (lead commits). Nothing is committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No direct role grant exists (B5-U-8, B5-W-9, B5-RI-ROLE). No component is promoted to fe-foundation. No design change outside the pinned release. The POLICY_ACTIVATE apply runs inside the transitions the A9 guard already allows: **no guard change, no migration** (TD-B5-1 gives the exact guard delta for A6, as information, not as a need). |

## 1. Changes and proposed commit map

92 paths by `git status --short -uall`: **21 modified** (`git diff --shortstat`: 1349 insertions, 79 deletions; includes `e2e/visual/DIVERGENCES.md` and the 3 repo-map files) and **71 new** (35 source / test / doc / design-copy files incl. this record + **36 parity baselines**: 18 PNG + 18 mask files).

| # | Proposed commit | Files |
|---|---|---|
| B5-0 | `CCP-B5: pre-execution check` | `doc/ccp/slices/CCP-B5-pre-execution.md` |
| B5-1 | `CCP-B5: POLICY_ACTIVATE apply with the NC-5 snapshot re-check (no guard change)` | `libs/subscription/src/lib/commercial/commercial-policy-activation.ts` (new); `commercial-change-request.ts` (payload key set + `POLICY_TARGET_CHECKSUM_KEY`); `commercial-change-request.service.ts` (snapshot fill, create-time checks, apply hook, `applyPolicyActivation`, `effect_applied_at`) |
| B5-2 | `CCP-B5: policy drafts, read-only audit export, operator roster` | `libs/subscription/src/lib/commercial/commercial-policy-governance.service.ts`, `commercial-audit-export.service.ts`, `commercial-operator-roster.service.ts` (new); `commercial-audit.repository.ts` (filters); `subscription.module.ts`; `libs/subscription/src/index.ts` |
| B5-3 | `CCP-B5: routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-governance.controller.ts`, `dto/commercial-governance.dto.ts` (new); `platform.module.ts`; `platform-commercial-audit.controller.ts` + `dto/commercial-audit.dto.ts` (filters); `platform-commercial-change-request.controller.ts` + `dto/commercial-change-request.dto.ts` (`effect_applied_at`); `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| B5-4 | `CCP-B5: backend tests (apply + NC-5, drafts, export read-only, roster, per-role)` | `libs/subscription/src/tests/ccp-b5-governance.spec.ts`, `ccp-b5-governance.integration.spec.ts` (new); re-pointed `ccp-a9-bootstrap-role-change.integration.spec.ts` (A9-POL-1); `apps/platform-admin/src/tests/ccp-b5-governance-authorization.spec.ts`, `ccp-b5-governance-routes.integration.spec.ts` (new) |
| B5-5 | `CCP-B5: Pact consumer contracts and provider states` | `pact/consumers/platform-web-consumer/src/platform-governance.consumer.test.ts` (new); `vitest.config.ts` (`fileParallelism: false`); `pact/provider/src/verify-platform-admin.ts` (2 states) |
| B5-6 | `CCP-B5: Policy, Audit and Platform admins › commercial roles screens` | `apps/platform-web/src/commercial-governance/*` (7 new); `src/components/GovernanceRequestDialog.tsx`, `governance-components.css` (new); `src/App.tsx` (routes); `src/admins/PlatformAdminsView.tsx` |
| B5-7 | `CCP-B5: parity, axe and keyboard suites` | `doc/design-reference/ccp/CCP-UI-v1_0/*` (byte-identical to the pinned release and to B1's copy); `apps/platform-web/e2e/support/proto-ccp.ts`, `fixtures/ccp-governance.ts`, `visual/ccp-b5-states.ts`, `visual/ccp-b5-parity.spec.ts`, `a11y/ccp-b5-axe.spec.ts`, `keyboard/ccp-b5-journeys.spec.ts` (new); `visual/__screenshots__/ccp-*` (36); `visual/DIVERGENCES.md` |
| B5-8 | `CCP-B5: acceptance evidence` + `CCP-B5: regenerate repo map` | this file; `doc/generated/repo-map.{files,coupling,projects}.json` |

**Unchanged:** every migration (no B5 migration), `guard_commercial_change_request()`, the shell and rail (`src/shell/*`, `nav.ts`), `src/components/index.ts`, `theme.css`, fe-foundation, `apps/api`, `pact/provider/src/verify-api.ts` (no returned shape of an apps/api route changes).

## 2. What B5 delivers

**POLICY_ACTIVATE apply (TD-A9-16).** When the approval that completes a POLICY_ACTIVATE chain (finance → owner, Q1) commits, `applyPolicyActivation` runs in its own transaction: lock the request; integrity; idempotency (an existing `COMMERCIAL_CHANGE_REQUEST_APPLIED` event → no-op); the NC-5 re-check of every signature against the snapshotted chain and the live roster (`assertChainStillSatisfiableAtApply`); the **NC-5 snapshot re-check** (`activatePolicyVersionInTx`): the ACTIVE version must still be the one the request was created under (`POLICY_ACTIVE_CHANGED`), the target must still be DRAFT or RETIRED (`TARGET_NOT_ACTIVATABLE`) with the content the approvers saw (`target_content_checksum`; `TARGET_CHANGED`) and must parse; then ACTIVE → RETIRED, target → ACTIVE, two `CommercialPolicyAuditEvent` rows, `COMMERCIAL_POLICY_VERSION_ACTIVATED` and `COMMERCIAL_CHANGE_REQUEST_APPLIED`. A refusal writes nothing but one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` event; signatures are never touched. Rollback = a POLICY_ACTIVATE targeting a RETIRED version.

**Policy screen (`/commercial/policy`).** Versions list, the settings table against the active version (`~` rows), inline DRAFT editing (live platform_owner or finance_admin; one DRAFT at a time; a DRAFT under an open request is locked; handoff §5.6 ranges + the strict A2 parser), "Request activation…" / "Request rollback to vN…" (a POLICY_ACTIVATE change request; finance_admin only, TD-A3-5), "Create draft from vN".

**Audit explorer (`/commercial/audit`).** Actor, tenant, product, event type, change request and exceptions-only filters; append-only table without row actions; "Export CSV (n)" → `POST /platform/commercial/audit-events/export`.

**Platform admins › commercial roles (`/admins`).** The approval-chain panel (live fulfillability per chain, the A3 gate's rule), the roster (role chips, last-owner and two-role notes, pending role requests), "Request role change…" (platform_owner only) → one governed `ROLE_GRANT` / `ROLE_REVOKE` request per toggled role; last-owner refusal in the dialog and from the server.

**New routes (5):** `GET`/`POST /platform/commercial/policy-versions`, `PATCH /platform/commercial/policy-versions/{id}`, `GET /platform/commercial/operators` (all `platform:approval:read`), `POST /platform/commercial/audit-events/export` (`platform:commercial:audit:read`). No new scope, role, error code or nx edge.

## 3. Mandatory tests → IDs and outputs

| Mandatory test | Test IDs | Output |
|---|---|---|
| Last-owner refusal surfaced | B5-W-2, B5-W-8 (dialog alert, commit disabled), B5-W-9 (server 409 shown), B5-RI-ROLE (HTTP 409 `PLATFORM_LAST_OWNER`, roster `is_last_owner`), B5-ROLE-1, Pact "a last-owner role revoke refused", parity `ccp-admins-last-owner` | all pass |
| Export is read-only | B5-EXPORT-1 (every identity/subscription/metering table count unchanged except exactly +1 `COMMERCIAL_AUDIT_EXPORTED`; md5 over all prior audit rows unchanged), B5-EXPORT-2 (> 10,000 refused, no event), B5-RI-EXPORT, B5-W-7 | all pass |
| No grant path outside the request | B5-U-8 (source scan: no B5 file writes an identity row / role / attestation; the role writers are called only by the A9 governed apply and the bootstrap), B5-W-9, B5-ROLE-1 (role-row count unchanged by every B5 read/export), B5-W-ROLE (rendering never POSTs) | all pass |
| Per-role visibility (6 roles + super_admin) | B5-AUTH (35 route × role cases + tier/401), B5-RI-POLICY / -ROLE / -EXPORT, B5-W-ROLE (21 route × role cases) | §4 |
| POLICY_ACTIVATE apply incl. NC-5 snapshot | B5-APPLY-1, B5-NC5-a (role revoked between approval and apply; signatures byte-identical; re-applies once eligibility returns), B5-NC5-b (policy-version change after creation; revalidation uses v1's 72 h and chain; `POLICY_ACTIVE_CHANGED`), B5-NC5-c (target changed; service lock + `TARGET_CHANGED`), B5-ROLLBACK-1, B5-CREATE-1, B5-RI-ACTIVATE (HTTP end to end), re-pointed A9-POL-1 | all pass |
| Pixel parity 1440 / 900 | `ccp-b5-parity.spec.ts`, 9 states × 2 | **18 / 18** (§5) |
| axe | `ccp-b5-axe.spec.ts` | **9 / 9**, 0 serious / critical outside the two Lead-ruled design-palette rules |
| Keyboard | `ccp-b5-journeys.spec.ts` K-B5-1…3 | **3 / 3** (focus visible at every stop; focus returns to the opener) |
| Pact | consumer + provider | §6 |

## 4. Per-role matrix

| Route / action | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| `GET policy-versions` | 200 | 200 | 200 | 200 | 200 | 200 | 403 (gate) |
| `POST policy-versions` (draft) | **201** | 409 `policy_draft_exists` (after the owner's) / 201 | 403 `requester_role_missing` | 403 | 403 | 403 | 403 (gate) |
| `PATCH policy-versions/{id}` | 200 | 200 | 403 | 403 | 403 | 403 | 403 (gate) |
| `POST change-requests` POLICY_ACTIVATE | 403 `requester_role_missing` | **201** | 403 | 403 | 403 | 403 | 403 (gate) |
| `GET operators` | 200 | 200 | 200 | 200 | 200 | 200 | 403 (gate) |
| `POST audit-events/export` | 200 | 200 | 403 | 403 | 403 | 200 | 403 (gate) |
| `POST change-requests` ROLE_GRANT / ROLE_REVOKE | **201** (A9) | 403 | 403 | 403 | 403 | 403 | 403 (gate) |
| UI `/commercial/policy` | page | page | page (view only) | page (view only) | page (view only) | page (view only) | in-shell access denied |
| UI `/commercial/audit` | page | page | denied | denied | denied | page | denied |
| UI `/admins` | commercial roles + "Request role change…" | commercial roles (view only) | view only | view only | view only | view only | PLATFORM-UX-1 invite page (unchanged) |

Tenant-tier token → 403 and no token → 401 on all 5 B5 routes (B5-AUTH; Pact).

## 5. Parity record

Reference: the pinned CCP-UI v1.0 design file (`doc/design-reference/ccp/CCP-UI-v1_0`, MANIFEST 5 / 5 OK), prototype-only elements stripped (`e2e/support/proto-ccp.ts`: the PROTOTYPE chip, the Prototype rail group, policy v0 and every request created under it, Tweaks via prop defaults). Build: the fixture provider (`e2e/fixtures/ccp-governance.ts`, the prototype's people / POL0 / roster). Threshold 0.2 / 25 px as the PLATFORM-UX-1 suite; the project's standard 2 retries for raster noise.

| State | 1440 | 900 | Masks (DIVERGENCES.md) |
|---|---|---|---|
| ccp-policy-draft (finance_admin, v2 DRAFT editable) | pass | pass | DV-B5-02 |
| ccp-policy-active (v1 selected) | pass | pass | DV-B5-02 |
| ccp-policy-viewonly (read_only_auditor) | pass | pass | DV-B5-02 |
| ccp-policy-activation-dialog | pass | pass | — (corner allowance DV-B5-01) |
| ccp-audit (read_only_auditor) | pass | pass | DV-B5-06 |
| ccp-admins (platform_owner) | pass | pass | DV-B5-05 |
| ccp-admins-viewonly (read_only_auditor) | pass | pass | DV-B5-05 |
| ccp-admins-role-dialog | pass | pass | — (DV-B5-01) |
| ccp-admins-last-owner (not bootstrapped, refusal) | pass | pass | — (DV-B5-01) |

Final run: **18 / 18** (17 first attempt, 1 on the standard retry). Clip = the slice-owned content or the dialog (DV-B5-01): the shell chrome is CCP-B1's. PLATFORM-UX-1 regression: the 3 legacy Platform admins states × 2 = **6 / 6**; 0 existing baselines modified.

## 6. Pact (A10 coverage gate)

| | Count |
|---|---|
| Consumer contracts, platform-web → platform-admin pact | **53** interactions (32 CCP-A10 + **21 CCP-B5**: 6 allowed / 5 role-level refusals / 5 super_admin / 5 tenant-tier); `vitest run --root pact/consumers/platform-web-consumer` 53 / 53 |
| Provider-verified, platform-admin verifier | **53 / 53** interactions from **1** pact; coverage gate pass (every `/platform/commercial` route registered by the AppModule has an allowed, a super_admin and a tenant-tier interaction); 2 / 2 tests |

The allowed POLICY_ACTIVATE create is proven over HTTP on real Postgres (B5-RI-ACTIVATE), not in the pact (TD-B5-18).

## 7. Role-change trace

1. Platform admins (platform_owner, attested) → "Request role change…" on a row → the dialog toggles the six CCP roles (never super_admin); Reason + Evidence required; the chain strip shows "Role change (privileged) · Owner · policy vN · TTL" (+ "not fulfillable yet" from the live roster).
2. Commit → for each toggled role, `POST /platform/commercial/change-requests` `{action_type: ROLE_GRANT|ROLE_REVOKE, payload: {subject_user_id, role_key}, reason, idempotency_key}` (DRAFT; A9 create checks: live owner + D9, subject membership, held / not held, last owner → 409 `PLATFORM_LAST_OWNER`), then `POST …/{id}/submit` → PENDING_APPROVAL. Grants are sent before revokes.
3. A **different** platform_owner approves (`POST …/{id}/approvals`, A3 gate + seven refusals) → APPROVED → the A9 apply in its own transaction (NC-5 signature re-check → identity role write + AuthorizationVersion bump → APPLIED) → `COMMERCIAL_CHANGE_REQUEST_APPLIED`.
4. The roster shows the pending request until then, and the new chips after (B5-RI-ROLE: auditor + support_admin → APPLIED by `owner_2`).
No other console path writes a role (B5-U-8).

## 8. Tests and gates run and not run

All counts exact. Docker was hung 08:50–09:45 (HTTP 500); every Docker-backed step that ran in that window was re-run after the Lead's restart, and only the post-restart results are reported.

| Run | Command | Result |
|---|---|---|
| B5 subscription unit | `vitest run --root libs/subscription src/tests/ccp-b5-governance.spec.ts` | 8 / 8 |
| subscription unit (full) | `vitest run --root libs/subscription --maxWorkers=2` | 9 passed, 12 skipped files; 195 passed, 197 skipped |
| B5 subscription integration | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription src/tests/ccp-b5-governance.integration.spec.ts --maxWorkers=1` | see §8.1 |
| A9 + A3 subscription integration (regression; A9-POL-1 re-pointed) | `… ccp-a9-bootstrap-role-change.integration.spec.ts commercial-change-request.integration.spec.ts --maxWorkers=1` | 2 / 2 files, **48 / 48** |
| B5 platform-admin authorization | `vitest run --root apps/platform-admin src/tests/ccp-b5-governance-authorization.spec.ts` | **44 / 44** (incl. B5-AUTH-PATCH, negative-controlled: fails without the fix) |
| B5 platform-admin route integration | `ARAMO_RUN_INTEGRATION=1 … ccp-b5-governance-routes.integration.spec.ts --maxWorkers=1` | **4 / 4** |
| platform-admin unit (full) | `vitest run --root apps/platform-admin --maxWorkers=2` | see §8.1 |
| platform-web B5 spec | `vitest run --root apps/platform-web src/commercial-governance` | **31 / 31** |
| platform-web unit (full) | `vitest run --root apps/platform-web --maxWorkers=2` | see §8.1 |
| Pact consumer / provider | §6 | 53 / 53; 53 / 53 |
| parity / axe / keyboard | `PW_E2E_PORT=4405 playwright test --project=visual e2e/visual/ccp-b5-parity` etc. | 18 / 18; 9 / 9; 3 / 3; legacy admins 6 / 6 |
| lint | `nx run-many -t lint -p aramo-platform-web platform-admin subscription aramo-pact-provider platform-web-consumer-pact --skip-nx-cache` | 0 errors (warnings pre-existing; 0 new `eslint-disable no-restricted-syntax`) |
| typecheck | temporary tsconfig over `libs/subscription` + `apps/platform-admin` + `apps/platform-web` sources | 0 errors |
| build, CI-simulated | `nx run-many -t build -p subscription platform-admin aramo-platform-web api sign-service --skip-nx-cache` | see §8.1 |
| `contract-parity:check` (temporary index) | | **682** live routes (680 governed), **513** OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A3: 677 / 675 / 508) |
| `orphan-scopes:check` (+ self-test), `openapi:drift-check`, `error-codes:check`, `env:passthrough-check`, `tests:integration:check`, `pg-test-image:check` | | ok / ok (9 files) / ok / 107 + 3 + 2 / 49 roots / ok |
| `redocly lint openapi/platform.yaml` | | valid; the 2 pre-existing warnings only |
| `bash scripts/verify-vocabulary.sh` | | exit 0 |
| `repo-map:generate` / `repo-map:check` (temporary index) | | generated (3 files); ok |

### 8.1 Final runs (filled when the post-edit runs completed)

All after the last source edit, Docker healthy:

| Run | Result |
|---|---|
| B5 subscription integration (`ccp-b5-governance.integration.spec.ts`) | **11 / 11** |
| platform-admin unit (full) | **12 / 12 files, 369 / 369** |
| platform-web unit (full) | **32 / 32 files, 325 / 325** |
| build, CI-simulated (`subscription platform-admin aramo-platform-web api sign-service`) | 5 projects + 77 dependency tasks succeeded; platform-web rebuilt after the last edit (+25 tasks), `dist/apps/platform-web` carries "Commercial policy" (HEAD marker) |

**Not run:** the full `ARAMO_RUN_INTEGRATION=1 nx run api` suite (no `apps/api` source changes; PBD §8 puts the full local run before the program's single push); the full `pact:provider` across all 5 verifiers (only the platform-admin verifier changed); the full PLATFORM-UX-1 visual / a11y / keyboard suites (the legacy Platform admins states were re-run).

**Pre-existing flake:** `apps/platform-web/src/tenants/ProvisionTenantView.spec.tsx` "walks the three steps…" fails about 1 run in 3 under host load (asserts the location right after the toast) — reproduced with no B5 code in its import graph.

## 9. Recovery and rollback

UI revert (PBD B5 row). Backend: revert the B5 commits; no migration to compensate. A wrongly activated policy is reversed by a POLICY_ACTIVATE rollback (a RETIRED target). An APPROVED POLICY_ACTIVATE whose apply was refused stays APPROVED and dead (no retry route); a new request is the operator path.

## 10. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| **TD-B5-1** | **An applied POLICY_ACTIVATE stays APPROVED.** The A9 guard admits APPROVED → APPLYING → APPLIED for role actions only and no column change without a transition, so the apply writes the policy rows and the audit, not the request row; `effect_applied_at` (new, read-only, on every request DTO) carries the apply time. **Exact guard delta if the lead wants the request to reach APPLIED** (to fold into A6's replacement): in `guard_commercial_change_request()` admit `OLD."action_type" = 'POLICY_ACTIVATE' AND OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING'` and `… 'APPLYING' → 'APPLIED'` (same shape as the A9 role pair); then `applyPolicyActivation` adds the two `UPDATE`s (APPLYING with `apply_attempts + 1`; APPLIED with `applied_at`) around the policy write, and the idempotency check becomes "state = APPLIED". | Lead / A6 coordination. Not a HALT: the apply runs inside today's transitions. |
| TD-B5-2 | POLICY_ACTIVATE payload: closed key set `{policy_version_id, target_content_checksum}`; the server fills the snapshot when omitted and re-verifies it in the create transaction (`policy_version_changed`). | Pre-execution C-3. |
| TD-B5-3 | One open (DRAFT / PENDING_APPROVAL) POLICY_ACTIVATE at a time, enforced at create (409 `open_policy_request_exists`) under the policy lock (handoff §5.6 "Only one policy request can be open"). | — |
| TD-B5-4 | Draft authoring is role-based (live platform_owner or finance_admin) behind `platform:approval:read`; no governance scope exists (TD-A3-5 precedent). | — |
| TD-B5-5 | Draft edits are audited in `CommercialAuditEvent` (`COMMERCIAL_POLICY_DRAFT_UPDATED`); the policy-governance audit table's event CHECK is closed and B5 adds no migration. Draft creation writes both ledgers. | — |
| TD-B5-6 | The export is a new POST route (the A2 GET cannot record) that renders the CSV server-side, as a record: event codes, role keys, ISO time, canonical payload JSON as `detail`; formula-safe quoting; > 10,000 events refused (`export_too_large`), never truncated; returned in a JSON envelope. | Pre-execution C-5. |
| TD-B5-7 | Additive A2 list filters `change_request_id`, `product_key` (they join the cursor fingerprint only when set). | — |
| TD-B5-8 | super_admin is refused on `GET operators` (no commercial scope, INV-1), so its Platform admins page stays the PLATFORM-UX-1 invite view; the handoff shows super_admin the roles read-only. | Fail-closed; a non-commercial roster read would need a scope decision. |
| TD-B5-9 | The chain panel shows the real maker sets (above threshold: Commercial ops only — support_admin holds no billing request scope; policy change: Finance admin only, TD-A3-5); the design shows "Commercial ops or Support admin" and "Platform owner or Finance admin". | B5-U-7. |
| TD-B5-10 | platform_owner sees "Request activation…" disabled ("Needs the Finance admin role."); the design enables it for owners. | TD-A3-5. |
| TD-B5-11 | Reason and Evidence are both required and stored as the request `reason` (`"{reason}\n\nEvidence: {evidence}"`); A3 has no evidence field. | — |
| TD-B5-12 | One ROLE_GRANT / ROLE_REVOKE request per toggled role (A9: one role per request); grants are sent before revokes; a partial failure names the requests already submitted. | — |
| TD-B5-13 | No retry route for a refused apply (as TD-A9-3). | — |
| TD-B5-14 | The rail, breadcrumbs and the CCP access-denied card are B1's: `/commercial/*` breadcrumbs fall back until B1's `nav.ts` entries land; super_admin deep links render the generic in-shell `PlatformAccessDenied` until B1's commercial card replaces it. | §11. |
| TD-B5-15 | Copy: threshold help per A2-B (`DV-B5-02`); event labels read backend codes ("Apply refused" for `…_APPLY_REFUSED`); audit details read structured payloads. | Vocabulary clean. |
| TD-B5-16 | The audit explorer loads up to 1,000 events (5 pages of 200) and counts what it loaded; the export is server-side over the full filter. | — |
| TD-B5-17 | The "Change request" text filters loaded rows (short or full id); an export by request needs the text to name exactly one request (otherwise the button is disabled with the reason). | — |
| TD-B5-18 | The allowed POLICY_ACTIVATE create is not in the pact (one DRAFT and one open policy request exist globally, so it would make the pact order-dependent); it is proven over HTTP (B5-RI-ACTIVATE). The provider state "no draft commercial policy version exists" retires a leftover DRAFT using only trigger-permitted transitions (v1 keeps id, content and checksum). | — |
| TD-B5-19 | `platform-web-consumer` runs its two contract files serially (`fileParallelism: false`) so the shared pact is never written concurrently. | Test config. |
| TD-B5-20 | Two CCP values the theme lacks (`--pw-gov-changed-bg` `#fffbf2`, `--pw-gov-shadow-dialog`) are tokens in `components/governance-components.css` `:root`, not in `theme.css` (B1 edits `theme.css`). | Move at merge if B1 adds them. |
| TD-B5-21 | `GovernanceRequestDialog` / `ChainPreview` are imported by path, not exported from `components/index.ts` (left byte-unchanged: a B1 hotspot). B1 builds `BeforeAfterDiff` / chain components in parallel; consolidate at merge. | R-3 respected (`src/components/`). |
| TD-B5-22 | Process incidents, all reverted: (a) a Playwright positional filter (`ccp-b5`) matched the worktree path, so one capture run re-captured all PLATFORM-UX-1 references — the 39 rewritten baselines were restored from HEAD (0 modified now); (b) a placeholder file was written to the primary checkout by path error and deleted at once (primary `git status` back to its original single untracked file); (c) a failed `git stash push` (untracked path) was followed by `pop`, which tried to apply the shared `stash@{0}` (ats-web `ui.css`) into this worktree — the file was restored from HEAD; `stash@{0}` is intact. | Reported for transparency. |

## 11. For CCP-B1 (rail and shell)

- **Commercial › Policy** → `/commercial/policy`, scope `platform:approval:read`, icon `scale`; **Commercial › Audit** → `/commercial/audit`, scope `platform:commercial:audit:read` (the API refuses the other three commercial roles), icon `audit`.
- **Platform › Platform admins** must show for `platform:admin:invite` **or** `platform:approval:read` (the route accepts both; the handoff lists owner and auditor); `navKeyFor` / `crumbsFor`: "Commercial / Policy", "Commercial / Audit".
- Audit "Request" links go to `/commercial/approvals?request={uuid}`: the drawer should open from that parameter.
- The bootstrap banner can read `GET /platform/commercial/operators` (`chains[].fulfillable`, `all_fulfillable`).
- Swap `PlatformAccessDenied` for the commercial card on `/commercial/policy` and `/commercial/audit` for super_admin.

## 12. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0. No exemption added. The write hook flagged one Tier-2 token in an identifier during authoring; it was renamed before any gate run.
