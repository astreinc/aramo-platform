# CCP-B1 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.3 B1 row (`:110`).

| | |
|---|---|
| **Slice** | CCP-B1, Commercial rail group + Approvals inbox (platform-web UI) |
| **Worktree / baseline** | `.claude/worktrees/ccp-b1`, branch `wip/ccp-b1`, baseline `7f574fa5` (pre-execution record `doc/ccp/slices/CCP-B1-pre-execution.md`) |
| **Design input** | CCP-UI v1.0, `MANIFEST.sha256` 5 / 5 OK on 2026-10-25 (hashes pinned in the pre-execution record; equal to `doc/ccp/design-inputs.md:10-14`) |
| **Local commit SHAs** | pending (lead commits). Nothing is committed or pushed by the executor. |
| **HALT conditions hit** | None. No code contradicts the instruments. No component is promoted into `fe-foundation` (`libs/fe-foundation` byte-unchanged), no unpinned design change, no console path mutates commercial state (every act is an A3 route call). No backend, migration, route, scope or nx-edge change. |

## 1. Changes and proposed commit map

95 files: 71 new, 24 modified (`git status --short -uall`). `git diff --shortstat` over the modified files: 631 insertions, 40 deletions. Of the 71 new files, 40 are the CCP reference images and their mask files and 6 are the pinned design-reference copy.

