# CCP-UI-V12 — acceptance record

| | |
|---|---|
| **Slice** | CCP-UI-V12: the CCP-UI v1.2 screens (Finance, Usage, Alerts), the v1.0 amendments AM-1…AM-10 and the v1.2 delta, on the integrated backends |
| **Baseline** | worktree `.claude/worktrees/ccp-v12`, branch `wip/ccp-v12`, base `eefa795d`. **Nothing committed or pushed; no `git stash`.** |
| **Design pin** | CCP-UI v1.2, manifest 5 / 5 OK (prototype `e3dad017…`); v1.1 manifest 5 / 5 OK for AM-1…AM-10. Hashes: `CCP-UI-V12-pre-execution.md`. Design amendment 1 (W-1…W-3) is **not delivered**; the rulings govern (DV-V12-W*). |
| **Scope freeze** | The Architect froze CCP scope during the slice (Lead, 2026-10-25). Nothing beyond the brief was built; every gap below is a classified divergence (A blocking / B external / C deferred / D resolved). No class A item was found. |
| **Lead corrections applied** | (1) W-1 vs D2: the Revenue figures are labelled "Illustrative list-price value (monthly / annualized)" with the note "Derived from published list prices; not recognized revenue." (DV-V12-REV-1). (2) R3-W contract (`wip/ccp-r3w`): types, drawer, contracts and fixtures aligned to the exact markers (`reason_withheld`, `notes_withheld`, `payload.evidence_withheld`, `terms_withheld`, `detail_withheld`). |

## 1. What was built

| Item | Where | Backend |
|---|---|---|
| Finance › Renewals (§13.1; W-1) | `src/commercial/finance/RenewalsView.tsx` | C6 `finance/renewals` |
| Finance › Outstanding payments (§13.2; §17.2) | `OutstandingPaymentsView.tsx` | C6 `finance/outstanding-payments` + C3 `billing-status` (FA-4 booleans) + B6 support-extension list |
| Finance › Billing reconciliation (§13.3; D-2) | `BillingReconciliationView.tsx` | C6 `finance/reconciliation-report`, C1 `billing-commands`, `billing-webhook-inbox`, D3 `metrics/billing` thresholds |
| Finance › Revenue (§13.5; §17.2; DV-V12-REV-1) | `RevenueView.tsx` | D2 `finance/revenue?months=6` |
| Usage › Consumption (§13.4; refused state) | `src/commercial/usage/ConsumptionView.tsx` | D1 `usage/reconciliation`, `usage/periods` (409) |
| Operations › Alerts (§13.6; no actions) | `src/commercial/alerts/AlertsView.tsx` | D3 `alerts/{billing,approvals}`, `metrics/*` |
| AM-1 rail (Finance, Usage, Alerts; Support extensions after Policy; Contracts hidden for catalog_manager) | `src/shell/nav.ts`, `nav-icons.tsx`, `App.tsx` | — |
| AM-2 scope-aware access denied | `src/commercial/CommercialAccessDenied.tsx` | — |
| AM-3 / AM-4 / AM-5 apply deadline (inbox, drawer fact, stepper, timeline, toast; "No apply deadline (policy v{n})") | `commercial-model.ts`, `deadline.ts`, `ApprovalsInboxView.tsx`, `ChangeRequestDrawer.tsx` | A3 read + B5 `policy-versions` (snapshot `apply_expiry_hours`) + D3 `metrics/approvals` (lead) |
| AM-6 Apply / Retry apply only on `apply_actionable`; requester-only footnotes | `ChangeRequestDrawer.tsx`, `commercial-api.ts` (`apply` routes per action) | A6-R / C2 / C4 |
| AM-7 policy activation copy, hints, Apply activation / Retry apply | `PolicyView.tsx` | B5-R |
| AM-8 "Extension outside policy bounds" chain + inbox tag | `commercial-model.ts`, inbox | A8 |
| AM-9 Tax · Not enabled; v1.2 Payment / Amount due facts | `TenantCommercialPanel.tsx` | C5 `tax`, C3 FA-4 |
| AM-10 Request publish… disabled while Approved | already server-driven (`COMMERCIAL_OPEN_STATES` includes APPROVED); test added | B2 |
| v1.2 `WithheldAmount` / `PaymentDueIndicator` | components; Outstanding, Reconciliation, Revenue, Tenant › Commercial, inbox, drawer, Audit detail | R3 |
| D-4 Withdraw… (ACC-1 `withdraw_actionable`), both refusals inline | `WithdrawFailedActivationDialog.tsx`; PolicyView, drawer | ACC-1 |
| D-1 "Apply window (TTL)" policy field (always listed, "Not set", 1–336) | `governance-model.ts` | FIX1 |
| D-2 thresholds from configuration | reconciliation subtitle/detail, inbox amber, deadline amber | D3 `thresholds` |
| W-2 Contract terms restricted | `ContractsView.tsx` (`terms_withheld`) | R3-W (not in base) |
| W-3 financial reason / evidence restricted; requester "Your request details"; "Finance notes on this request are restricted" | `ChangeRequestDrawer.tsx` | R3-W (not in base) |

