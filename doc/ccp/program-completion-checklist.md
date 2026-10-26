# CCP program completion checklist (CCP-D6)

| | |
|---|---|
| **Slice** | CCP-D6: production rollout readiness + completion checklist |
| **Authority** | `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §5.4 row D6 (binding), §7.3, §10, §11, §12; every LOCKED CCP amendment in `Aramo/locked/`; `doc/ccp/decisions.md` "Architect scope freeze and program closure directive (2026-10-25)" |
| **Branch / base** | `wip/ccp-d6` at `1d25faad` (Merge CCP-R3-W), the program head when D6 was written |
| **Production** | `52ea8de6`. No CCP code, migration or switch is in production. Nothing in this slice was executed. |
| **Companions** | `doc/ccp/production-rollout-plan.md` (the ordered plan); `doc/ccp/delivered-not-delivered-register.md` (capabilities and the A/B/C/D classification) |

PBD row D6, verbatim (PBD §5.4, `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md:126`):

> **In:** the enterprise completion checklist, with evidence per capability, and a production rollout plan. **Out:** executing the rollout, any production migration and any activation (each needs separate PO authorization, §12) | Checklist completeness; the production dark-state re-verification step is present (§7.3) | n/a | Any checklist item without evidence | Completed checklist; delivered and not-delivered register

The scope is frozen. This file documents what exists and adds nothing. Every count is copied from the record cited next to it; nothing is re-measured here.

## 0. Status definitions

These apply the Architect's distinction: engineering complete ≠ release-ready-but-disabled ≠ delivered (`doc/ccp/decisions.md:131`, `:194`).

| Status | Meaning in this checklist |
|---|---|
| **BUILT** | Built on its slice branch with acceptance evidence recorded, but not yet merged into the program branch. |
| **INTEGRATED** | Merged into `feat/ccp-commercial-control-plane`, but with no recorded re-verification on the integrated branch. No row is in this state. |
| **VERIFIED** | Merged and re-verified on the integrated branch: the program gate at `8cae29e5` (`doc/ccp/program-gate-20261025.md`) and the merge-train re-runs that followed it, the latest at `1d25faad` (`doc/ccp/decisions.md:552-572`). This is engineering complete. It is **not** release authorization and **not** delivery. |
| **EXTERNALLY BLOCKED** | Engineering complete and built in Stripe test mode with its designed disabled state. It stays NOT DELIVERED until its external decision is made and verified (PBD §10). |
| **DELIVERED** | In production and released. **No row is DELIVERED**, because no CCP code is in production (`52ea8de6`). |

"Merge SHA" means the merge commit that brought the slice into the program branch. No CCP commit is on `main`. The merge to `main` is step 2 of the rollout plan.

## 1. The 30 original slices (PBD §4, §5)

The "PBD" column cites the row in `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md`. Acceptance records are under `doc/ccp/slices/`.

### 1.1 Phase A: governed commercial foundation

| Slice | PBD acceptance criterion (brief) | Evidence | Slice commit(s) / merge | Status | Blocker / owner |
|---|---|---|---|---|---|
| **A1** roles and scopes | ":73 … counts as measured (25 / 205 / 984; super_admin 10 scopes, 0 commercial); per-role allowed/refused matrix; gate outputs; CCP-FU-1 recorded as open" | §5 counts 25 / 205 / 984, super_admin 10 / 0 commercial (`CCP-A1-acceptance.md:33-43`); per-role R-1…R-6 matrix (`:63-83`); migration spec 16 / 16 (`:96-110`); identity 946 / 946 (`:141`); CCP-FU-1 TRACKED, OPEN (`:92`). On the integrated branch: D4 A1 matrix re-run 113 / 113 (`CCP-D4-acceptance.md:39`); totals now 25 / 206 / 987 after the Finance amount scope, identity 961 / 961 (`doc/ccp/decisions.md:451`). | `eb6f96d5` … `e5e83e1b`, `6b024ac3`, `025fa7cf` (TD-A1-12); committed directly on the program branch, so there is no merge commit | VERIFIED | CCP-FU-1: Lead Architect (PBD §13) |
| **A2** audit + CommercialPolicyVersion v1 | ":74 Policy v1 content and checksum; trigger test outputs; boundary-test table" | v1 checksum `bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5` (`CCP-A2-acceptance.md:45`); triggers 22 / 22 (`:51`); boundaries 37 / 37 (`:81`); audit route per role 21 / 21 (`:98-112`) | `1cff99e8` … `4b93db34`, `a44a2872`; direct on the program branch | VERIFIED | — |
| **A3** change request, approval, eligibility | ":75 Refusal table with test IDs; NC-1…NC-5 outputs; state-machine transition table" | refusals A3-R-0…R-7c (`CCP-A3-acceptance.md:49-63`); NC-1…NC-5 (`:69-81`); A3-SM-1, 81 pairs (`:91`); eligibility 71 / 71, integration 31 / 31 (`:144-163`). The full subscription suite did not finish green in the slice (`:165-176`); it passed later at the program gate, 733 / 733 (`doc/ccp/program-gate-20261025.md:27`). NC-5 RATIFIED (`doc/ccp/decisions.md:18`). | `1346294f` … `4b7bb83b`, `628a2c1c`; direct | VERIFIED | — |
| **A4** product dimension | ":76 The C17 enumeration; before/after row counts; N-12/N-13 outputs; proof of no default reliance" | C17 enumeration (`CCP-A4-acceptance.md:35-42`); N-8 counts (`:52-56`); N-13: 315 results equal to the golden (`:59-60`); N-12 (`:72-86`); no default reliance, 0 offenders (`:90-94`); post-merge 144 / 144 (`:168-171`) | `7391001b` … `5b7113dc` / merge `0294c905` | VERIFIED | — |
| **A5** PlanVersion + price pinning | ":77 v1 checksums; parity report; limit-equality report" | 5 v1 checksums (`CCP-A5-acceptance.md:32-36`); limit equality 315 / 315 / 28 / 45 (`:44-47`); spec 26 (`:51-65`); parity ENV_FALLBACK, 0 pins (`:69`); TD-A5-1 RATIFIED (`doc/ccp/decisions.md:22`) | `b225c388` … `7dc90949` / merge `27a993ca` | VERIFIED | — |
| **A6** transactional apply + D2/H5 hold | ":78 Fault-injection and concurrency outputs; hold test outputs; C-16 query and its dry-run output" | apply 26 / 26 (fault, idempotency, concurrency) (`CCP-A6-acceptance.md:52-67`); hold 10 / 10 (`:85-97`); C-16 dry run (`:120-138`); A6-R 59 / 59 (`:368-384`) | `a2468acf`, `b03bdbde` / merge `078d4f78`; A6-R `0cbbb045` / merge `acc793ae` | VERIFIED | — |
| **A7** revoke + provenance | ":79 Revoke and resurrection test outputs; `verify-api.ts` registration" | A7-E-2, A7-AUTH-1, A7-REV-2, A7-REV-4, A7-E-4/E-5 (`CCP-A7-acceptance.md:28-32`); registered at `pact/provider/src/verify-api.ts:1134`, applied at `:3765` (`doc/ccp/program-gate-20261025.md:117`) | `1754d857` / merge `454230b6` | VERIFIED | — |
| **A8** support exception overlay | ":80 Bound and breach test outputs" | pure 34 / 34 (`CCP-A8-acceptance.md:52`); integration 21 / 21 incl. A8-ARCH-1…3 and the G1-1 tripwire (`:65-89`) | `3d9f9300`, `8bcf09fb` / merge `5a3e1756` | VERIFIED | — |
| **A9** bootstrap + role change | ":81 Bootstrap and gate test outputs; trigger test outputs" | A9-BOOT-1…4, A9-GATE-1, A9-LO-1…3, NC-2 / NC-4 / NC-5 (`CCP-A9-acceptance.md:76-84`); A9 integration 17 / 17 (`:106`); the shipped CLI defect D5-DEF-3 is fixed and proven through the real runner, FIX1-RUN-1 / -2 (`CCP-FIX1-acceptance.md:24-34`) | `ae681cde` … `baf4f623` / merge `bd22fdd0` | VERIFIED | Production bootstrap: PO (rollout step 6). TD-A9-7 is proposed as class A: Architect (`doc/ccp/delivered-not-delivered-register.md` §0) |
| **A10** platform-admin Pact provider | ":82 Consumer-contract count and provider-verified count, reported separately" | At A10: 32 consumer interactions, 32 verified from 1 pact (`CCP-A10-acceptance.md:39`, `:57`). At `1d25faad`: platform-web consumer 202 / 202; provider `verify-platform-admin` 2 / 2, which verifies 1 consumer pact (`doc/ccp/decisions.md:567-569`; `doc/ccp/program-gate-20261025.md:107`) | `429afca2` … `b8dc4814` / merge `b6624aec` | VERIFIED | — |
| **A11** Astre backfill tooling | ":83 Dry-run counts; no-service-change proof" | dry-run golden counts (`CCP-A11-acceptance.md:35-51`); A11-NSC-1, 61 observations byte-identical (`:63-71`); 15 / 15 on the integrated branch (`doc/ccp/decisions.md:113`). Dry-run only: no execute path (`CCP-A11-acceptance.md:151`). | `e07643bb` / merge `3f00d420` | VERIFIED (tooling) | Execution: DR-A11-1 / DR-A11-2, PO / Architect (`CCP-A11-acceptance.md:149-150`) |

### 1.2 Phase B: Platform Admin commercial experience

| Slice | PBD acceptance criterion (brief) | Evidence | Slice commit(s) / merge | Status | Blocker / owner |
|---|---|---|---|---|---|
| **B1** rail + Approvals inbox | ":110 Screens and parity record; per-role visibility" | visibility 30 tests (`CCP-B1-acceptance.md:46`); parity 20 / 20, axe 10 / 10, keyboard 5 / 5 (`:79-81`); provider not run in the slice (`:123`), verified at the program gate (`doc/ccp/program-gate-20261025.md:107`) | `d1a90eb9` / merge `d2e1c647` | VERIFIED | Final visual acceptance: CCP-UI v1.1 review, Architect (`doc/ccp/decisions.md:151`) |
| **B2** catalog | ":111 Parity; chain test" | B2-RI-CHAIN / RI-RETIRE, routes 6 / 6 (`CCP-B2-acceptance.md:46-55`); parity 14 / 14 (`:66`), re-captured at the merge, 14 / 14 (`doc/ccp/decisions.md:104`); backend B2-PUB-1…B2-SM-DB 6 / 6 (`CCP-B2-backend-acceptance.md:54-65`) | `2fe1dffe` / merge `84c6bdc5`; B2-backend `0cbbb045` / merge `acc793ae` | VERIFIED | — |
| **B3** subscriptions workbench | ":112 Parity; action-to-change-request trace" | action trace (`CCP-B3-acceptance.md:48-61`); parity 24 / 24, axe 12 / 12, keyboard 4 / 4 (`:138-159`) | `1c5214bb` / merge `8cae29e5` | VERIFIED | TD-B3-4: design v1.1, Architect (`doc/ccp/decisions.md:151`) |
| **B4** enterprise contracts | ":113 N-3 statement; parity" | N-3(a)–(d) with `path:line` and tests B4-N3-a…d (`CCP-B4-acceptance.md:13-22`); integration 11 / 11 (`:58`); parity 26 / 26 (`:40-52`). Invoicing is disabled: `invoicing.enabled=false` (`:34`, `:84`) | `a7f31d0c` / merge `1d6c12dc` | VERIFIED (contracts) | Contract invoicing: Finance / PO; out of CCP (`doc/ccp/decisions.md:274`) |
| **B5** roles + audit explorer | ":114 Parity; role-change trace" | last-owner refusal (`CCP-B5-acceptance.md:46`); export read-only (`:47`); no grant path (`:48`); parity 18 / 18 (`:51`); role-change trace (`:100-106`) | `5b614493` / merge `cfb0721f` | VERIFIED | — |
| **B6** support workflows | ":115 Parity; bound tests" | bound tests B6-M-LEN…ORDER (`CCP-B6-acceptance.md:59`); a breach escalates and never applies, B6-F-ESC + A8-ESC-* 21 / 21 (`:60`); parity 8 / 8 (`:69`) | `cb8bffb8` / merge `427cd974` | VERIFIED | TD-B6-1 / TD-B6-4: design v1.1, Architect (`doc/ccp/decisions.md:151`) |

### 1.3 Phase C: billing, commerce and finance operations

| Slice | PBD acceptance criterion (brief) | Evidence | Slice commit(s) / merge | Status | Blocker / owner |
|---|---|---|---|---|---|
| **C1** Stripe command outbox + inbox | ":91 Command and inbox test outputs" | C1-TX-1 / -2: no external call inside a local transaction (`CCP-C1-acceptance.md:70`); duplicate and out-of-order webhooks idempotent, C1-INBOX-1…3 (`:71-73`); 23 / 23 (`:66`) | `6b5051a8` / merge `4d8f8e19` | VERIFIED | Live keys: Stripe / PO (§7.3; TD-C1-3 `:168`) |
| **C2** governed conversion | ":92 C8 test IDs and outputs on the integrated branch state" | C2-C8-1…3 (`CCP-C2-acceptance.md:47-55`). On the integrated branch: C2-C8-1…3 + C2-TDC14-1…4, 7 passed (`doc/ccp/decisions.md:107`). The PBD §7.2 re-run on the final head is ⟪FINAL: §7.2 C2-C8 re-run result on the final integrated gate head⟫. | `65cba7c8` / merge `7ab916a2` | VERIFIED | DR-C2-1 (committed rows): Finance / PO (`doc/ccp/decisions.md:137`) |
| **C3** invoice / payment status read | ":93 NOT DELIVERED until its external dependency is verified (§10)" | read-only proof C3-RO-1…5 (`CCP-C3-acceptance.md:38-46`); NOT DELIVERED (`:11`) | `b163e58c` / merge `b936a83d` | EXTERNALLY BLOCKED | `STRIPE_PORTAL_CONFIGURATION` + restricted read-only credential: Stripe, Security, PO (`doc/ccp/decisions.md:139`) |
| **C4** credits, refunds, discounts | ":94 NOT DELIVERED until refund policy (§10)" | 20 / 20 (`CCP-C4-acceptance.md:51`); thresholds C4-TH-1 / -2 (`:55-56`); REFUND disabled, C4-REFUND-1 (`:65`); NOT DELIVERED (`:8`) | `fb94afe8` (+ C4-R `20218e13`, C4-P `c79e9c90`) / merge `ea9c2c0e` | EXTERNALLY BLOCKED | Refund policy: Finance, Legal, Platform Owner (RX-3); credit policy: Finance (TD-C4-18); live keys: Stripe |
| **C5** tax | ":95 NOT DELIVERED until registration (§10)" | disabled-state tests 15 / 15 (`CCP-C5-acceptance.md:62-66`); NOT DELIVERED (`:11`) | `da47a9d4` / merge `be6ff6cb` | EXTERNALLY BLOCKED | Stripe Tax registration: Tax / Finance |
| **C6** renewals, outstanding, reconciliation | ":96 Reconciliation output" | reconciliation output (`CCP-C6-acceptance.md:58-71`); held activations C6-HELD-1 / -2 (`:94-95`); TD-C6-6 verified (`doc/ccp/decisions.md:112`). Finance screens come with UI-V12 (§2). | `94498d49` / merge `2e60c955` | VERIFIED (backend) | Amount owed needs C3: Stripe / Security |
| **C7** multi-product self-service | ":97 NOT DELIVERED until legal terms (§10)" | 21 / 21 (`CCP-C7-acceptance.md:43`); `SELF_SERVICE_TERMS_NOT_APPROVED` (`:10`, `:47`) | `1b41f78c` / merge `6441759a` | EXTERNALLY BLOCKED | Approved terms: Legal / counsel; upgrade DR-C7-1: PO / Architect (`:141`) |

### 1.4 Phase D: enterprise operations and production release

| Slice | PBD acceptance criterion (brief) | Evidence | Slice commit(s) / merge | Status | Blocker / owner |
|---|---|---|---|---|---|
| **D1** usage roll-ups | ":121 Reconciliation output" | reconciliation RECONCILED, 0 mismatches (`CCP-D1-acceptance.md:33-42`); D1-R 26 / 26 (`:164`); provider verified 45 / 45 (`:170`) | `73c33238` / merge `18b2c032`; D1-R `ad774a1b` / merge `153aee2d` | VERIFIED | — |
| **D2** revenue reporting | ":122 Report reproduction; dashboard check" | reproduction MRR 7500 / ARR 90000 minor (`CCP-D2-acceptance.md:71-109`); dashboard no-money 15 / 15 (`:128`); relabelled "illustrative list-price value" (TD-MERGE-47, `doc/ccp/decisions.md:528-537`) | `c9bf90e8` / merge `ef14a377`; W-1 labelling `30df7a36` | VERIFIED (backend) | — |
| **D3** observability | ":123 Alert test outputs" | D3-ALERT-* on injected failures (`CCP-D3-acceptance.md:85-95`); 14 / 14 (`:81`) | `e73b6725` / merge `debd033d` | VERIFIED | — |
| **D4** negative controls, isolation, E2E, UAT | ":124 Suite outputs per role" | negative controls 15 / 15 (`CCP-D4-acceptance.md:37`); isolation (`:38`, `:80-96`); A1 matrix 113 / 113 (`:39`); journeys 39 / 39 per role (`:41`, `:118-126`); 7 UAT scripts (`:132`). Final head: 15 / 15 × 3 (`doc/ccp/decisions.md:566`) | `d3abe5ee` / merge `5f84a35d` | VERIFIED | Human UAT sign-off: not recorded (§4) |
| **D5** runbooks | ":125 Dry-run records" | `doc/ccp/runbook-dry-runs-20261025.md`; results table (`CCP-D5-acceptance.md:43-59`); D5-DEF-1…3 fixed by FIX1 (`CCP-FIX1-acceptance.md:12-104`) | `e7eee3fb` / merge `4fa2a142` | VERIFIED | Runbook staleness: Lead (§4, items 6 and 7) |
| **D6** rollout readiness + checklist | ":126 Completed checklist; delivered and not-delivered register" | this file, `doc/ccp/production-rollout-plan.md`, `doc/ccp/delivered-not-delivered-register.md`; the §7.3 step is §3.2 below | the D6 commit on `wip/ccp-d6` | BUILT | Program acceptance review: Lead / Architect, PO (PBD §11 step 4) |

**Counts (30 rows):** VERIFIED 25 · EXTERNALLY BLOCKED 4 (C3, C4, C5, C7) · BUILT 1 (D6) · INTEGRATED 0 · DELIVERED 0.

## 2. Program corrections, follow-ups and integrator unions

| Item | What it is | Evidence | Commit / merge | Status | Blocker / owner |
|---|---|---|---|---|---|
| **R1** (TD-A7-3) | explicit `granted_source`; the MIGRATION default is removed | NOT NULL, no default; R1-E-1 (`CCP-A7-acceptance.md:161`); 84 fixture sites (`:189`); R1 scan 4 / 4 at `1d25faad` (`doc/ccp/decisions.md:571`) | `f97da715` / merge `cd45b5bb` | VERIFIED | — |
| **R3** | Finance amount scope (LOCKED `c3ce572a`), shared redaction, TD-A8-3, TD-A7-5 | 25 / 206 / 987 (`CCP-R3-acceptance.md:22`); FA-6 no-leak table (`:45-55`); suites (`:118-131`) | `f6bffc48` / merge `8ece5eb2` | VERIFIED | — |
| **R3-W** | W-2 contract terms + W-3 financial request redaction | serializer scan 8 tests (`CCP-R3W-acceptance.md:80-91`); 20 / 20, 67 / 67 (`:96-105`); integrated 20 / 20 + 75 / 75 (`doc/ccp/decisions.md:553-555`) | `d8ab480d` / merge `1d25faad` | VERIFIED | — |
| **ACC-1** (TD-ACC-1 Option B) | requester withdrawal of an APPLY_FAILED POLICY_ACTIVATE | ccp-acc1 7 / 7 and its negative control (`CCP-B5-acceptance.md:422-424`); re-run 32 / 32 (`:491-496`) | `c37b28aa` / merge `2e971350` | VERIFIED | — |
| **FIX1** | D5-DEF-1…3, O-D4-1 / -2, apply-deadline alerts, executable compensations | FIX1-RUN-1…7 (`CCP-FIX1-acceptance.md:24-34`); `migrate-prod.test.sh` 27 / 0 (`:99-102`); full compensation chain 24 / 24 (`:160`), now 30 / 30 over 27 steps (`doc/ccp/decisions.md:433`) | `7a9d375d` / merge `5edabc0f` | VERIFIED | — |
| **C4-R** | the refund flag blocks only new provider calls; governed resolution | 27 / 27 (`CCP-C4-acceptance.md:238`); guard union 8 / 8 (`:247`) | `20218e13` / merge `ea9c2c0e` | EXTERNALLY BLOCKED (with C4) | refund policy: Finance, Legal |
| **C4-P** | refundable remainder RF-3 / RF-4 / RF-5; refund report | 36 / 36 incl. C4P-1…9 (`CCP-C4-acceptance.md:360-369`) | `c79e9c90` / merge `ea9c2c0e` | EXTERNALLY BLOCKED (with C4) | refund policy: Finance, Legal |
| **DG** (Charter A2) | refund dual gate, RX-1…RX-11 | unit 11 / 11, integration 10 / 10 (`CCP-DG-acceptance.md:30-31`); 0 provider calls on every refusal (`:32`); integrated 847 / 847 subscription (`doc/ccp/decisions.md:541`) | `d44f9df2` / merge `5d0da43c` | VERIFIED (refunds stay disabled) | RX-3 policy: Finance, Legal, Platform Owner; PO D5 key confirmation (`doc/ccp/decisions.md:292`) |
| **C8-PR** (PAYMENT_RECORD A2) | catalog row 16; `platform:payment:request` (25 / 207 / 989); payment-gated activation | `wip/ccp-c8pr:doc/ccp/slices/CCP-C8PR-acceptance.md:14-30` (rules); subscription 954 + 1 re-based, 86 / 86 (`:35`); C8-PR 26 / 26 + 10 / 10 (`:36-37`); identity 976 / 976 (`:40`); no class A (`:96`) | `746afa1a` (on `wip/ccp-c8pr`) / ⟪FINAL: C8-PR merge SHA⟫ | BUILT | merge + integrated re-verification: Lead |
| **UI-V12** | CCP-UI v1.2 screens (Finance, Usage, Alerts), AM-1…AM-10 | `wip/ccp-v12:doc/ccp/slices/CCP-UI-V12-acceptance.md` parity: 351 passed, 12 flaky, 2 failed (the 2 known exceptions) (`:58`); platform-web 619 / 619 (`:116`); a11y + keyboard + responsive 421 / 421 (`:124`); no class A (`:8`) | `64e455b6` (on `wip/ccp-v12`) / ⟪FINAL: UI-V12 merge SHA⟫ | BUILT | merge; design amendment 1 not delivered (`:7`): Architect / design |
| **A6-R** | apply deadline per Charter A1; requester-only apply; DR-A6 rulings | `CCP-A6-acceptance.md:271-399`; 59 / 59 (`:368`) | `0cbbb045` / merge `acc793ae` | VERIFIED | — |
| **B2-backend** (TD-A6-13) | governed catalog publish / retire apply | 6 / 6 (`CCP-B2-backend-acceptance.md:54-65`) | `0cbbb045` / merge `acc793ae` | VERIFIED | — |
| **B5-R** (TD-B5-1) | POLICY_ACTIVATE APPROVED → APPLYING → APPLIED; APPLY_EXPIRED for every applyable type | 722 / 722, GUARD-UNION 4 / 4 (`CCP-B5-acceptance.md:270-272`); `APPLY_EXPIRABLE_ACTIONS` lists all 15 applyable types (`libs/subscription/src/lib/commercial/commercial-change-request.ts:286-291`) | `cc7804e9`, direct on the program branch | VERIFIED | — |
| **D1-R** (TD-D1-3) | separate append-only `AllowanceUsageChange` log | LEDGER-1…3 (`CCP-D1-acceptance.md:146-154`); 26 / 26 (`:164`) | `ad774a1b` / merge `153aee2d` | VERIFIED | — |
| **Guard union** (TD-MERGE-GUARD-1) | `20261027000000_ccp_guard_union`: the union of every slice's `guard_commercial_change_request()` branch | GUARD-UNION-1, 4,200 probes vs the TS mirror; -2…-4 (`doc/ccp/decisions.md:91`, `:105`); compensation COMP-1…3 (`:120-127`) | integrator file, updated at each merge | VERIFIED | — |
| **Constraint union** (TD-MERGE-CHECK-1) | `20261027000100_ccp_constraint_union` | `doc/ccp/decisions.md:111`, `:122`, `:376-377` | integrator file | VERIFIED | — |
| **Command-guard union** (TD-MERGE-CMDGUARD-1) | `20261029000000_ccp_command_guard_union` | CMDGUARD-1…5, 5 / 5 (`doc/ccp/decisions.md:365-374`) | integrator file at merge `ea9c2c0e` | VERIFIED | — |
| **Alert-type union** (TD-MERGE-ALERT-1) | `20261029000100_ccp_alert_type_union`, 11 types | D3-U-1 pins 11 (`doc/ccp/decisions.md:421-424`); C8-PR raises it to 12 (`wip/ccp-c8pr:…/CCP-C8PR-acceptance.md:29`) | integrator file at merge `5edabc0f` | VERIFIED | — |
| **R-SYNC** (TD-MERGE-46) | `origin/main` `ac24e234` merged; 5 main migrations interleaved | interleaving table (`doc/ccp/decisions.md:462-474`); sign-mobile 30 / 30, `mobile/sign` 253 / 253 (`:478-480`) | merge `eefa795d` | VERIFIED | — |
| **W-1 labelling** (TD-MERGE-47, class A labelling) | D2 figures relabelled; `recognized_revenue: false` | `doc/ccp/decisions.md:528-537` | `30df7a36` | VERIFIED | — |

**Counts (20 rows):** VERIFIED 16 · EXTERNALLY BLOCKED 2 (C4-R, C4-P) · BUILT 2 (C8-PR, UI-V12).

## 3. Required checklist steps (release time; read-only; nothing here was run)

Each step needs its own recorded PO authorization when run against production (PBD §12). Record outputs in `OneDrive/Aramo/documents/…`, never in `Aramo/locked`.

### 3.1 RX-4: refund-policy hash verification before any refund release

Source: `Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED.md` RX-4 and §8 dependency row 6. DG recorded this as gap G-2 for D6 (`CCP-DG-acceptance.md:78`; `doc/ccp/decisions.md:526`, `:551`).

**When:** before the release authorization that sets gate 1 (`CCP_REFUND_EXECUTION_ENABLED=1`, RX-5; Charter A2 §8 row 8). It must also be re-run before any re-release.

**Preconditions (all must hold, or refunds stay disabled):**
- (a) a refund policy is filed as `…-LOCKED.md` in `Aramo/locked/`, with a `.sha256` sidecar;
- (b) its approval table names approvers and dates for Finance, Legal counsel and the Platform Owner;
- (c) its status line reads APPROVED (RX-3; internal or architect approval does not satisfy Legal);
- a version carrying the three keys is ACTIVE through POLICY_ACTIVATE (row 7).

**Read-only check:**
```bash
# 1. the ACTIVE policy's refund keys (production, read-only)
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT version_number, status,
       content->>'refund_execution_enabled' AS refund_execution_enabled,
       content->>'refund_policy_ref'        AS refund_policy_ref,
       content->>'refund_policy_sha256'     AS refund_policy_sha256
  FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE';
