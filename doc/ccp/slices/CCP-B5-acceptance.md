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

## B5-R — the integration-wave follow-up (TD-B5-1 + Charter Amendment A1 AD-4 for every applyable type)

Baseline `debd033d` (the integrated program). Governing: `doc/ccp/decisions.md` "Architect disposition: integration wave" and "Merge train" (TD-MERGE-GUARD-1, TD-MERGE-21/26/30); `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED` (AD-1…AD-8). Not committed, not pushed. **HALT conditions hit: none.**

### B5-R.1 What changed

**TD-B5-1 (Architect APPROVED): POLICY_ACTIVATE reaches APPLIED.**
- The approval that completes the chain no longer applies anything; `approve()` returns `apply: null` for it. Approval evidence stays distinct from execution: the approval rows are never written by an apply.
- The REQUESTER applies it through the existing governed command and route, `CommercialApplyService.apply` and `POST /platform/commercial/change-requests/{id}/apply`. The call is delegated to the new `CommercialPolicyApplyService` (`libs/subscription/src/lib/commercial/commercial-policy-apply.service.ts`).
- The transaction runs in this order:
  1. lock the request row;
  2. APPLIED → replay;
  3. the A1 deadline gate (`applyDeadlineGate`);
  4. NC-5 signature re-check (`assertApplyEligible`);
  5. the requester's live `finance_admin` role and D9 attestation (`REQUESTER_NO_LONGER_AUTHORIZED`);
  6. APPROVED | APPLY_FAILED → APPLYING (attempt + 1);
  7. `activatePolicyVersionInTx`, which runs the NC-5 snapshot re-check and the policy write;
  8. `COMMERCIAL_POLICY_VERSION_ACTIVATED`;
  9. `COMMERCIAL_CHANGE_REQUEST_APPLIED` (carries the approval evidence by reference);
  10. APPLYING → APPLIED with `applied_at`, the same instant as `activated_at`.
- **Refusals** (NOT_HUMAN, NOT_REQUESTER, REQUESTER_NO_LONGER_AUTHORIZED, NOT_APPROVED / an NC-5 signature refusal, INTEGRITY, APPLY_EXPIRED) change nothing and write one APPLY_REFUSED row.
- **Failures** roll back in full and record APPLY_FAILED in a separate transaction through the shared `recordApplyFailure`. The attempt is counted, one APPLY_FAILED row is written, and the request is retryable. Failures are the NC-5 snapshot refusals and faults.
- Requester-only (TD-B2-3): `preflight` is custom, because POLICY_ACTIVATE's requester authority is a role (`requester_scope` null, TD-A3-5). `applyActionable` is true only for the requester while the request is APPROVED or APPLY_FAILED.
- `CommercialChangeRequestService.applyPolicyActivation` and the approve-time hook are removed.

**`effect_applied_at`: DROPPED** (my choice under the disposition). It is redundant now that `applied_at` is authoritative for POLICY_ACTIVATE. It is removed from the service row and enrichment (`effectsOf` / `withEffects`), the DTO, the controller, the OpenAPI `CommercialChangeRequest` schema (property and required list) and the consumer pact.

**AD-4 for every applyable type.**
- `isApplyExpirable(action_type, kind)` is now exported from `commercial-change-request.ts`. Its set is A6 ∪ B2-backend ∪ {POLICY_ACTIVATE, ROLE_GRANT, ROLE_REVOKE, ENTITLEMENT_REVOKE, CONVERSION, SUPPORT_EXTENSION}, with SUPPORT_EXTENSION only when its kind is NORMAL.
- It gates A6-R's shared `expireApplyIfDue` and `lazyExpireApply` (TD-MERGE-21 scoping: still exactly the guard-admitted set; now passed `req.kind`).
- `canTransitionFor` admits → APPLY_EXPIRED from APPROVED / APPLY_FAILED for that set, never from APPLYING. `COMMERCIAL_B5R_POLICY_APPLY_TRANSITIONS` holds the POLICY_ACTIVATE apply pairs.
- Wiring:
  - **A7 revoke and A8 NORMAL extension:** already behind `applyDeadlineGate` in `CommercialApplyService`; they now expire because the predicate widened.
  - **A9 `applyRoleChange`:** a deadline gate right after lock and integrity. It refuses an APPLY_EXPIRED request; it commits an expiry that is due and returns `{applied: false, reason: 'APPLY_EXPIRED'}` with no second audit row.
  - **C2:** `assertBeforeApplyDeadline` (a refusal with no state change) is replaced by the gate-commit-refuse pattern from APPROVED / APPLY_FAILED. It sits after the APPLYING branch, so a pending-provider CONVERSION never expires.
  - **B5 policy path:** the gate in `CommercialPolicyApplyService`. Slot contention uses `expireOpenPolicyActivations`, called in the POLICY_ACTIVATE create and the draft edit under the policy lock. The policy screen read uses `lazyExpirePolicyActivations`, called by `CommercialPolicyGovernanceService.list`.
  - **Reads and the tenant × product slot:** unchanged code paths (`lazyExpireApply`, `expireOpenFor`), now covering the new types.