New typed components (R-3, `src/components/`): `WithheldAmount`, `PaymentDueIndicator`, `NotEnabledState`, `ExceptionCountTile`, `RenewalRemainingPill`, `WithheldPrice`, `UsageReconBanner`, `ApplyDeadline`, `WithdrawFailedActivationDialog`. Reused: B1 `commercialGate` and `COMMERCIAL_PERMISSIONS` (+ `billingRead`, `billingAmountRead`), B2 `CommercialRequestDialog`, the CCP visual harness (`proto-ccp.ts`, now release-aware: `release: 'v1_2'`).

## 2. Parity record (PLATFORM-UX-1 §3; 1440×900 and 900×900)

New v1.2 states (`e2e/visual/states-ccp-v12.ts`): **29 states × 2 viewports = 58 comparisons**, plus `ccp-rail-finance` and `ccp-rail-usage` (4). References captured from the pinned v1.2 file: **62 images + 62 mask files** (124 new files under `__screenshots__`).

| Group | States |
|---|---|
| Renewals | `v12-renewals`, `-nonholder`, `-empty`, `-loading` |
| Outstanding payments | `v12-outstanding`, `-nonholder`, `-empty` |
| Billing reconciliation | `v12-recon`, `-nonholder`, `-empty` |
| Revenue | `v12-revenue`, `-nonholder`, `-empty`, `v12-revenue-months`, `-months-nonholder` (element) |
| Consumption | `v12-usage`, `-pending`, `-refused` |
| Alerts | `v12-alerts`, `-resolved`, `-empty` |
| AM-2 | `v12-denied-renewals` |
| AM-5 / AM-6 / D-4 (element) | `v12-drawer-stepper-approved`, `-stepper-apply-expired`, `v12-drawer-footer-apply`, `-footer-failed-policy`, `v12-withdraw-dialog` |
| AM-9 / §17.2 (element) | `v12-tc-payment-holder`, `-nonholder` |
| AM-1 (element) | `ccp-rail-group` (re-pointed), `ccp-rail-finance`, `ccp-rail-usage` |
| AM-7 / D-1 (B5 spec) | `ccp-policy-draft`, `-active`, `-viewonly`, `-activation-dialog` re-pointed to v1.2 |

**Modified existing baselines (4, all CCP, none PLATFORM-UX-1):** `ccp-rail-group-{1440,900}.png` (AM-1), `ccp-policy-activation-dialog-{1440,900}.png` (AM-7). `git status` shows no other modified baseline.

