# CCP-B6 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.3 B6 row ("**In:** extensions and escalations. **Out:** out-of-bounds applies"; mandatory test "A breach escalates and never applies"; evidence "Parity; bound tests"). Governing inputs: PLATFORM-UX-1 Amendment A1 (A1-2, A1-4, A1-4a, A1-5), PLATFORM-UX-1 directive §3 (pixel parity), CCP-UI v1.0 (pinned in `doc/ccp/slices/CCP-B6-pre-execution.md`), `doc/ccp/decisions.md` Q7, and the lead-relayed rulings TD-A8-5, TD-A8-6, TD-B2-3 and TD-B1-2.

| | |
|---|---|
| **Slice** | CCP-B6: support workflows (extensions and escalations), console UI |
| **Branch / baseline** | `wip/ccp-b6` at `8bcf09fb` (A8 on A1–A6, A9, A10). Pre-execution record: `doc/ccp/slices/CCP-B6-pre-execution.md` |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. The changes are staged (the repo-map gate reads the index). |
| **HALT conditions hit** | **None.** No component promoted to `fe-foundation` (no edit under `libs/fe-foundation`). No console action mutates commercial state directly: the console calls the A8 bounded route (the server decides; a breach escalates and never applies) or creates and submits a governed change request; Apply is the A6 route, offered only to the requester. The pinned design is unchanged (MANIFEST 5 / 5 OK). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| B6-0 | `CCP-B6: pre-execution check` | `doc/ccp/slices/CCP-B6-pre-execution.md` (new) |
| B6-1 | `CCP-B6: support-extension list read adds the open base rows, the ACTIVE policy clause and each overlay's recorded context (additive, read only)` | `libs/subscription/src/lib/commercial/support-extension.service.ts` (`overview`), `libs/subscription/src/index.ts`; `apps/platform-admin/src/app/platform/platform-commercial-support-extension.controller.ts`, `dto/support-extension.dto.ts`; `openapi/platform.yaml`; tests `apps/platform-admin/src/tests/ccp-a8-support-extension-authorization.spec.ts`, `ccp-a8-support-extension-routes.integration.spec.ts` |
| B6-2 | `CCP-B6: Pact — the screen read, the removal request, the requester's apply (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| B6-3 | `CCP-B6: ExceptionOverlay + SupportRequestDialog (NEW, platform-web components) and tokens` | new: `apps/platform-web/src/components/ExceptionOverlay.tsx`, `SupportRequestDialog.tsx`, `support-components.css`, `support-components.spec.tsx`; modified: `components/index.ts`, `src/theme.css` |
| B6-4 | `CCP-B6: the support-extension screen (/commercial/support-extensions): request, escalation, removal, requester-only apply` | new: `apps/platform-web/src/commercial/support-extensions/{SupportExtensionsView.tsx, SupportExtensionDialogs.tsx, support-extension-api.ts, support-extension-model.ts, support-extension-scopes.ts, support-extensions.css, support-extension-test-data.ts, SupportExtensionsView.spec.tsx, support-extension-model.spec.ts}`; modified: `src/App.tsx` |
| B6-5 | `CCP-B6: CCP visual harness (adopted byte-identical from CCP-B1) + element-relative masks` | new: `apps/platform-web/e2e/support/proto-ccp.ts`, `doc/design-reference/ccp/CCP-UI-v1_0/**` (6 files, MANIFEST 5 / 5 OK); modified: `e2e/fixtures/session.ts`, `e2e/support/build.ts`, `e2e/visual/state-types.ts`, `e2e/visual/parity.spec.ts`, `e2e/visual/capture-reference.spec.ts` |
| B6-6 | `CCP-B6: visual parity (8 baselines), axe, keyboard and 900px for the support workflow` | new: `e2e/fixtures/ccp-support.ts`, `e2e/visual/states-ccp-support.ts`, `e2e/keyboard/ccp-support-journeys.spec.ts`, 16 files under `e2e/visual/__screenshots__/ccp-sx-*`; modified: `e2e/visual/states.ts`, `e2e/visual/DIVERGENCES.md` |
| B6-7 | `CCP-B6: acceptance evidence` + `CCP-B6: regenerate repo map` | `doc/ccp/slices/CCP-B6-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **41 new files, 22 modified files (63 paths)**, of which 16 are visual baselines / mask files and 6 are the pinned design-reference copy. **Unchanged:** every migration; `pact/provider/src/verify-api.ts` (no apps/api returned shape changes); the shell, the rail, `nav.ts`, `PlatformShell`, `AccessDenied`, `permissions.ts` (B1's); every PLATFORM-UX-1 baseline (`git status` shows only `ccp-sx-*` under `__screenshots__`).

## 2. What was built

**Route.** `/commercial/support-extensions?tenant=<uuid>`, gate `platform:subscription:read` (the list route's scope), through the existing in-shell `gate()` (TD-B6-3). **For B1 to link:** a Commercial rail item "Support extensions" → `/commercial/support-extensions`, gated on `platform:subscription:read` (held by platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; not by catalog_manager or super_admin). The handoff §2 rail has six items and no such entry (TD-B6-1); the alternative is that B3 mounts the same components on Tenant › Commercial.

**Screen** (`SupportExtensionsView.tsx`), composed only of pinned §5.9 elements: the Aramo Sign product card (source badge "Managed in Stripe" / "MANUAL · contract", the "Extension · exception" flag pill of §5.3, the status fact with its grace line, "No open base subscription."), one `ExceptionOverlay` per active overlay, the open-request strip ("Open request {ref} · Support extension · pending approval. Other requests on this product wait until it closes.", the reference links to `/commercial/approvals?request=<uuid>`), the action with its tooltip and domain reason, and the §2 view-only note verbatim.

**Dialogs** (`SupportExtensionDialogs.tsx` on `SupportRequestDialog`): the §5.9 support extension dialog (days, init 7, max 60; reason; the clause help line; the live preview box `role="status"`: green "Within bounds — applies now as an exception, with zero approvals" with actor, roles, clause, uses n → n+1, cumulative with cap, "Recorded in audit with the exception flag", commit **Apply extension (exception)**; amber "Out of bounds — escalates to approval (Finance)" with the first breach line, the Finance chain strip and **Submit for approval**). ONE call, `POST /support-extensions`; the server's outcome wins (APPLIED → the pinned toast; ESCALATED → a notice with the server's breach line and the request link). The removal dialog creates a `SUPPORT_EXTENSION` change request with `operation: REMOVE` and submits it to Finance (TD-A8-5).

**Apply (TD-B2-3).** Shown only when the request is APPROVED or APPLY_FAILED, `requested_by` is the signed-in user, **and** the detail read says `apply_actionable === true` (A6-R; not in this base, so it is coded against and mocked). It calls `POST /change-requests/{id}/apply`.

**Backend (minimal, additive, read only; TD-B6-2).** `GET /platform/commercial/support-extensions` now also returns `subscriptions` (the open base rows: the POST must name one, and no platform route returned its id), `policy` (the ACTIVE version number, the four extension clause values and the approval window; `null` when no valid policy) and a per-extension `context` (policy version number, the clause and counters recorded at apply, the applying actor's role snapshot from the apply audit event). Same scope, same consumer, no migration, no write. `SupportExtensionService.list` is unchanged; `overview` composes it.

## 3. Per-role visibility (6 roles + super_admin)

| Role | Route | Request extension | Request removal | Apply own approved request | Notes |
|---|---|---|---|---|---|
| support_admin | screen | **yes** | **yes** | **yes** (when `apply_actionable`) | no view-only note |
| finance_admin | screen, view only | disabled ("Needs the Support admin role.") | hidden | no | the pending escalation links to the Approvals drawer, where Finance approves (B1) |
| platform_owner | screen, view only | disabled | hidden | no | view-only note |
| commercial_ops | screen, view only | disabled | hidden | no | view-only note |
| read_only_auditor | screen, view only | disabled | hidden | no | view-only note |
| catalog_manager | in-shell access denied (`platform:subscription:read`) | — | — | — | list route never called |
| super_admin | in-shell access denied (`platform:subscription:read`) | — | — | — | list route never called |

Backend refusal for each ineligible role (PBD §5.3 common test): the A8 route matrix (`CCP-A8-acceptance.md` §4) is unchanged and re-run: `POST` 201 only for support_admin, 403 for the other six; `GET` 200 for five roles, 403 for catalog_manager and super_admin; `…/apply` 200 only for the requester scope. The UI tests above (B6-V-*) pair with these.

## 4. Tests run and not run

| Suite | Result |
|---|---|
| platform-web unit (full, `--maxWorkers=2`) | **34 / 34 files, 321 / 321 tests** (run 2). Run 1: 320 / 321, the unrelated `ProvisionTenantView.spec.tsx` "walks the three steps" timed out under host load; it passed alone (10 / 10) and in run 2 (TD-B6-20) |
| B6 unit specs | `SupportExtensionsView.spec.tsx` **16 / 16** (B6-V-SUPPORT; B6-V-VIEW × 4; B6-V-DENIED × 2; B6-F-IN, B6-F-ESC, B6-F-REMOVE, B6-F-APPLY, B6-F-APPLY-NOT, B6-F-APPLY-OTHER, B6-F-FINANCE, B6-F-NOSUB, B6-F-PICK); `support-extension-model.spec.ts` **8 / 8**; `support-components.spec.tsx` **3 / 3** |
| **Bound tests** (preview mirror of the A8 bound) | B6-M-LEN (14 in, 15 → LENGTH), B6-M-FREQ (90 d − 1 ms → FREQUENCY; exactly 90 d aged out, half-open), B6-M-CUM (30 in, 31 → CUMULATIVE; removed overlays count, TD-A8-4), B6-M-ELIG (not PAST_DUE → ELIGIBILITY), B6-M-NONE (no clause → no preview, fail closed), B6-M-ORDER |
| **A breach escalates and never applies** | UI: B6-F-ESC (one POST, ESCALATED, no overlay, the slot held, no Apply for a pending request). Server: A8-ESC-* (21 / 21 below) |
| platform-web lint (`nx run aramo-platform-web:lint`) | **pass** (0 errors, 0 warnings in the target). ESLint on the changed e2e / pact / platform-admin / subscription files: 0 errors in B6 code; `parity.spec.ts` and `capture-reference.spec.ts` carry 4 pre-existing `import-x/order` errors at the baseline (e2e is outside the lint target; TD-B6-19) |
| build `nx run-many -t build -p aramo-platform-web subscription platform-admin --skip-nx-cache` | **3 projects + 30 dependency tasks succeeded**; `dist/libs/subscription/.../support-extension.service.d.ts` exports `overview`; the platform-web bundle contains "Support extensions" (HEAD markers checked) |
| platform-admin (full, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`) | **23 / 23 files, 490 / 490 tests** (A8 baseline 488; +2: B6-RT-list, B6-RI-GET) |
| A8 route specs | authorization **34 / 34** (33 + B6-RT-list), routes integration (real Postgres) **5 / 5** (4 + B6-RI-GET: base rows, policy clause, bounded context from the chain basis + apply-event roles, escalated context from the escalation event; the read writes nothing) |
| subscription A8 specs (`ARAMO_RUN_INTEGRATION=1`) | `ccp-a8-support-extension.spec.ts` + `.integration.spec.ts` **55 / 55** |
| Pact consumer `platform-web-consumer` (serial) | **49 / 49 interactions** (A8: 46; +3: the screen read by support_admin, the removal request, the requester's apply of an approved escalation) |
| Pact provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests**; **49 / 49 interactions verified** (98 status + body checks). New state: `an approved escalated support extension exists`; `a support extension has been applied` now returns `{ extensionId }` |
| Consumer count vs provider-verified count (A10 rule) | platform-web → platform-admin: 49 consumer interactions; 49 verified by `verify-platform-admin` |
| Visual parity (`--project=visual`, `PW_E2E_PORT=4440`) | **8 / 8** (4 states × 1440 / 900), §5 |
| axe (`--project=a11y`) | **4 / 4** B6 states: 0 serious, 0 critical |
| keyboard (`--project=keyboard`) | **3 / 3** (JB6-1 dialog by keyboard, breach preview, Escape returns focus; JB6-2 in-bound exception by keyboard, one POST; JB6-3 the escalation link is reachable and focused) |
| 900px (`--project=responsive`) | **4 / 4** B6 states + the 2 global checks: no page scroll |
| `bash scripts/verify-vocabulary.sh` | **OK**: Tier 1, Tier 2, front-door clean. No exemption touched |
| `openapi:drift-check` / `redocly lint openapi/platform.yaml` | ok (9 files) / valid, 2 warnings (baseline count) |
| `contract-parity:check` | 680 live routes (678 governed), 511 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (unchanged: no route added) |
| `orphan-scopes:check` | ok |
| `repo-map:generate` → `repo-map:check` | staged, regenerated (3 files), ok |
| **Not run** | the full `nx run api` (no apps/api change; instructed targeted only); the PLATFORM-UX-1 / B1 visual states (not re-captured; the harness change applies only to element states with masks, and B1's one element state has none); `verify.ts` / `verify-api.ts` / `verify-sign.ts` / `verify-ti.ts` providers (no surface they verify changed) |

**Negative controls (§6.1).** B6 introduces no approval surface: approval is B1's drawer and the A3 engine. Self-approval, NC-1…NC-5 and one-person-two-roles stay covered by A3/A8 (A8-ARCH-3 self-approval on removal, A8-ESC-NC5-1). The B6 UI never offers Apply to a non-requester (B6-F-APPLY-OTHER) or an approver (B6-F-FINANCE).

**Regression obligations.** Sign allowance semantics and ATS-triggered consumption: no allowance code changed (the backend change is a read). Tenant role catalog and the super_admin bundle: unchanged (super_admin refused, B6-V-DENIED). Stripe self-service: no webhook or checkout code changed.

## 5. Parity record (CCP-UI v1.0, 1440×900 and 900×900)

Method: PLATFORM-UX-1 §3.3 with the CCP harness of CCP-B1 (`support/proto-ccp.ts`, the design file served on a synthetic origin, prototype-only elements stripped). B1 owns the shell and rail, not in this base, so **every B6 state is element-level** (crop parity to the dialog, the overlay or the note). Masks are the sanctioned divergences in `e2e/visual/DIVERGENCES.md` (DV-B6-*), stored element-relative.

| State | Design source | Build | 1440 | 900 | Masks |
|---|---|---|---|---|---|
| `ccp-sx-dialog-in-bounds` | `dlgExt` on Fernhill (PAST_DUE, no prior), days 7 | Fernhill, support_admin | pass | pass | DV-B6-2 (help line; preview "Policy clause" line) |
| `ccp-sx-dialog-escalates` | `dlgExt` + `setVal('days','20')` | same, 20 typed | pass | pass | DV-B6-2 (help line); AA-B6-1 (320 px; measured 293: two captions 1px apart, every box identical) |
| `ccp-sx-overlay` | Oakridge EXT-0042 overlay card | Oakridge, support_admin | pass | pass | DV-B6-3 (reference), DV-B6-2 (clause value) |
| `ccp-sx-viewonly` | Tenant › Commercial view-only note, finance persona | finance_admin | pass | pass | none |

**8 / 8 pass**; 8 baselines + 8 mask files committed under `e2e/visual/__screenshots__/ccp-sx-*`. No PLATFORM-UX-1 baseline modified. Not compared (no design counterpart): the page frame, the removal dialog, the Apply button, the escalation notice, the empty state and the earlier-extensions table.

## 6. Recovery and rollback

UI revert of B6-3…B6-6 (no commercial data is changed by B6). Backend: revert B6-1/B6-2; the list route returns to `{ extensions }` (consumers that ignore the extra fields are unaffected). No migration, so no compensating SQL.

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-B6-1** | Placement | The design puts the support extension on Tenant › Commercial (B3, not built). B6 is a routed view `/commercial/support-extensions?tenant=` composed of the pinned elements; its frame (H1 "Support extensions", intro, tenant select, "Choose a tenant" empty state, earlier-extensions table) is unpinned. The handoff §2 rail has no "Support extensions" item | **Lead:** B1 links the route (rail item + `platform:subscription:read`), or B3 mounts the components on the tab and the route is dropped |
| **TD-B6-2** | Backend | Additive read on `GET /support-extensions` (`subscriptions`, `policy`, `context`): without it the POST cannot name the row and the preview has no clause. OpenAPI widened; Pact +3 interactions, +1 provider state; verified 49 / 49 | Reported (minimal; no correction-1 trigger) |
| TD-B6-3 | Merge | Route gated through the existing `gate()` / `PlatformAccessDenied` (B1's `commercialGate` and commercial AccessDenied card are not in the base); the "Missing" row shows the raw code until B1's `PERMISSION_LABEL` entry lands | Lead swaps to `commercialGate` at merge |
| **TD-B6-4** | Design gap | Removal (TD-A8-5) has no design: the dialog follows §5.10 (danger tone, Finance chain strip, Reason*), and "Request removal…" sits under each active overlay | For the PO / design |
| TD-B6-5 | Contract | Apply requires `apply_actionable === true` **and** requester **and** APPROVED / APPLY_FAILED. A6-R (the flag) is not in this base, so against the base backend Apply never shows (fail closed); it is mocked in unit tests and pinned in Pact by the requester's apply | Verify against A6-R at merge |
| TD-B6-6 | Truthfulness | An approved (escalated) overlay is drawn without the EXCEPTION tag and with a neutral frame ("approved through a change request"); the prototype draws every overlay as an exception. DDR v1.2 §3.2(5) flags only bounded zero-approval acts | Recorded |
| TD-B6-7 | Copy | "§4.2" dropped from the clause help line, the preview line and the overlay clause (DV-B6-2): the policy document has no section numbers | Recorded |
| TD-B6-8 | Data | Overlay reference `EXT-<8 hex>` of the A8 row UUID (DV-B6-3); another person's actor shows as a short reference (no roster read for support_admin; R-13); "Roles at the time" comes from the apply audit event's server-side snapshot | Recorded |
| TD-B6-9 | Copy | Preview adds an ELIGIBILITY line ("The subscription isn't past due, so the extension can't apply as an exception.") mirroring A8; attestation is unknowable client-side, so a `REQUESTER_NOT_ATTESTED` escalation is explained from the server's answer in the notice | Recorded |
| TD-B6-10 | Semantics | The preview's cumulative count uses the policy's rolling 365-day window (A2-B), not the prototype's 90-day `extUse` | Recorded |
| TD-B6-11 | Harness | The CCP harness is adopted byte-identical from CCP-B1 `d1a90eb9` (`proto-ccp.ts`, session personas, `openBuild` clock, `state-types` element/ccp fields, the parity / capture element support, the design-reference copy), plus one B6 change: an element state's design-file masks are stored relative to the element and re-anchored on the build element. B1's only element state has no masks, so its result is unchanged | Lead unions with B1 (identical hunks) |
| TD-B6-12 | Merge | `SupportRequestDialog` and its chain strip duplicate B2's `CommercialRequestDialog` / `ChainPreview`; tokens `--pw-sx-*` duplicate values B1/B2 also add (`#f1f8f4`, 18px title, the dialog shadow) | Lead may unify at merge |
| TD-B6-13 | Merge | Scope constants are local (`support-extension-scopes.ts`) instead of B1's `COMMERCIAL_PERMISSIONS` | Fold at merge |
| TD-B6-14 | Data | The open escalation / removal is found through `GET /change-requests?limit=200` filtered client-side (the A3 list has no tenant or action filter). If more than 200 requests were open platform-wide the strip could miss one; Q14 still refuses server-side (`open_request_exists` shown in the dialog) | Recorded |
| TD-B6-15 | Parity | AA-B6-1: 320 px allowance on `ccp-sx-dialog-escalates` (measured 293; glyphs only) | Recorded in DIVERGENCES.md |
| TD-B6-16 | Copy | Unpinned strings: the page intro, the escalation / removal notices, the toasts other than "Extension applied as an exception — zero approvals, flagged in audit.", the removal dialog copy, the refusal lines | Recorded |
| TD-B6-17 | Scope | The tenant select lists every tenant from `GET /platform/tenants` (commercial roles hold `platform:tenant:read`, A0-C5) | Recorded |
| TD-B6-18 | Scope | Only `sign` is shown (the registry holds `sign` only, PBD §7.1) | Recorded |
| TD-B6-19 | Gates | 4 pre-existing `import-x/order` errors in `parity.spec.ts` / `capture-reference.spec.ts` (present at `8bcf09fb`; e2e is outside the lint target) were left as is to keep B1's hunks identical | Recorded |
| TD-B6-20 | Environment | One unrelated flake under host load (`ProvisionTenantView.spec.tsx`), passed alone and on the full rerun | Recorded |

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK. Tier 1, Tier 2 and front-door clean. No exemption allowlist touched; the design-reference copy is excluded by the existing `COMMON_GLOBS` rule.