- The code is `APPLY_EXPIRED` and the event is `COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED` (A6-R's), exactly one per expiry.

**Guard (TD-MERGE-GUARD-1): edited only in the union file, in place.** `20261027000000_ccp_guard_union/migration.sql` gets a labelled `[union block: CCP-B5-R …]` set, and the header lists it:
- POLICY_ACTIVATE APPROVED | APPLY_FAILED → APPLYING → APPLIED | APPLY_FAILED;
- APPLY_EXPIRED from APPROVED / APPLY_FAILED for POLICY_ACTIVATE, ROLE_GRANT, ROLE_REVOKE, ENTITLEMENT_REVOKE and CONVERSION, and for SUPPORT_EXTENSION when `kind = 'NORMAL'`;
- POLICY_ACTIVATE attempt / `applied_at` rules (the A6 rules);
- POLICY_ACTIVATE APPLIED check: the target `payload->>'policy_version_id'` must be ACTIVE.

**New migration `20261027000200_ccp_b5r_policy_activate_apply`.** One deferred constraint trigger, `commercial_change_request_no_applying_commit_b5r`, scoped to POLICY_ACTIVATE. It reuses A6's `guard_commercial_change_request_not_applying()`, so a POLICY_ACTIVATE never commits in APPLYING. Role changes are left as A9 defined them.

**`20261027000100_ccp_constraint_union`: unchanged.** POLICY_ACTIVATE writes no `CommercialChangeApplication` row. The policy rows and the two audit ledgers are its record.

**Policy screen (`PolicyView`).**
- "Apply activation" (APPROVED) or "Retry apply" (APPLY_FAILED) appears only when the version's `open_request.apply_actionable` is true. It calls `POST …/{id}/apply`, then reloads; the server's `details.explanation` is shown on a refusal or failure.
- The hint shows "Request CR-… · applied {day}" or "Request CR-… · apply expired, request activation again".
- `STATE_LABEL` gains APPLY_EXPIRED.
- The API adds per version `latest_request {id, state, applied_at}` and `open_request.apply_actionable`. Open now means `COMMERCIAL_OPEN_STATES`.

### B5-R.2 Files (exact; `git status --short -uall`: 38 paths = 35 modified + 3 new; `git diff --shortstat` before this section: 34 files, 686 insertions, 293 deletions)

- **New:**
  - `libs/subscription/prisma/migrations/20261027000200_ccp_b5r_policy_activate_apply/migration.sql`
  - `libs/subscription/src/lib/commercial/commercial-policy-apply.service.ts`
  - `libs/subscription/src/tests/ccp-b5r-apply-expiry.integration.spec.ts`
- **Modified, backend:**
  - `prisma/migrations/20261027000000_ccp_guard_union/migration.sql`
  - `src/lib/commercial/{commercial-change-request.ts, commercial-change-request.service.ts, commercial-apply.service.ts, commercial-apply-records.ts (6 POLICY_* explanations), commercial-conversion.service.ts, commercial-policy-governance.service.ts}`
  - `src/lib/subscription.module.ts`
  - `src/index.ts`
- **Modified, platform-admin:** `platform-commercial-change-request.controller.ts`, `platform-commercial-governance.controller.ts`, `dto/commercial-change-request.dto.ts`, `dto/commercial-governance.dto.ts`; `openapi/platform.yaml` (new schema `CommercialPolicyLatestRequestRef`).
- **Modified, web:** `apps/platform-web/src/commercial-governance/{PolicyView.tsx, governance-api.ts, governance-model.ts, governance-errors.ts, governance.spec.tsx}`, `e2e/fixtures/ccp-governance.ts`.
- **Modified, Pact:** `pact/consumers/platform-web-consumer/src/platform-governance.consumer.test.ts` (+1 interaction; `effect_applied_at` removed; `latest_request` not pinned, TD-B5R-6), `pact/provider/src/verify-platform-admin.ts` (+1 state).
- **Modified, tests:**
  - `libs/subscription/src/tests/{ccp-b5-governance.integration.spec.ts, ccp-b5-governance.spec.ts, ccp-guard-union.integration.spec.ts, ccp-a9-role-change.spec.ts (A9-U-4), ccp-a9-bootstrap-role-change.integration.spec.ts (A9-POL-1), ccp-c2-conversion.spec.ts (C2-U-1), support/ccp-a6.ts (harness: policyApply)}`
  - `apps/platform-admin/src/tests/{ccp-b5-governance-routes.integration.spec.ts, ccp-b5-governance-authorization.spec.ts}`
- **Generated:** `doc/generated/repo-map.{files,coupling,projects}.json`; this record.

### B5-R.3 Tests (all exact, Docker healthy, after the last source edit unless noted)

| Run | Result |
|---|---|
| subscription, full incl. integration (`ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=2`) | **46 / 46 files, 722 / 722** |
| subscription unit only | 18 passed, 28 skipped files; 302 passed, 420 skipped |
| guard union (`ccp-guard-union.integration.spec.ts`) | **4 / 4**. GUARD-UNION-1: 4,200 probes (14 × 3 × 10 × 10), live guard = `canTransitionFor`. GUARD-UNION-3 adds POLICY_ACTIVATE "cannot commit in APPLYING". GUARD-UNION-4 is inverted: every guard-admitted type is evaluated (12), and CREDIT / DISCOUNT / EXCEPTION / MIGRATION SUPPORT_EXTENSION / APPLYING rows are left alone; APPROVED → APPLY_EXPIRED is admitted by the live guard iff `isApplyExpirable`, over 14 × 3 pairs |
| negative control (union file copied aside, the B5-R NORMAL SUPPORT_EXTENSION APPLY_EXPIRED branch removed, restored by copy) | GUARD-UNION-1 and -4 fail on exactly `SUPPORT_EXTENSION/NORMAL APPROVED/APPLY_FAILED -> APPLY_EXPIRED: db=false ts=true` |
| `ccp-b5r-apply-expiry.integration.spec.ts` (new) | **7 / 7**. See the list below this table |
| `ccp-b5-governance.integration.spec.ts` (now on the full chain) | **13 / 13**. See the list below this table |
| platform-admin, full incl. integration | 37 files, 731 tests: 730 passed and 1 failed on the first run (B5-RI-ACTIVATE asserted `apply_attempts`, which the request DTO does not carry; assertion corrected). Re-run of `ccp-b5-governance-routes.integration.spec.ts`: **4 / 4**. B5-RI-ACTIVATE: the approval applies nothing; `open_request.apply_actionable` true for the requester only; owner and second finance_admin get 403 `not_requester`; the requester gets 200 APPLIED, then a replay; `latest_request` APPLIED |
| platform-admin `ccp-b5-governance-authorization.spec.ts` | **44 / 44** (mock gains `latest_request`) |
| platform-web unit (full) | **44 / 44 files, 479 / 479**, including B5R-W-1…4 (Apply button follows `apply_actionable`; APPLIED hint; Retry apply plus the server explanation; APPLY_EXPIRED hint with Request activation re-enabled) |
| Pact consumer (generated `pact/pacts/platform-web-platform-admin.json` deleted first; `vitest run --root pact/consumers/platform-web-consumer --maxWorkers=1`) | 3 / 3 files, 159 / 159 tests; pact written with **160** interactions (+1 CCP-B5-R: "a policy activation apply refused for a non-requester", 403 `not_requester`) |
| Pact provider (`ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts`) | **160 / 160** interactions verified; 2 / 2 tests (coverage gate pass) |
| parity / axe / keyboard (`PW_E2E_PORT=4405`, file filters only) | 18 / 18; 9 / 9; 3 / 3 (= 30 / 30); 0 baselines modified |
| lint (`aramo-platform-web platform-admin subscription aramo-pact-provider platform-web-consumer-pact`, `--skip-nx-cache`) | 0 errors (warnings pre-existing; 1 `eslint-disable` removed, 0 added) |
| build, CI-simulated (`subscription platform-admin aramo-platform-web api sign-service`, `--skip-nx-cache`) | 5 projects + 77 dependency tasks succeeded; `dist` carries `commercial-policy-apply.service.js` and "Apply activation" |
| `contract-parity:check` (temporary index) | 706 live routes (704 governed), 537 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (unchanged: no new route) |
| `openapi:drift-check` / `orphan-scopes:check` + self-test / `error-codes:check` / `redocly lint` | ok (9 files) / ok / ok / ok / valid, 2 pre-existing warnings |
| `verify-vocabulary.sh` | exit 0 (no exemption added) |
| `repo-map:generate` / `repo-map:check` (temporary index) | 3 files regenerated (+21 lines); ok |

**`ccp-b5r-apply-expiry.integration.spec.ts` (7 tests):**
- **B5R-EXP-1:** 6 types × {APPROVED, APPLY_FAILED} = 12 expiries. Each is still open at deadline − 1 ms and becomes APPLY_EXPIRED at the deadline (the half-open window), with one event whose payload is checked. It is then terminal (the guard refuses any transition out), and a second pass writes nothing.
- **B5R-NEVER-1:** a v1 snapshot never expires, for all 6 types (checked 10,000 h after approval).
- **B5R-NEVER-2:** a CONVERSION in APPLYING never expires: not through the helper, the apply, a read or the guard. A bounded EXCEPTION is not evaluated, and the guard refuses it.
- **B5R-WIRE-1:** each apply path:
  - at deadline − 1 ms: passes the gate (refused later, with no state change);
  - at the deadline: commits APPLY_EXPIRED and refuses with no APPLY_REFUSED row;
  - on a later attempt: an audited APPLY_EXPIRED refusal.
- **B5R-WIRE-2:** lazy expiry on `get` and `list`.
- **B5R-WIRE-3:** tenant × product slot release for CONVERSION, ENTITLEMENT_REVOKE and NORMAL SUPPORT_EXTENSION.
- **B5R-POL-1:** POLICY_ACTIVATE under the v2 snapshot:
  - the governance read expires it and unlocks the draft;
  - the expired request refuses its apply;
  - an APPROVED request holds the slot until its deadline, and a create at the deadline expires it;
  - applied at deadline − 1 ms → APPLIED.

**`ccp-b5-governance.integration.spec.ts` (13 tests):**
- **B5-APPLY-1:** requester-only apply. Owner, second finance_admin and a service principal are refused, one audit row each. APPLIED with `applied_at` = `activated_at`; signatures byte-identical; replay writes nothing; `effect_applied_at` absent.
- **B5-APPLY-2:** two injected faults (after the policy write, before APPLIED) → APPLY_FAILED, with the policy rolled back each time. Then the retry → APPLIED (attempt 3). The DB backstops: no commit in APPLYING; no APPLIED while the target is DRAFT.
- **B5-APPLY-3:** the requester's role is revoked and then restored.
- **B5-NC5-a:** signature refusal; no state change.
- **B5-NC5-b:** `POLICY_ACTIVE_CHANGED` → APPLY_FAILED, retry fails the same way.
- **B5-NC5-c:** the draft is locked while PENDING and while APPROVED; a bypass write gives `POLICY_TARGET_CHANGED`.
- **B5-ROLLBACK-1**, and **B5-CREATE-1** (the slot is held by APPROVED and APPLY_FAILED; `open_request.apply_actionable` per caller; `latest_request` APPLIED).
- The 6 draft / export / roster / role tests, unchanged.

**Not run:**
- the full `ARAMO_RUN_INTEGRATION=1 nx run api` (no `apps/api` source change; standing PO rule: CI runs it);
- the other 4 Pact verifiers (only the platform-admin verifier and its pact changed);
- the full PLATFORM-UX-1 visual / a11y / keyboard suites.

### B5-R.4 Typed divergences and decisions

| ID | Item | Disposition |
|---|---|---|
| TD-B5R-1 | `effect_applied_at` **dropped** (not kept as a derived field): `applied_at` is authoritative for every applied request now. A DTO, OpenAPI and Pact shape change on `CommercialChangeRequest` (field removed). Only B5 introduced it, and only the B5 consumer interaction named it. | Disposition choice, recorded. |
| TD-B5R-2 | The NC-5 **snapshot** refusals (`TARGET_*`, `POLICY_ACTIVE_CHANGED`) are now **failures** (APPLY_FAILED, retryable, attempt counted), following the A6-R taxonomy ("a guard refused its substance"). They carry distinct stable codes, `POLICY_TARGET_SNAPSHOT_MISSING / _NOT_FOUND / _NOT_ACTIVATABLE / _CHANGED / _MALFORMED` and `POLICY_ACTIVE_CHANGED`, so they never collide with the subscription `TARGET_*` explanations, plus `detail.snapshot_refusal`. The NC-5 **signature** refusals stay refusals (no state change). Nothing is activated in either case (fail closed, as B5 C-2). | Follows "keep the retry and APPLY_FAILED semantics". |
| TD-B5R-3 | The one-open policy rule and the draft lock now use `COMMERCIAL_OPEN_STATES` (DRAFT, PENDING_APPROVAL, APPROVED, APPLYING, APPLY_FAILED), replacing DRAFT / PENDING only. An approved but not yet applied activation holds the slot until APPLIED, or APPLY_EXPIRED (lazy, AD-5). Consequence: under a v1 snapshot (no deadline) an APPLY_FAILED activation holds the slot until its requester retries it to APPLIED. Persistent failures are effectively unreachable while the draft lock and the slot hold (the target cannot change and no other activation can commit). Reported because a v1-era stuck failure needs a later policy (v2+) or a new disposition. | For the Lead's awareness. |
| TD-B5R-4 | The A9 role apply has no HTTP retry route (TD-A9-3), so its expiry is reached by the in-process `applyRoleChange`, reads and nothing else. A role request holds no slot. The guard admits APPLY_FAILED → APPLY_EXPIRED for roles (per AD-4's "from APPROVED / APPLY_FAILED"), although APPLY_FAILED stays unreachable for them. | Mirror = guard (GUARD-UNION-1). |
| TD-B5R-5 | C2's expiry check moved before `assertApplyEligible` (it ran after it), matching the A6 order ("the apply deadline, before anything else"). An expired CONVERSION now transitions to APPLY_EXPIRED; it no longer refuses with no state change. | AD-4 / AD-7. |
| TD-B5R-6 | The consumer pact does not pin `latest_request` on the versions body: it depends on the request history the provider states leave, and the provider's extra keys are allowed. The OpenAPI schema requires it, and the route integration test asserts it. | Pact order-independence (as TD-B5-18). |
| TD-B5R-7 | `ActivationDialog` copy ("becomes the active policy once approved") is unchanged, to keep the 18 pinned parity baselines. After approval the requester applies it (the screen shows "Apply activation"). | Copy follow-up if the design is updated. |
| TD-B5R-8 | `CommercialPolicyGovernanceService` takes `CommercialChangeRequestService` as an `@Optional()` 5th constructor argument (lazy expiry on the read and the draft edit). Nest injects it in `SubscriptionModule`; the manual constructions in specs pass it where expiry matters. | — |

The rollback note in §9 is superseded for POLICY_ACTIVATE: a failed apply is now APPLY_FAILED and retryable by its requester through `POST …/apply`.

### B5-R.5 Compensating SQL (added at the merge train, 2026-10-25; documented, not shipped)

`libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql` reverses `20261027000200_ccp_b5r_policy_activate_apply`. It drops the deferred `commercial_change_request_no_applying_commit_b5r` trigger; A6's checking function stays.

It is refused (RAISE, nothing changed) while a POLICY_ACTIVATE request is APPROVED, APPLYING or APPLY_FAILED.

**Order and authority.** B5-R's guard branch lives in `20261027000000_ccp_guard_union`, whose compensation runs after this one (`doc/ccp/decisions.md`, TD-MERGE-GUARD-1). Run it with a code revert of B5-R. Production execution needs separate PO authorization (A0-C15).

**Proven** on a fresh Postgres 17 by `ccp-merge-train-compensation.integration.spec.ts`:
- COMP-1: refused with an APPROVED POLICY_ACTIVATE.
- COMP-2: 0 errors, trigger gone.
- COMP-3: the migration re-applies and the trigger is back.


## ACC-1 — withdrawal of a failed policy activation (TD-ACC-1 Option B)

**Governing ruling.** `doc/ccp/decisions.md`, "Architect final rulings (2026-10-25): Finance amount scope + TD-ACC-1" (binding).

**Worktree.** `.claude/worktrees/ccp-acc1`, branch `wip/ccp-acc1b`, base `013bd6f3`. Nothing is committed or pushed. HALT conditions hit: none.

### ACC-1.1 What changed

**The route: the existing withdraw route, extended.** `POST /platform/commercial/change-requests/{id}/withdraw` now also takes an APPLY_FAILED POLICY_ACTIVATE, through `CommercialChangeRequestService.withdrawFailedActivation`. There is no new route: withdrawal is the same act, and it keeps the route's gate and requester rule. Every other request keeps the A3 rule (DRAFT / PENDING_APPROVAL only), and an APPROVED activation is still refused (`STATE_INVALID`).

**The withdrawal transaction**, under the apply's own locks (policy advisory lock, then the request row, with `lock_timeout` of 3,000 ms):

1. Authority:
   - the actor must be a person (`NOT_HUMAN` otherwise);
   - the original requester (`NOT_REQUESTER`, which includes the approvers);
   - still holding `finance_admin` with a live D9 attestation, read in the transaction (`REQUESTER_NO_LONGER_AUTHORIZED`).
2. Reconciliation (fail-closed):
   - **Lock held by an executing apply**, or the request in APPLYING → `APPLY_IN_PROGRESS`.
   - **APPLIED** → `ALREADY_APPLIED`, nothing written.
   - **APPLY_FAILED with this request's activation evidence** (a `COMMERCIAL_POLICY_VERSION_ACTIVATED` policy-audit row naming this request) **and an ACTIVE target**: reconciled to APPLIED in the same transaction (APPLY_FAILED → APPLYING → APPLIED, `COMMERCIAL_CHANGE_REQUEST_APPLIED` with `reconciled: true`), never withdrawn, then `ALREADY_APPLIED`.
   - **Evidence but no ACTIVE target**, or **no APPLY_FAILED record for the last attempt** → `APPLY_UNRESOLVED`.
3. The deadline: the AD-4 apply deadline is evaluated first and is unchanged; AD-2 means a v1 snapshot has none. A request already past its deadline becomes APPLY_EXPIRED and the call is refused `APPLY_EXPIRED`. Withdrawal never extends validity.
4. Otherwise: APPLY_FAILED → WITHDRAWN (terminal), with `withdrawn_at` and exactly one `COMMERCIAL_CHANGE_REQUEST_WITHDRAWN` event (`from_state: APPLY_FAILED`).
5. What is preserved: signatures, payload, checksum, chain, policy snapshot, attempts and the APPLY_FAILED events. None of them is written.
6. The slot: it is released by the WITHDRAWN commit, because the one-open rule counts `COMMERCIAL_OPEN_STATES` under the same policy lock.
7. Replay: a repeated withdrawal of a request withdrawn from APPLY_FAILED returns the same row and writes no event.

**One lock order.** `CommercialPolicyApplyService` now takes the policy lock before the row lock. The same order (policy, then row) is used by every policy write: create, draft edit, lazy expiry, apply and withdrawal. A retry, a withdrawal and a new activation request therefore serialize and cannot deadlock. Before this change the apply locked the row and then the policy, while the create locked the policy and then the rows.

**Guard.** Only the union file changed, `20261027000000_ccp_guard_union/migration.sql`:
- a labelled `[union block: CCP-ACC-1 …]` admitting POLICY_ACTIVATE APPLY_FAILED → WITHDRAWN;
- a CCP-ACC-1 record check: that transition needs `withdrawn_at`;
- a header line describing the block.

The mirror is `COMMERCIAL_ACC1_POLICY_WITHDRAW_TRANSITIONS` in `canTransitionFor`. No other action type gains a withdrawal from APPLY_FAILED.

Other DB objects:
- **State CHECK:** unchanged. WITHDRAWN is already admitted, and `submitted_check` allows a submitted WITHDRAWN row.
- **Constraint union:** unchanged (no application row).
- **`ccp-guard-union-compensating.sql`:** unchanged. A WITHDRAWN row is terminal under the superseded body too.

**API and UI.**
- **HTTP mapping** in `toAramoError`:
  - 403 `requester_no_longer_authorized`;
  - 409 `apply_in_progress`, `apply_unresolved`, `already_applied` and `apply_expired`.
- **Policy read:** `open_request.withdraw_actionable` (requester + APPLY_FAILED) in the governance service, the DTO and the OpenAPI schema; the withdraw operation's description is updated.
- **PolicyView:** "Withdraw…" appears only when `withdraw_actionable` is true. It opens the existing PLATFORM-UX-1 `ConfirmDialog` (Change box Apply failed → Withdrawn, danger tone, "Withdraw request"). Refusals are shown in the dialog with operator copy.
- **Design gap:** CCP-UI v1.0 has no withdrawal state; it is recorded for v1.1.

### ACC-1.2 Files

`git status --short -uall`: 22 paths, 21 modified + 1 new (counts this record). `git diff --shortstat` before this section: 20 files, 383 insertions, 17 deletions.

- **New:** `libs/subscription/src/tests/ccp-acc1-policy-withdraw.integration.spec.ts`
- **Backend:**
  - `libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/migration.sql`
  - `libs/subscription/src/lib/commercial/{commercial-change-request.ts, commercial-change-request.service.ts, commercial-policy-apply.service.ts, commercial-policy-governance.service.ts}`
  - `libs/subscription/src/index.ts`
- **platform-admin:**
  - `platform-commercial-change-request.controller.ts`
  - `dto/commercial-governance.dto.ts`
  - `openapi/platform.yaml`
- **Web:** `apps/platform-web/src/commercial-governance/{PolicyView.tsx, governance-api.ts, governance-errors.ts, governance.spec.tsx}`
- **Pact:** `pact/consumers/platform-web-consumer/src/platform-governance.consumer.test.ts` (+1 interaction; it reuses the existing provider state)
- **Tests re-based:** `ccp-a9-role-change.spec.ts` (A9-U-4, plus the new ACC-U-1), `ccp-b5-governance.integration.spec.ts` (B5-CREATE-1), `apps/platform-admin/src/tests/ccp-b5-governance-routes.integration.spec.ts` (B5-RI-ACTIVATE, plus the new ACC-1-RI)
- **Generated:** `doc/generated/repo-map.{files,coupling,projects}.json`; this record.

### ACC-1.3 Tests

All counts are exact. Docker was healthy. Results are the runs after the last source edit.

| Run | Result |
|---|---|
| `ccp-acc1-policy-withdraw.integration.spec.ts` (new) | **7 / 7** (tests listed below) |
| guard union (`ccp-guard-union.integration.spec.ts`) | **4 / 4**; GUARD-UNION-1: 4,200 probes |
| ACC-1 negative control: the ACC-1 branch removed from a copy, then restored by copy | GUARD-UNION-1 fails on exactly `POLICY_ACTIVATE/{NORMAL,EXCEPTION,MIGRATION} APPLY_FAILED -> WITHDRAWN: db=false ts=true`. 7 of the 11 tests in the two files fail. File restored byte-identical (`cmp`). |
| subscription, full incl. integration | 49 files, 745 tests: 744 passed, 1 failed (B5-CREATE-1's exact `open_request`, now with `withdraw_actionable`). Re-based and re-run: `ccp-b5-governance.integration.spec.ts` **13 / 13**. |
| subscription unit | 18 passed, 31 skipped files; 304 passed, 441 skipped. Includes ACC-U-1: only POLICY_ACTIVATE admits APPLY_FAILED → WITHDRAWN (any kind); none from APPROVED or APPLYING; WITHDRAWN is terminal. |
| platform-admin, full incl. integration | 38 files, 744 tests: 743 passed, 1 failed (B5-RI-ACTIVATE's exact `open_request`). Re-based and re-run: `ccp-b5-governance-routes.integration.spec.ts` **5 / 5**, including ACC-1-RI (below). |
| platform-web unit (full) | **47 / 47 files, 543 / 543**, including ACC-W-1…3: the Withdraw… button follows `withdraw_actionable` (requester only, APPLY_FAILED only); the ConfirmDialog Apply failed → Withdrawn posts …/withdraw and reloads; `apply_in_progress` / `already_applied` copy shown in the dialog |
| Pact consumer (`pact/pacts/platform-web-platform-admin.json` deleted first; `--maxWorkers=1`) | 169 / 169 tests; **170** interactions (+1: "a policy activation withdrawal refused for a non-requester") |
| Pact provider (platform-admin verifier) | **170 / 170** verified; 2 / 2 tests |
| B5 parity / axe / keyboard (`PW_E2E_PORT=4405`, file filters) | 30 / 30; 0 baselines modified |
| lint (`--skip-nx-cache`, 5 projects) | 0 errors; 0 warnings in the files ACC-1 touched |
| build, CI-simulated (`subscription platform-admin aramo-platform-web api sign-service`, `--skip-nx-cache`) | 5 projects + 77 dependency tasks succeeded; `dist` carries "Withdraw request" |
| `contract-parity:check` (temporary index) | 708 live routes (706 governed), 539 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified |
| `openapi:drift-check` / `orphan-scopes:check` + self-test / `error-codes:check` / `redocly lint` | ok (9 files) / ok / ok / ok / valid, 2 pre-existing warnings |
| `verify-vocabulary.sh` | exit 0 |
| `repo-map:generate` / `repo-map:check` | regenerated; ok |

**The 7 tests in `ccp-acc1-policy-withdraw.integration.spec.ts`:**
- **ACC-1-AUTH:** these callers are refused `NOT_REQUESTER`: the finance approver, the owner approver and another finance_admin. A service principal is refused `NOT_HUMAN`. A requester without finance_admin is refused `REQUESTER_NO_LONGER_AUTHORIZED`. Once the role is restored the requester withdraws: WITHDRAWN with `withdrawn_at`. Ten request columns are unchanged and the signatures are byte-identical. The single APPLY_FAILED event and exactly one WITHDRAWN event remain, and the target is still DRAFT. A retry is refused `NOT_APPROVED`, the guard refuses any transition out (terminal), and an APPROVED withdrawal is still `STATE_INVALID`.
- **ACC-1-REPLAY:** two concurrent withdrawals plus a third return the same row, with one event.
- **ACC-1-RECONCILE:** a committed activation (ACTIVE target with this request's evidence) is reconciled to APPLIED (attempts 2, `applied_at` set, APPLIED event with `reconciled`), with no withdrawal event and signatures unchanged. A repeat is refused `ALREADY_APPLIED` and writes no audit row.
- **ACC-1-INFLIGHT:** a held row lock gives `APPLY_IN_PROGRESS` after at least 3,000 ms, as does a held policy lock. An attempt with no failure record gives `APPLY_UNRESOLVED`. Nothing is written and the slot stays held.
- **ACC-1-SLOT:** a create is refused before the withdrawal and while the withdrawal cannot commit; it is admitted after the commit.
- **ACC-1-CONC:**
  - 4 rounds of retry ∥ withdrawal, in alternating start order, each ending in exactly one of APPLIED (one activation, target ACTIVE, no withdrawal event) or WITHDRAWN (no activation, target DRAFT, one event).
  - Then withdrawal ∥ a new activation request: at most one open request. A create that succeeds is ordered after the withdrawal commit; a refused one is `OPEN_REQUEST_EXISTS` and succeeds on retry.
- **ACC-1-AD2:** a v1 snapshot has no deadline (`applyDeadlineOf` is null) and is withdrawn 10,000 h later. Under a v2 snapshot the deadline is `approved_at` + 72 h, unchanged. At the deadline a withdrawal expires the request (APPLY_EXPIRED, one event, no WITHDRAWN).

**ACC-1-RI (HTTP), on the full chain:**
- the target is changed after approval, so the apply fails with 409 `apply_failed`;
- `open_request` reads `{APPLY_FAILED, apply_actionable: true, withdraw_actionable: true}` for the requester, and `withdraw_actionable` is false for the approver;
- owner and second finance_admin get 403 `not_requester`;
- the requester gets 200 WITHDRAWN; a repeat is 200 with the same `withdrawn_at` and still one event;
- the slot is released (`open_request` null; `latest_request` WITHDRAWN; a new activation gets 201).

**Not run:**
- the full `nx run api` (no apps/api change; CI runs it);
- the other Pact verifiers;
- the full PLATFORM-UX-1 visual suites.

### ACC-1.4 Typed divergences and decisions

| ID | Item | Disposition |
|---|---|---|
| TD-ACC1-1 | The existing withdraw route is extended; no new route. | Choice stated (coordinator brief). |
| TD-ACC1-2 | Reconcile-to-APPLIED commits the APPLIED transition and then **refuses** the withdrawal with 409 `already_applied` (`reconciled: true`) rather than returning 200 with an APPLIED body, so a withdrawal call never reports success for an applied request. | Fail-closed reading of "never withdraw". |
| TD-ACC1-3 | **CLOSED (2026-10-25, Lead follow-up).** The window between a rolled-back apply and its separately recorded failure (the "awaiting uncertain reconciliation" window) is removed. **Approach:** the policy apply records its failure IN the apply transaction, so the locks span both steps. The sequence: the attempt runs under `SAVEPOINT ccp_policy_apply_attempt`, taken after the policy lock, the row lock and every refusal check; on a fault it is `ROLLBACK TO SAVEPOINT` (the activation write and the queued deferred-trigger events are discarded); then `recordApplyFailureInTx` writes APPLY_FAILED and its event in the same transaction. The transaction-scoped policy advisory lock and the row lock are held from the attempt until the failure record commits. One interactive `$transaction` is one connection, so no session-level advisory lock and no Prisma connection-pool pinning is needed, and a crash leaves no durable marker to clean up (an uncommitted attempt rolls back with its counter). **Fallback:** only a failure of the transaction itself (its COMMIT, or a database fault before the savepoint) uses the separate `recordApplyFailure`. That path now takes the same policy lock, then the row, and with `evidence_when_unchanged` always writes the APPLY_FAILED row, even if a withdrawal or an expiry closed the request meanwhile (`state_unchanged: true`). A withdrawal therefore waits on the locks (bounded by 3,000 ms → `APPLY_IN_PROGRESS`) or sees the recorded failure; the attempt's failure event always exists. Evidence: ACC-1-GAP (see ACC-1.5). | Closed. |
| TD-ACC1-4 | A withdrawal past the apply deadline expires the request (APPLY_EXPIRED) instead of withdrawing it. Both are terminal and release the slot; the deadline is evaluated, never extended (AD-2/AD-4 unchanged). | Consistent with the lazy-expiry rule on every write. |
| TD-ACC1-5 | The policy apply now takes the policy lock before the row lock (lock-order fix). This is a behaviour-neutral change to B5-R's apply; it removes a possible deadlock between apply and create or expiry. | Needed for the serialization requirement. |
| TD-ACC1-6 | The Withdraw… dialog reuses the PLATFORM-UX-1 `ConfirmDialog`; CCP-UI v1.0 has no withdrawal design. | Design gap for CCP-UI v1.1. |
| TD-ACC1-7 | The guard admits APPLY_FAILED → WITHDRAWN for POLICY_ACTIVATE of any kind, matching the B5-R POLICY_ACTIVATE branch, which has no kind check; only NORMAL is ever created. | Mirror = guard (GUARD-UNION-1). |

### ACC-1.5 TD-ACC1-3 closure (Lead follow-up)

**Files** (in addition to ACC-1.2):
- `libs/subscription/src/lib/commercial/commercial-apply-records.ts`: the shared failure record is split into `recordApplyFailureInTx`, the in-transaction core used by the policy apply. The wrapper `recordApplyFailure` is unchanged for the A6 / A7 / A8 / B2 callers by default; it gains the opts `policy_lock` and `evidence_when_unchanged`.
- `libs/subscription/src/lib/commercial/commercial-policy-apply.service.ts`: savepoint attempt with the in-transaction failure record; the fallback uses the same locks; new fault point `before_failure_record`.
- `libs/subscription/src/tests/ccp-acc1-policy-withdraw.integration.spec.ts`: + ACC-1-GAP. The `failed()` fixture now faults only at `after_policy_write`.

**ACC-1-GAP** (two rounds, each pausing the failure record of a retry after its rollback):
- **Pause 4,500 ms** (longer than the lock timeout): a concurrent withdrawal is refused `APPLY_IN_PROGRESS` after at least 3,000 ms. The request stays APPLY_FAILED; a later withdrawal succeeds.
- **Pause 1,500 ms:** the withdrawal waits for the locks, then withdraws after the record.
- **Both rounds:** the APPLY_FAILED events are attempts `[1, 2]` and are ordered before the WITHDRAWN event.
- **The fallback path:** called on a WITHDRAWN request, it writes the failure row (`state_unchanged: true`, `request_state: WITHDRAWN`) and leaves the state unchanged.

**Negative control.** The service was copied aside and edited back to the old two-transaction behaviour: rollback, then the pause, then a separate failure transaction. ACC-1-GAP then fails: the failure attempts are `[1]` (the attempt-2 record is missing). The file was restored byte-identical (`cmp`).

| Re-run after the change | Result |
|---|---|
| ACC-1 + B5-R + B5 governance + guard-union specs (`ccp-acc1-policy-withdraw`, `ccp-b5r-apply-expiry`, `ccp-b5-governance`, `ccp-guard-union`) | **4 / 4 files, 32 / 32** (8 + 7 + 13 + 4) |
| subscription, full incl. integration | 49 files, 746 tests: 720 passed and 26 skipped, because `ccp-a5-plan-version.integration.spec.ts` failed in `beforeAll` with a testcontainers timeout ("Timed out after 10000ms while waiting for container ports to be bound to the host"), an infrastructure failure. Re-run alone: **26 / 26**. |
| Pact provider (platform-admin verifier) | **170 / 170** verified; 2 / 2 tests |
| platform-admin, full incl. integration (the shared failure-record refactor) | **38 / 38 files, 744 / 744** |
| lint `subscription` (`--skip-nx-cache`) | 0 errors; 0 warnings in the 3 touched files |
| `verify-vocabulary.sh` | exit 0 |
