# CCP-UI-V12 — pre-execution check

Required by PBD §6.2, before the slice's first change.

| | |
|---|---|
| **Slice** | CCP-UI-V12 ("UI-V12"): the CCP-UI v1.2 screens (Finance, Usage, Alerts), the v1.0 amendments AM-1…AM-10 and the v1.2 delta, on the existing integrated backends |
| **Authority** | LOCKED directive chain: `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §5.3 / §6.2; `Aramo-PLATFORM-UX-1-…-Directive-v1_0-LOCKED.md` §3 (pixel parity), §4 R-3, R-5, R-12, R-13, R-18, R-19; PLATFORM-UX-1 Amendment A1 (CCP scope) A1-2, A1-4, A1-4a, A1-5; the rulings in `doc/ccp/decisions.md` listed below |
| **Baseline** | worktree `.claude/worktrees/ccp-v12`, branch `wip/ccp-v12`, at `eefa795d` (R-SYNC of `origin/main` into the program branch). Working tree clean at start except this record. |
| **Parallel slices (not touched)** | R3-W (backend redaction of Contract terms and financial request reasons), C8-PR (PAYMENT_RECORD), DG |
| **Scope** | `apps/platform-web` and the platform-web Pact consumer only. Backend gaps are reported as missing backend contracts; none is built here. |

## Pinned design input

Release **CCP-UI v1.2**, OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_2/`. `shasum -a 256 -c handoff/MANIFEST.sha256` run on 2026-10-25 before any code: **5 / 5 OK**. Prototype hash `e3dad017…` as briefed.