| # | Proposed commit | Files |
|---|---|---|
| B1-0 | `CCP-B1: pre-execution check and the pinned CCP-UI v1.0 design reference` | `doc/ccp/slices/CCP-B1-pre-execution.md` (new); `doc/design-reference/ccp/CCP-UI-v1_0/` (6 files, byte-identical to the OneDrive release, `MANIFEST.sha256` included; vocabulary-exempt by `COMMON_GLOBS` `**/design-reference/**`) |
| B1-1 | `CCP-B1: NEW CCP components (CrStepper, ApprovalChain, EligibilityVerdict, BeforeAfterDiff, BootstrapBanner) and additive variants` | `apps/platform-web/src/components/`: `CrStepper.tsx`, `ApprovalChain.tsx`, `EligibilityVerdict.tsx`, `BeforeAfterDiff.tsx`, `BootstrapBanner.tsx`, `ccp-components.css`, `ccp-components.spec.tsx` (new); `AccessDenied.tsx` (optional `role` / `grants` / `footnote` / `variant`, `organization` optional), `ConfirmDialog.tsx` (`ccp` size), `DetailDrawer.tsx` (`variant="ccp"`), `EmptyState.tsx` (`xl`), `EnvironmentBar.tsx` (`commercial` context line), `index.ts`, `permissions.ts` (`COMMERCIAL_PERMISSIONS` + labels); `apps/platform-web/src/theme.css` (5 CCP tokens) |
| B1-2 | `CCP-B1: Approvals inbox and the change-request drawer over the A3/A9 routes` | `apps/platform-web/src/commercial/`: `commercial-api.ts`, `commercial-model.ts`, `commercial-errors.ts`, `ApprovalsInboxView.tsx`, `ChangeRequestDrawer.tsx`, `commercial.css`, `test-fixtures.ts`, `commercial-model.spec.ts`, `ApprovalsInboxView.spec.tsx` (new) |
| B1-3 | `CCP-B1: Commercial rail group, routes, in-shell Commercial access denied, placeholders` | `apps/platform-web/src/shell/nav.ts`, `nav-icons.tsx`, `PlatformShell.tsx`; `apps/platform-web/src/App.tsx`; `apps/platform-web/src/identity/identity.tsx` (the six role labels); `apps/platform-web/src/commercial/CommercialAccessDenied.tsx`, `CommercialPlaceholderView.tsx`, `commercial-visibility.spec.tsx` (new) |
| B1-4 | `CCP-B1: platform-web Pact consumer — the inbox call shapes` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts` |
| B1-5 | `CCP-B1: e2e — CCP visual parity (CCP-UI v1.0), axe, keyboard and 900px states` | `apps/platform-web/e2e/fixtures/commercial.ts`, `e2e/support/proto-ccp.ts`, `e2e/visual/states-ccp.ts`, `e2e/keyboard/ccp-journeys.spec.ts` (new); `e2e/fixtures/session.ts`, `e2e/support/build.ts`, `e2e/visual/{state-types,capture-reference,parity,states}.ts`, `e2e/visual/DIVERGENCES.md`; `e2e/visual/__screenshots__/ccp-*` (20 reference PNGs + 20 mask files, new) |
| B1-6 | `CCP-B1: acceptance evidence` + `CCP-B1: regenerate repo map` | `doc/ccp/slices/CCP-B1-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` |

**Unchanged:** every `libs/` source (`fe-foundation` included: R-3), every `apps/platform-admin` and `apps/api` source, `openapi/`, every migration, `pact/provider/` (no new provider state needed), `doc/ccp/decisions.md`, `doc/ccp/design-inputs.md`, the PLATFORM-UX-1 reference images (`__screenshots__` non-`ccp-*` files byte-unchanged).

**Merge hotspots with B2 (parallel):** `shell/nav.ts` (the Commercial group is one delimited block, `CCP-B1 … end CCP-B1`; B2 replaces the Catalog item's route target only if it moves), `App.tsx` (one delimited route block; B2 replaces the `/commercial/catalog` placeholder element), `components/index.ts`, `components/permissions.ts`, `e2e/visual/states.ts`, `e2e/fixtures/session.ts`, `DIVERGENCES.md`, the repo-map JSON. Re-run `npm run repo-map:generate` after the merge.

## 2. Screens (handoff §11 rows covered)

| Screen / state | Route | Built from | Data |
|---|---|---|---|
| Commercial rail group (Approvals, Subscriptions, Catalog, Contracts, Policy, Audit), between Documents and Platform | rail | handoff §2 | session scopes |
| Approvals inbox: tabs Waiting on me / All pending / Requested by me / History with count badges; columns Request, Tenant · product, Change (+ by · relative), Chain (step state), State, Expires (TTL, amber < 12 h), Policy; sort (pending by soonest expiry, rest newest first); per-tab empty states; skeleton | `/commercial/approvals` | §5.1 | `GET …/change-requests?limit=200`, `?eligible_for_me=true&limit=200`; `GET …/{id}` for pending, rejected, expired and withdrawn rows (chain progress); tenant names from `GET /platform/tenants` |
| Change-request drawer: facts (tenant · product, requested by, created, approval window, policy + chain fixed at creation + window), CrStepper, refusal alert, effect before → after, reason, evidence, approval chain with step state, Your eligibility (the 7 reasons inline), Who can sign (designed empty line), timeline; footer Approve / Reject… (disabled unless eligible, reason in the tooltip and the footnote), Submit for approval / Withdraw (requester) | `?request=<id>` | §5.2 | `GET …/{id}` (`steps[].caller`, `is_expired`, `chain_satisfiable`, approvals) |
| Approve confirmation (ConfirmDialog: Pending approval → Approved / "{next} step next", consequence) | drawer | lead brief; §5.10 | `POST …/{id}/approvals {step_index}` |
| Reject dialog (ConfirmDialog: Pending approval → Rejected, consequence, "Reason (required)", danger "Reject request") | drawer | §5.2, §5.10 | `POST …/{id}/reject {reason}` |
| Bootstrap banner (role="alert") + drawer 409 alert | inbox | §3.2 | `chain_satisfiable === false` on loaded pending requests; 409 `CCP_NOT_BOOTSTRAPPED` |
| In-shell Commercial access denied (super_admin deep link; a commercial role without the page scope) | every `/commercial/*` | §2 "Deep links"; R-5 | session scopes, `/platform/me` |
| Placeholders (designed disabled state) for Subscriptions, Catalog, Contracts, Policy, Audit | `/commercial/{page}` | R-13 | none |

## 3. Per-role visibility (6 roles + super_admin)

Item scopes (pre-execution C-1): Approvals and Policy `platform:approval:read`; Subscriptions and Contracts `platform:subscription:read`; Catalog `platform:catalog:read`; Audit `platform:commercial:audit:read`. Bundles: CCP A1 §4.1 (`libs/identity/prisma/seed.ts:3241-3297`). Proven by `commercial-visibility.spec.tsx` (model + rendered rail + route gate, 30 tests).

| Commercial item | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| Approvals | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Subscriptions | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| Catalog | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Contracts | ✓ | ✓ | ✓ | — | ✓ | ✓ | — |
| Policy | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Audit | ✓ | ✓ | — | — | — | ✓ | — |
| **Commercial group shown** | yes | yes | yes | yes | yes | yes | **no** |
| Deep link to a hidden item | — | — | in-shell denied ("Your roles don't include access to this page.") | in-shell denied | in-shell denied | — | in-shell denied naming the six roles (all 6 routes tested) |

Approve / Reject in the drawer (UI gate = the A3 engine's live per-step verdict for the caller; backend = the A3 matrix, `CCP-A3-acceptance.md` §7):

| Situation | UI | Backend (route) |
|---|---|---|
| Caller's verdict OK (e.g. finance_admin on a Finance step) | Approve and Reject… enabled | 201 / 200 |
| Any of the 7 refusals | Approve and Reject… disabled; "You can't approve: {label}" + why inline; footnote "{label}." | 409 `COMMERCIAL_APPROVAL_REFUSED` `details.refusal` |
| Not pending (approved, applied, rejected, expired, withdrawn) | no Approve / Reject… at all | 409 `NOT_PENDING` |
| super_admin | never reaches the drawer (in-shell denied) | 403 `INSUFFICIENT_PERMISSIONS` `missing_scopes [platform:approval:read]` |
| The UI allowed it but the engine refuses (stale verdict, NC-1/NC-4) | the refusal shows inline: "Approval refused. {label}. {why} (409 …)" | 409 (proven in A3 / A10 contracts) |

## 4. Mandatory tests (B1 row, common B set, brief) → evidence

| Mandatory test | Where | Result |
|---|---|---|
| An ineligible user sees no approve action | `ApprovalsInboxView.spec.tsx` (5 refusals × disabled Approve/Reject…, EXPIRED, NOT_PENDING: no action); keyboard KC3 (disabled buttons are not tab stops) | pass |
| … and the backend refuses it (UI path through the route) | `ApprovalsInboxView.spec.tsx` "approve goes through the route … 409" (the client is called with `(id, 0)`; the engine's refusal renders inline); keyboard KC4 (the fixture route answers 409; the drawer shows it); the real backend refusal for the same call shape: A3 `A3-RI-APPROVE`, A10 contracts (`SELF_APPROVAL`, `STEP_SCOPE_MISSING`), verified against the real platform-admin AppModule (§6) | pass |
| 7 eligibility reasons inline; the combined Finance + Owner person refused the second step ("You already approved a step") | `commercial-model.spec.ts` (all 7 + OK); `ApprovalsInboxView.spec.tsx` (USER_ALREADY_APPROVED with the signer = the caller) | pass |
| Bootstrap banner and 409 when not bootstrapped | `ApprovalsInboxView.spec.tsx` (banner from `chain_satisfiable`, banner + drawer alert from a 409 `CCP_NOT_BOOTSTRAPPED`); visual `ccp-approvals-bootstrap` | pass |
| Per-role visibility, 6 roles + super_admin | `commercial-visibility.spec.tsx` | pass |
| In-shell AccessDenied naming the six roles (handoff acceptance 1) | `commercial-visibility.spec.tsx` (super_admin × 6 routes); visual `ccp-denied-super-admin` | pass |
| Pixel parity at 1440 and 900 against the CCP prototype | `e2e/visual` CCP states (§5) | pass: 20 / 20 comparisons (10 states × 1440 and 900), §5 |
| axe: 0 serious / critical apart from the documented design-colour debt | `e2e/a11y` CCP states | pass: 10 / 10 states; 0 serious / critical outside `color-contrast` (the design's faint ink, §6) |
| Keyboard journey for approve / reject | `e2e/keyboard/ccp-journeys.spec.ts` KC1–KC5 | pass: 5 / 5 |
| Pact consumer extended for the new call shapes; provider run | `pact/consumers/platform-web-consumer` + `pact/provider/src/verify-platform-admin.ts` | consumer: **35 / 35** (3 new interactions). **Provider: NOT RUN — blocked**: the Docker daemon on this host answered `500 Internal Server Error` to every API call from about 08:50 to 09:41 (the first attempt failed with testcontainers "Could not find a working container runtime strategy"); see §6. To run before the push |
| Regression: tenant role catalog, super_admin bundle, Sign allowance, Stripe self-service | not touched (UI-only slice; no `libs/` or backend change); the super_admin console is unchanged (rail, routes, tenant operations; `commercial-visibility.spec.tsx` "super_admin tenant operations are unchanged"; the PLATFORM-UX-1 visual states, §5) | pass |

## 5. Parity record (PLATFORM-UX-1 §3 method)

Reference = `Commercial Control Plane v1.0.dc.html` rendered on `http://proto-ccp.test/` with the prototype-only elements stripped (`e2e/support/proto-ccp.ts`); build = the app on `e2e/fixtures/commercial.ts` at the prototype clock. Settings unchanged (`threshold 0.2`, `maxDiffPixels 25`). Masks only for the typed divergences DV-C1…DV-C8 (`e2e/visual/DIVERGENCES.md`).

| State | Persona | 1440 | 900 | Masks |
|---|---|---|---|---|
| `ccp-approvals` (Waiting on me) | finance_admin | pass | pass | DV-C1, DV-C2, DV-C3 |
| `ccp-approvals-pending` (All pending) | finance_admin | pass | pass | DV-C1, DV-C2, DV-C3 |
| `ccp-approvals-empty` | finance_admin | pass | pass | DV-C1, DV-C2 |
| `ccp-approvals-history-empty` | finance_admin | pass | pass | DV-C1, DV-C2 |
| `ccp-approvals-loading` (skeleton) | finance_admin | pass | pass | DV-C1, DV-C2 |
| `ccp-approvals-bootstrap` | finance_admin | pass | pass | DV-C1, DV-C2, DV-C3, DV-C8 |
| `ccp-drawer` (CR-1042, eligible) | finance_admin | pass | pass | DV-C1, DV-C3, DV-C4, DV-C5 |
| `ccp-dialog-reject` | finance_admin | pass | pass | DV-C1, DV-C3, DV-C4, DV-C5, DV-C7 |
| `ccp-denied-super-admin` | super_admin | pass | pass | DV-C1, DV-C2, DV-C6 |
| `ccp-rail-group` (element: the Commercial group) | finance_admin | pass | pass | none |

Compared unmasked in these states: the environment bar (the Commercial context line and identity), the top bar (breadcrumb Commercial / Approvals, PLATFORM marker, account avatar), the page header and intro, the tab strip with its four count badges, the card frame, the skeleton, every empty state, the bootstrap banner's text, the drawer header title, the drawer facts Tenant · product / Created / Approval window, the request-state stepper, the access-denied card's pill, title, why line and the Signed in as / Current role / Grants access rows, and the whole Commercial rail group (six items, labels, glyphs, active item).

## 6. Tests and gates run and not run

All counts are exact. The host was shared with parallel CCP slices (load average 20 to 68 during the runs).

**Run:**

| Run | Command | Result |
|---|---|---|
| platform-web unit (full) | `vitest run --root apps/platform-web --maxWorkers=2` | **35 / 35 files, 378 / 378 tests** (B1 adds 4 files, 84 tests: `commercial-model.spec.ts` 26, `ApprovalsInboxView.spec.tsx` 17, `commercial-visibility.spec.tsx` 30, `ccp-components.spec.tsx` 11). An earlier run at load ≈ 45–68 had 4 tests time out at vitest's 5 s default in specs B1 does not touch (`PersonalViews`, `TenantDetailView`, `TemplateStudio` × 2); the rerun is the clean one above |
| lint | `nx run aramo-platform-web:lint --skip-nx-cache` | 0 errors, 0 warnings |
| build | `nx run aramo-platform-web:build --skip-nx-cache` | success (the app + 25 dependency tasks) |
| typecheck | `tsc -p apps/platform-web/tsconfig.app.json --noEmit`; `tsc -p apps/platform-web/e2e/tsconfig.json --noEmit` | 0 errors each |
| CCP references | `PW_CAPTURE_REFERENCE=1 PW_STATE=ccp- playwright test --project=visual capture-reference` | 20 / 20 captured from the pinned file |
| CCP visual parity | `PW_STATE=ccp- playwright test --project=visual parity` | **20 / 20** (10 states × 1440, 900), §5. Re-run on the final code (after the TD-B1-13 focus fix), own port 4392: CCP parity + axe + 900px **42 / 42** (4 axe states first hit the 60 s test timeout at load ≈ 58 and passed on a serial rerun) |
| CCP axe | `PW_STATE=ccp- playwright test --project=a11y` | **10 / 10**; serious findings only `color-contrast` on the design's faint ink `#93A0A8` (the ⌘K placeholder and key, the table heads, the access-denied footnote): the documented design-colour debt (`DIVERGENCES.md` "Accessibility conflicts"); 0 other serious or critical |
| CCP 900px | `PW_STATE=ccp- playwright test --project=responsive` | **10 / 10** + the 2 rail / Studio checks: no page scroll, the inbox table scrolls in its card |
| CCP keyboard | `playwright test --project=keyboard ccp-journeys` | **5 / 5** (KC1 approve, KC2 reject, KC3 ineligible, KC4 backend refusal, KC5 Escape and focus return) |
| Full e2e regression (all states, 4 projects) | `playwright test --project=visual --project=a11y --project=keyboard --project=responsive` | 687 tests: **461 passed, 4 failed, 222 skipped** (the skipped are the on-demand reference captures). Failures: `studio-preview-zoom @900` (61 px) and `studio-compare-changes @1440` (66 px) fail identically at the baseline `7f574fa5` (checked in a temporary detached worktree, removed afterwards): pre-existing glyph-edge anti-aliasing on this host, not B1. `axe studio-var-popover` and keyboard `J7` failed under load and **pass** on an isolated rerun |
| Pact consumer | `vitest run --root pact/consumers/platform-web-consumer` | 1 file, **35 / 35**; pact `platform-web-platform-admin.json` written with **35 interactions** (A10: 32; B1 adds 3) |
| Pact provider | `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts` | **not run (blocked by the host's Docker daemon)**. Attempts: one run was clobbered by a parallel slice writing the same scratchpad log name and was stopped (only this slice's process); the rerun failed at container start (`Could not find a working container runtime strategy`); `docker info` / `docker ps` then returned HTTP 500 on every check from about 08:50 to 09:41. Docker was not restarted (shared by other sessions). Earlier, `npm run prisma:generate` was needed in this worktree (exit 0). **For the lead:** run `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts` once Docker is healthy; expected 2 / 2 tests and 35 / 35 interactions. The 3 new interactions use the existing state `a pending change request exists`, and their bodies are what the real controller returns for it (A10 §3: `GET` list as finance_admin, `POST approvals` as finance_admin → APPROVED with `apply: null`) |
| vocabulary | `bash scripts/verify-vocabulary.sh` | exit 0; Tier 1, Tier 2, front-door clean |
| repo map | `npm run repo-map:generate` / `repo-map:check` under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 71 new paths (real index untouched) | generated (`doc/generated/repo-map.{files,coupling,projects}.json`: 3 files, +253 lines); `repo-map:check ok`, self-test ok. Re-run `npm run repo-map:generate` if the staged set differs |
| design input | `shasum -a 256 -c MANIFEST.sha256` (OneDrive release and the committed copy) | 5 / 5 OK, both |

**Contract counts (kept distinct, CLAUDE.md):** platform-web → platform-admin consumer contract: **35 interactions** (31 + 3 = 34 on the 8 CCP routes, 1 on `GET /platform/me`). The 3 B1 interactions: `GET …/change-requests?limit=200` (finance_admin, every state), `GET …/change-requests?eligible_for_me=true&limit=200` (finance_admin), `POST …/{id}/approvals {step_index: 0}` without a comment (finance_admin, 201). No new route, so `GATE_ROUTES` and the coverage gate are unchanged; no new provider state (all 3 use `a pending change request exists`).

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite and the platform-admin integration suite: B1 changes no `apps/` backend or `libs/` source (CI runs them; ruling A0-C16).
- CI: not pushed (lead commits).


## 7. Typed divergences

| ID | Divergence | Cause / disposition |
|---|---|---|
| TD-B1-1 | Rail items are filtered by each item's READ scope; the handoff §2 table shows "Commercial (all)" for every role. Result: catalog_manager has no Subscriptions / Contracts, and commercial_ops, catalog_manager, support_admin have no Audit | The brief; the A1 catalog (an item a role can't read would open a 403 page). Contracts and Policy have no scope of their own: provisional `subscription:read` / `approval:read` (B4 / B5 may re-point) |
| TD-B1-2 | The Dashboard item stays visible to the commercial roles (handoff §2 "assumption": hidden) | Pre-execution C-2: its gate `platform:tenant:read` is held by the six roles (A1 R-3: 200). For the PO; visual DV-C1 |
| TD-B1-3 | Platform admins stays hidden for platform_owner and read_only_auditor (handoff §2) | B5's page (handoff §5.8, §11) |
| TD-B1-4 | Access-denied card keeps R-5's Missing row and Sign out and says "Back to dashboard" (design: "Back to tenants", no Sign out) | PLATFORM-UX-1 R-5 via A1-4 outranks the design file; DV-C6 |
| TD-B1-5 | Approve has a ConfirmDialog (from → to + consequence); the design approves on click. The reject dialog is the ConfirmDialog with the Change box | The lead's brief; DV-C7 |
| TD-B1-6 | Data the A3/A9 routes do not carry (R-13), shown as designed empty values: requester / approver names and roles (ids; the caller named from `/platform/me`), the human CR number (UUID, short in the table), the policy version number (version id), the effect's before side ("—"), Evidence ("—"), the per-admin roster ("Who can sign": designed empty line), the "older version" flag and note | Backend follow-ups for the lead: names on the change-request DTO, the policy version number (and the active one), a roster/verdict read, evidence. DV-C3…DV-C5 |
| TD-B1-7 | The bootstrap banner names the chains of the loaded pending requests with `chain_satisfiable === false`, plus chains refused by a 409; it is shown on the Approvals page only, and has no "View chains" link | No roster-wide fulfillability read on the A3/A9 routes; the link's target is B5's page; DV-C8 |
| TD-B1-8 | Not built in B1 although handoff §11 maps them to B1: ⌘K request results; the Apply panel, Retry apply and "Sent to Stripe" | ⌘K is not in the brief's "In" list; apply sides need A6 / C1 (not on this branch). The role-change `apply` result (A9) is shown after a completing approval |
| TD-B1-9 | The inbox reads one page of 200 (route maximum) and shows "Showing the 200 most recent change requests." when `next_cursor` is set; detail reads (≤ 6 concurrent) for pending, rejected, expired and withdrawn rows give the chain progress | The list DTO has no approvals; open sets are small (Q14, 72 h) |
| TD-B1-10 | Copy: NOT_HUMAN reads "Approval steps are signed only by attested people. Service accounts can't sign them." (design: "Service accounts can't sign approval steps."): the engine's NOT_HUMAN also covers an unattested human (D9) | Accuracy over the sample copy |
| TD-B1-11 | Action labels for the 14 A3 actions follow the design's nearest type (SUBSCRIPTION_CHANGE "Plan change", SUBSCRIPTION_END "Cancel subscription", CONVERSION "Subscription conversion", …) | The design's types are not the engine's; real values win |
| TD-B1-12 | The six commercial role keys get the handoff §3 labels in `identity.tsx` (env bar, rail footer, account menu). Side effect: the PLATFORM-UX-1 auditor fixture persona now reads "Read-only auditor", as its design does (DV-03 masks kept) | Handoff §3 labels |
| TD-B1-13 | Focus after an action: when Approve / Reject / Submit / Withdraw changes the drawer footer, focus moves to the drawer body (never `<body>`); Escape then dismisses the topmost layer first (the toast while it shows), then the drawer | WCAG 2.4.3; found by the keyboard journeys |
| TD-B1-14 | The e2e harness gained a CCP loader (`proto-ccp.ts`), a `clock` option on `openBuild`, a `ccp` file kind and element-level states; the existing states' behaviour is unchanged | Brief: extend the existing harness |
| TD-B1-15 | The new list interactions in the Pact consumer name only the fields every state carries (a full page mixes states; nullable timestamps are contracted per state by the A10 interactions) | Pact V3 has no "nullable or ISO" matcher |
| TD-B1-16 | Tenant names come from the existing `GET /platform/tenants` (non-CCP, not contracted; A10 TD-A10-7) | Every commercial role holds `platform:tenant:read` |

## 8. Recovery and rollback

UI revert (PBD §5.3 B row): revert the B1 commits. No data, migration, route or backend changes, so nothing deployed depends on them. The Pact consumer change is test-only.

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added. The project write hook flagged one Tier-2 token in an e2e fixture string during authoring (`e2e/fixtures/commercial.ts`); it was reworded before any gate run. The pinned design-reference copy is excluded by `COMMON_GLOBS` (`**/design-reference/**`).