ROLLBACK;
SQL
# 2. on the Mac: the LOCKED document's sidecar, and a recomputation of the file itself
cat "<Aramo/locked>/<refund policy>-LOCKED.md.sha256"
shasum -a 256 "<Aramo/locked>/<refund policy>-LOCKED.md"
```

**Expected:**
- exactly one ACTIVE row;
- `refund_execution_enabled = true`;
- `refund_policy_ref` matches `^[A-Z0-9-]+@[0-9]+\.[0-9]+$`;
- `refund_policy_sha256` equals the sidecar and the recomputed hash.

Any difference is a HALT: gate 1 is not set. **Today's expected result is that the keys are absent** (v1 carries none; DG seeds none, `CCP-DG-acceptance.md:9`, `:16`), so no refund release is possible.

### 3.2 §7.3: production dark-state re-verification before any activation

Source: PBD §7.3 (ruling A0-C9), Conversion Rule C-26, C-27, C-28.

**Procedure:** `doc/runbooks/RUNBOOK-ccp-dark-state-verification.md` §3 (configuration) and §4 (data), then §5 (record).

Run it before **every** production activation: the bootstrap, any worker switch, live Stripe, signup, refunds, tax. Earlier runs, documents and memory are not evidence of the current state (C-28).

**Expected** (runbook §2):
- `SIGN_PUBLIC_SIGNUP_ENABLED` UNSET;
- `SIGN_PERSONAL_SIGNUP_MODE` UNSET in platform-admin and sign;
- `STRIPE_SECRET_KEY` TEST or UNSET in sign, UNSET in platform-admin;
- `STRIPE_PLAN_PRICES` UNSET and 0 `PlanVersionPrice` pins;
- `SIGN_BILLING_COMMANDS_ENABLED` UNSET;
- exactly one Astre MANUAL ACTIVE `aramo-sign-included-v1` row with no provider link.

Any mismatch is a HALT.

**Coverage gap (record, do not fix here):** the runbook §3 script does not list `CCP_ALERTS_ENABLED`, `CCP_USAGE_ROLLUP_ENABLED` or `CCP_REFUND_EXECUTION_ENABLED`. The rollout plan step 4 checks them separately. The refund switch is not passed by `docker-compose.prod.yml`, so it cannot be set in production without a compose change (`libs/subscription/src/lib/commercial/commercial-billing-adjustment.ts:15-16`; `CCP-DG-acceptance.md:47`).

### 3.3 Migration validation

Procedure: `doc/runbooks/RUNBOOK-ccp-migration-validation.md`:
- HALT list (§2);
- pre-checks (§3): P1 backup, P2 exact pending set, P3 A11 fact-check, P4 TD-A1-1 catalog pre-check, P5 C-16, P6 Astre snapshot;
- bounded apply before any code (§4);
- post-checks Q1–Q11 (§5);
- compensation order, newest first (§6);
- evidence (§7).

Counts at `1d25faad`, from the runbook:
- 27 CCP migrations (`:19`, `:23-51`);
- stop point `--until 20261029000100_ccp_alert_type_union` (`:216`);
- gate `27 applied`, plus any of the 5 `main` migrations separately authorized (`:219`);
- Q1 catalog from production 19 / 194 / 973 to 25 / 210 / 1021 (`:274`).

C8-PR adds 2 migrations, `identity/20261028070000_ccp_a1a2_payment_request_scope` and `subscription/20261030010000_ccp_c8pr_payment_record`, and moves the last CCP migration. The runbook has not been updated for them (G-C8PR-2). The values after C8-PR are ⟪FINAL: CCP migration count, `--until` stop point, gate count and Q1 / Q7 / Q11 expected values after the C8-PR merge, from the updated runbook⟫.

### 3.4 Known baseline exceptions

Source: `doc/ccp/known-baseline-exceptions.md`. They are recorded exceptions, not green gates.

- **§1 TD-C4-21:** two platform-web e2e lint errors, FIXED at the C4 merge.
- **§2:** PLATFORM-UX-1 Template Studio visual failures, OPEN, not CCP-caused: `studio-preview-zoom @900` 61 px and `studio-compare-changes @1440` 66 px. Re-check on the CI runner before any baseline action. Owner: PLATFORM-UX-1 / platform-web.
- **Also recorded:** UI-V12 lists 12 pre-existing e2e lint errors in 11 untouched files, outside the nx lint target (`wip/ccp-v12:…/CCP-UI-V12-acceptance.md:125`).

### 3.5 Program-level gates still to run

- The final integrated gate on the head that carries C8-PR and UI-V12: ⟪FINAL: final integrated gate head SHA and its exact counts (build, lint, gates, every suite, Pact consumers / providers, migrations from scratch)⟫.
- The full `nx run api`. It is CI-only by the PO ruling of 2026-10-16, and the CI-only exception is in force (PBD header ratification note; `doc/ccp/program-gate-20261025.md:36`). It runs in CI at rollout step 1.

## 4. Missing evidence (HALT rule: listed, never assumed)

No row in §1 or §2 lacks evidence. These pieces of evidence do not yet exist:

1. The final integrated gate counts (§3.5). It is a placeholder.
2. The PBD §7.2 C2-C8 re-run on the final head (C2 row). It is a placeholder.
3. The CI result of the full `nx run api`. It is produced at rollout step 1; no local run exists by ruling.
4. The C8-PR and UI-V12 integrated re-verification after their merges (PBD gate rule, `doc/ccp/decisions.md:77`). Both are placeholders.
5. A human UAT sign-off. The 7 scripts under `doc/ccp/uat/` carry an empty sign-off line; only their automated twins ran (journeys 39 / 39). The D4 row requires "suite outputs per role", which exist. A human run is not recorded.
6. `doc/runbooks/RUNBOOK-ccp-platform-owner-bootstrap.md` is stale:
   - §1 and §4 still HALT on D5-DEF-3, which FIX1 fixed (`CCP-FIX1-acceptance.md:12-34`);
   - §3 item 2 still says "The 21 CCP migrations".

   The bootstrap needs a reviewed runbook refresh before use. D6 edits no existing file.
7. `RUNBOOK-ccp-migration-validation.md` does not yet carry the C8-PR migrations (G-C8PR-2). It is a placeholder (§3.3).
8. The RX-4 verification output (§3.1). It cannot exist until a LOCKED refund policy exists (Charter A2 §8 row 2: "Draft v1.0 revision prepared, not approved").
9. Any production dark-state record. It is produced at rollout step 5; none may be carried forward (C-28).
10. Final visual acceptance of the console against CCP-UI v1.1 (TD-B3-4 / TD-B6-1 / TD-B6-4, conditional; `doc/ccp/decisions.md:151`) and CCP-UI design amendment 1 (`wip/ccp-v12:…/CCP-UI-V12-acceptance.md:7`). Neither is recorded.
11. Architect ratification of the PO rulings flagged for it: Q5 / NC-4 was ratified as TD-A3-0. TD-A1-11 and TD-A1-12 (`doc/ccp/decisions.md:11-12`) have no recorded ratification.

## 5. ⟪FINAL⟫ placeholders in this file

- ⟪FINAL: C8-PR merge SHA⟫ (§2)
- ⟪FINAL: UI-V12 merge SHA⟫ (§2)
- ⟪FINAL: §7.2 C2-C8 re-run result on the final integrated gate head⟫ (§1.3, C2)
- ⟪FINAL: CCP migration count, `--until` stop point, gate count and Q1 / Q7 / Q11 expected values after the C8-PR merge, from the updated runbook⟫ (§3.3)
- ⟪FINAL: final integrated gate head SHA and its exact counts …⟫ (§3.5)