| SHA-256 | File |
|---|---|
| `e3dad0170db6f6495792a5fde942bf2a5f898ffea72bd1b64be4a739b6a78105` | `Commercial Control Plane v1.2.dc.html` (pixel truth) |
| `1e1170cd377c5e3f7a7799d452d5b80f451ced50629b2ed9f173c3c4239f0437` | `ccp-data.js` (prototype data; reference capture only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` (byte-identical to the PLATFORM-UX-1 pin and to v1.0 / v1.1) |
| `0296330ad74f63e33be6c65f786395cd45b16226b37647f58d98d79f6c3f1c1a` | `handoff/Commercial Control Plane - Claude Code handoff v1.2.md` |
| `f6b7cac70baa2963b9dcaf2cd11539ec96d28af91cf7b133ca1f912f08cb1006` | `handoff/Commercial Control Plane - design amendments log v1.2.md` (no amendments: the table is empty) |

The harness serves a byte-identical copy committed under `doc/design-reference/ccp/CCP-UI-v1_2/` (same layout as the v1.0 copy: the manifest at the release root; excluded from the vocabulary gate by `COMMON_GLOBS` `**/design-reference/**`). `shasum -a 256 -c MANIFEST.sha256` on the copy: 5 / 5 OK.

**The v1.0 amendments AM-1…AM-10** are defined in the v1.1 handoff §12.2 (`ccp/CCP-UI-v1_1/`), also re-verified on 2026-10-25, **5 / 5 OK**:

| SHA-256 | File |
|---|---|
| `3c7760e9820ecbed4a85d5b1496653f2d49d607cdf802f6189f2aeb6a10c63c0` | `Commercial Control Plane v1.1.dc.html` |
| `1ef7fd61d8dcf62f9553734b7c1a38142e4605a604de491efdce2994e60b569e` | `ccp-data.js` |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `648d6996288b0a7d08f1a54f1c5fbbf94e8ea0fd559b1d0fa95234f40c4cbe9e` | `handoff/Commercial Control Plane - Claude Code handoff v1.1.md` |
| `8c546a0c4d46098cda5b29cb97d1e6815ad0feee5775ef1c2d2867548b29136c` | `handoff/Commercial Control Plane - design amendments log v1.1.md` |

The v1.2 handoff carries §12.2 unchanged (its §1–§16 are v1.1 with the §17.1 corrections applied in place; §17 wins). The v1.2 file is the pixel truth for every amended v1.0 screen.

**Design amendment 1 (W-1…W-3)** is requested and **not delivered**. Until it is, the rulings below govern and each departure from the v1.2 file is a typed divergence `DV-V12-W*`.

## LOCKED instruments relied on (sidecars verified 2026-10-25)

| SHA-256 | Instrument |
|---|---|
| `c3ce572ae19bba55b8c40b4682fb1064274e896f6dcc29e5380c7e74a5f97c41` | `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0-LOCKED.md` (FAS-1…3; `platform:billing:amount:read` to platform_owner, finance_admin, read_only_auditor) |
| `58dac8ed94ccf43bd7a29b28b83fde242588cef3b4da9ed76ea403dfc3346418` | `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED.md` (AD-1 policy data; AD-2 snapshot: v1 has no deadline; AD-4 `APPLY_EXPIRED`) |
| `e94fa124341ecaa125dcd170066999549f1c8599756437f4294db4ae1361ac2c` | `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-v1_0-LOCKED.md` (§3 pixel parity at 1440×900 and 900×900) |
| `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` | `Aramo-PLATFORM-UX-1-…-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` |
| `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` | `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` |

## Rulings applied (`doc/ccp/decisions.md`, read in full at `eefa795d`)

| Ruling | What it fixes for this slice |
|---|---|
| Architect rulings: CCP-UI v1.2 Finance visibility — W-1 | Published list prices are catalog information, shown to every billing reader (Renewals list price, the plan-change diff). Negotiated rates, discounts, effective tenant prices and invoice amounts need `platform:billing:amount:read`. |
| W-2 | A non-holder never receives `Contract.terms` / `ContractAmendment.terms`; the UI renders "Contract terms restricted — Finance access required" from the backend's redaction field. |
| W-3 | CREDIT, DISCOUNT, REFUND (and PAYMENT_RECORD) only: non-holder non-requesters see "Financial details restricted — Finance access required" for reason and evidence; the requester sees their own text labelled "Your request details" with "Finance notes on this request are restricted". Every other action type unchanged. |
| Finance amount scope (LOCKED, FA-1…FA-6) | The console renders `amount_withheld` / `payment_due` / `payment_overdue` as returned; it never holds a figure to hide. |
| TD-B2-3 (requester-only apply) | Apply / Retry apply only when the request read says `apply_actionable: true`. |
| Charter Amendment A1 (apply deadline) + TD-A6-5 | The deadline is the creation policy's `apply_expiry_hours`; absent under v1 ("No apply deadline (policy v{n})"). |
| TD-D3-2 | Stuck command at 24 h; approval expiry warns 12 h before. Labels read the values from configuration (`/metrics/*` `thresholds`), never constants. |
| TD-ACC-1 (Option B) | Withdraw… on an APPLY_FAILED POLICY_ACTIVATE only when `open_request.withdraw_actionable`; the two refusals render inline. |
| TD-B4-3 | catalog_manager has no `platform:subscription:read`: Contracts (and Usage) hidden and refused in-shell. |
| TD-B1-2 | Money stays on Finance surfaces; the dashboard is untouched. |

## Backends used (all integrated at `eefa795d`)

| Screen | Route(s) | Scope | Controller |
|---|---|---|---|
| Finance › Renewals | `GET /platform/commercial/finance/renewals` | `platform:billing:read` | `platform-commercial-finance.controller.ts` (C6) |
| Finance › Outstanding payments | `GET /platform/commercial/finance/outstanding-payments` | `platform:billing:read` | same (C6; R3 `amount_withheld`) |
| Finance › Billing reconciliation | `GET /platform/commercial/finance/reconciliation-report`, `GET /platform/commercial/billing-commands`, `GET /platform/commercial/billing-webhook-inbox` | `platform:billing:read` | C6, C1 |
| Finance › Revenue | `GET /platform/commercial/finance/revenue` | `platform:billing:read` | `platform-commercial-revenue.controller.ts` (D2; R3) |
| Usage › Consumption | `GET /platform/commercial/usage/reconciliation`, `GET /platform/commercial/usage/periods` (409 `USAGE_ROLLUP_NOT_RECONCILED`) | `platform:subscription:read` | `platform-commercial-usage.controller.ts` (D1) |
| Operations › Alerts | `GET /platform/commercial/alerts/{billing,approvals}`, `GET /platform/commercial/metrics/{billing,approvals}` (thresholds) | `platform:billing:read` / `platform:approval:read` | `platform-commercial-observability.controller.ts` (D3, FIX1) |
| Joins for names / slugs / contract ids | `GET /platform/tenants`, `GET /platform/commercial/subscriptions` | `platform:tenant:read`, `platform:subscription:read` | existing |
| AM-3…AM-7 apply deadline | `GET /platform/commercial/policy-versions` (the request's snapshotted version's `apply_expiry_hours`) | `platform:approval:read` | B5 / FIX1 |

## Plan

1. Shared: `COMMERCIAL_PERMISSIONS` gains `billingRead` / `billingAmountRead`; the rail (AM-1); the scope-aware access-denied card (AM-2); the typed v1.1 / v1.2 components (`WithheldAmount`, `PaymentDueIndicator`, `NotEnabledState`, `ExceptionCountTile`, `RenewalRemainingPill`, `WithheldPrice`, `UsageReconBanner`, `ApplyDeadline`, `WithdrawFailedActivationDialog`).
2. The six screens, each behind B1's `commercialGate` with its read scope.
3. AM-3…AM-10 and the v1.2 delta on the existing screens (inbox, drawer, policy, tenant tab, catalog).
4. W-2 / W-3 coded against the agreed R3-W contract shape (`terms_withheld` / `reason_withheld`: `"FINANCE_SCOPE_REQUIRED"`), mocked in tests; dependency recorded.
5. Tests: per-role visibility (6 roles + super_admin, holder vs non-holder), parity at 1440 / 900 against the pinned v1.2 file, axe, keyboard, 900px responsive; the Pact consumer (pacts deleted and regenerated, serial) and the platform-admin provider; lint, build, vocabulary, repo-map.
6. Records: `doc/ccp/slices/CCP-UI-V12-acceptance.md` (parity record, divergences DV-V12-n, missing backend contracts, commit map).

**Rails:** no commit, no push, no `git stash`; `PW_E2E_PORT=4490`; `--maxWorkers=2`; unique scratchpad log names; no PLATFORM-UX-1 baseline re-captured.