**Full visual project** (`parity`, `ccp-b5-parity`, `ccp-contracts`; `PW_E2E_PORT=4490`, 2 workers, the project's 2 retries), final run: **351 passed, 12 flaky (passed on retry), 2 failed** — the 2 failures are exactly the known PLATFORM-UX-1 baseline exceptions. Flaky (raster noise under load, each passed on retry): ccp-contracts-empty @900, ccp-contracts-end-dialog @900, denied-console @900, dialog-suspend @1440, skills-proposals @1440, matching-edit @900, studio-var-popover @900, studio-version-view @1440, ccp-catalog-viewonly @900, v12-renewals @900, v12-revenue @900, v12-alerts-empty @1440. Known baseline exceptions unchanged: PLATFORM-UX-1 `studio-compare-changes @1440` and `studio-preview-zoom @900` (doc/ccp/known-baseline-exceptions.md; no CCP file touches the Studio).

Masks: only the sanctioned divergences in `e2e/visual/DIVERGENCES.md` "CCP-UI-V12" (DV-V12-W1, -REV-1, -T, -6, -8/-11, -9, -10, -12, -13, -15) and B1's DV-C1, DV-C2, DV-C6, B3's DV-B3-1. Anti-aliasing allowances: AA-V12-1 (`v12-renewals`, 100 px), AA-V12-2 (`v12-alerts*`, 40 px).

## 3. Divergences (DV-V12-n)

| ID | Divergence | Cause | Class |
|---|---|---|---|
| DV-V12-W1 | Renewals (and the plan-change diff, unchanged) show the published list price to every billing reader; v1.2 shows WithheldAmount to non-holders. Masked element: the Renewals table for the non-holder state | Architect ruling W-1 | D (ruled) |
| DV-V12-W2 | Contract terms block → "Contract terms restricted — Finance access required" when `terms_withheld` is present (also when `terms` is absent); amendment `summary` stays | Ruling W-2; design amendment 1 pending | B (R3-W backend not in base) |
| DV-V12-W3 | Financial requests: `reason_withheld` → reason and evidence "Financial details restricted — Finance access required"; REFUND `payload.evidence_withheld` → evidence only; the requester without amount-read sees their own text under "Your request details"; `notes_withheld` → the notice "Finance notes on this request are restricted" and approval / rejection notes read "Finance notes restricted" in the timeline | Ruling W-3; R3-W contract; no design yet | B |
| DV-V12-REV-1 | Revenue figures relabelled; visible list-price note; Renewals intro reworded | Lead correction (W-1 vs D2) | D (ruled) |
| DV-V12-3 | Outstanding: PaymentDueIndicator from the C3 billing-status booleans per listed tenant, shown only when that read is AVAILABLE (no false "Not due") | The C6 row carries no FA-4 booleans (MBC-V12-3) | B |
| DV-V12-5 | Apply deadline resolved for display from the request's snapshotted policy version (`apply_expiry_hours`); authority stays `apply_actionable`; until the policy read loads the toast is the plain "{id} approved." | The A3 read carries no deadline (MBC-V12-2) | B |
| DV-V12-6 | Withdraw dialog has no "Reason (required)" field; the usage banner names no run mode | Withdraw route takes no body (MBC-V12-1); D1 read has no mode (MBC-V12-6) | B |
| DV-V12-7 | AM-8: the Platform admins chain panel stays at the server's 5 chains (no sixth "Extension outside policy bounds" cell) | The roster read lists 5 chain keys (MBC-V12-10) | C |
| DV-V12-8 | No Roll-up runs card | No route lists the runs (MBC-V12-7) | B |
| DV-V12-9 | No "Design only" banner on Revenue | D2 delivered | D |
| DV-V12-10 | Alerts footer reworded ("grade, rate or order") | The design's words fail the vocabulary gate (R-18) | D |
| DV-V12-11 | Refused card names `409 USAGE_ROLLUP_NOT_RECONCILED` | The server's real code | D |
| DV-V12-12 | Alert severity from a fixed per-type map (the design's values); `ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION` (R3, not in the design) = Action needed; counts are the register's; subject labels are short references; no money masking (D3 alerts carry no amount, FA-6) | No severity field (MBC-V12-8) | C |
| DV-V12-13 | Revenue Withheld tile lists exclusion reasons with counts, not tenant names | D2 has no per-tenant row by design | D |
| DV-V12-14 | Reconciliation inbox lists FAILED events only (no "Stuck processing"); inbox rows show "—" for tenant | No stalled-processing threshold in configuration; the inbox DTO has no tenant (MBC-V12-9) | C |
| DV-V12-15 | Exceptions tile = server `counts.exceptions` (stuck commands listed, not counted) | C6 definition | D |
| DV-V12-16 | Tenant › Commercial reads billing-status for every open Sign row (was: Stripe-owned only) to show the C5 tax row; Payment / Amount due only when AVAILABLE | AM-9; no false due state | D |
| DV-V12-17 | Apply window field range 1–336 h (design) in the editor; the server parser accepts more | v1.2 §17.1 D-1 | D |
| DV-V12-18 | Drawer title: the WithheldAmount chip renders under the effect, not in the title text | DetailDrawer title is text | C |
| DV-V12-19 | Outstanding "Suspended {date}" uses `grace_until`; reconciliation "Entitlement" reads Active / Not active; five more discrepancy codes get plain labels | No suspension date; report does not split REVOKED / NONE (MBC-V12-11, -13) | C |
| DV-V12-20 | The v1.2 Audit export warning box ("Amounts are omitted for your role") is not built; Audit rows carry the WithheldAmount chip when the payload is withheld | Export dialog is B5's; scope freeze | C |
| DV-V12-21 | Usage `NOT_RUN` → pending banner with "No roll-up run has finished yet."; period alignment shows no reason | No run read; no reason field (MBC-V12-14) | C |
| DV-V12-22 | AM-2 also applies to Subscriptions for catalog_manager (gated on subscription:read since B1; design Q-V11-2 shows it) | B1 gate | C |

## 4. Missing backend contracts

| ID | Contract needed | For |
|---|---|---|
| MBC-V12-1 | `POST …/change-requests/{id}/withdraw` accepts a required `reason` (recorded) for an APPLY_FAILED POLICY_ACTIVATE | D-4 dialog field |
| MBC-V12-2 | Change-request read returns `apply_deadline` (and the snapshotted policy version number) | AM-3…AM-5 without the policy join |
| MBC-V12-3 | C6 outstanding row carries `payment_due` / `payment_overdue` (FA-4) and the live support-extension overlay | §17.2 without N reads |
| MBC-V12-4 | W-2 `terms_withheld` on Contract / ContractAmendment — **delivered on `wip/ccp-r3w`**, not in this base; Pact interaction to add after that merge | W-2 |
| MBC-V12-5 | W-3 `reason_withheld`, `notes_withheld`, `payload.evidence_withheld`, `detail_withheld` — **delivered on `wip/ccp-r3w`**, not in this base; Pact interaction to add after that merge | W-3 |
| MBC-V12-6 | Usage reconciliation read returns the last run's time and mode | banner |
| MBC-V12-7 | A roll-up runs list route | Roll-up runs card |
| MBC-V12-8 | An operational `severity` on alerts (or a ruling that severity is per type) | Alerts |
| MBC-V12-9 | Webhook inbox `tenant_id`; a configured stalled-processing threshold | Reconciliation §3 |
| MBC-V12-10 | Roster chain list including the escalated-extension chain | AM-8 sixth cell |
| MBC-V12-11 | Outstanding row: suspension date | grace column |
| MBC-V12-13 | Reconciliation report distinguishes REVOKED vs NOT GRANTED | entitlement column |
| MBC-V12-14 | Usage period alignment reason | Consumption |

## 5. Per-role visibility (6 roles + super_admin, holder vs non-holder)

`commercial-visibility.spec.tsx` (51 tests): the Commercial items per role; AM-1 Finance, Usage, Alerts shown exactly to the 5 billing / subscription readers (never catalog_manager, never super_admin); Support extensions after Policy; super_admin deep links render the in-shell card (6 roles on Approvals / Catalog / Policy / Audit, 5 on the scope-gated pages); catalog_manager deep links to the 6 new pages name `platform:billing:read` / `platform:subscription:read` and list exactly the 5 holders. Holder vs non-holder: `finance-v12.spec.tsx` (Outstanding × 5 billing roles; Revenue holder / non-holder; Reconciliation command amount), `TenantCommercialPanel.spec.tsx` V12-T-PAY (finance_admin / commercial_ops), `ccp-v12-drawer.spec.tsx` W-3 (non-holder, requester, REFUND evidence, non-financial unchanged), `ContractsView.spec.tsx` V12-W2-1/-2.

## 6. Gates and counts

| Gate | Result |
|---|---|
| platform-web unit (vitest, 2 workers) | **619 / 619** in 50 files (+64 tests vs the 555 at base) |
| `tsc` app + e2e | clean |
| `nx run aramo-platform-web:lint` | 0 errors |
| `nx run aramo-platform-web:build` (`--skip-nx-cache`) | OK |
| `scripts/verify-vocabulary.sh` | OK (no banned term written) |
| `repo-map:generate` + `repo-map:check` | OK (no tracked map change) |
| Pact consumer | all pacts deleted and regenerated serially (`npm run pact:consumer`, 15 consumers, all green); platform-web 203 / 203 in 3 files; `platform-web-platform-admin.json` 207 interactions (10 new CCP-UI-V12 interactions pinning the screens' exact queries) |
| Pact provider (platform-admin) | `verify-platform-admin.ts` 2 / 2, all 207 interactions verified |
| a11y + keyboard + responsive projects (final run) | **421 / 421 passed**, incl. axe on the 29 v1.2 states (0 serious / critical; the generic axe spec covers them too: 58 v1.2 axe runs), 5 v1.2 keyboard journeys, 900px on 29 v1.2 + 3 rail states |
| e2e lint | the slice's e2e files clean; 12 pre-existing `import-x/order` / `no-this-alias` errors in 11 untouched e2e files (outside the nx lint target), plus one in `ccp-b5-states.ts` fixed with `--fix` |


## 7. Commit map (proposed; nothing committed — Gate 6 is a separate turn)

1. `docs(ccp-ui-v12): pin CCP-UI v1.2 design reference + pre-execution record` — `doc/design-reference/ccp/CCP-UI-v1_2/**`, `doc/ccp/slices/CCP-UI-V12-pre-execution.md`.
2. `feat(platform-web): CCP-UI v1.2 components` — `src/components/{WithheldAmount,PaymentDueIndicator,NotEnabledState,ExceptionCountTile,RenewalRemainingPill,WithheldPrice,UsageReconBanner,ApplyDeadline,WithdrawFailedActivationDialog}.tsx`, `finance-components.css`, `finance-components.spec.tsx`, `index.ts`, `BeforeAfterDiff.tsx`, `permissions.ts`, `theme.css`.
3. `feat(platform-web): AM-1 rail + AM-2 scope-aware access denied` — `shell/nav.ts`, `shell/nav-icons.tsx`, `CommercialAccessDenied.tsx`, `App.tsx`, `commercial-visibility.spec.tsx`.
4. `feat(platform-web): Finance, Usage and Alerts screens` — `src/commercial/{finance,usage,alerts}/**`, `DashboardView.no-money.spec.tsx`.
5. `feat(platform-web): AM-3…AM-10 + v1.2 delta + W-2/W-3 on existing screens` — `commercial-api.ts`, `commercial-model.ts`, `deadline.ts`, `ApprovalsInboxView.tsx`, `ChangeRequestDrawer.tsx`, `commercial.css`, `ccp-v12-drawer.spec.tsx`, `ApprovalsInboxView.spec.tsx`, `commercial-model.spec.ts`, `commercial-governance/*`, `subscriptions/*`, `contracts/*`, `catalog-model.spec.ts`.
6. `test(platform-web): v1.2 parity, axe, keyboard + re-pointed CCP baselines` — `e2e/**` (fixtures, harness, states, specs, DIVERGENCES.md, 124 new + 4 re-captured CCP images).
7. `test(pact): platform-web CCP-UI v1.2 reads` — `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`.
8. `docs(ccp-ui-v12): acceptance record` — this file.
