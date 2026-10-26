# CCP delivered and not-delivered register (CCP-D6)

| | |
|---|---|
| **Authority** | PBD §5.4 row D6 ("delivered and not-delivered register"), §10, §11 step 4 (CCP-FU-1 reported here); `doc/ccp/decisions.md` "Architect scope freeze and program closure directive (2026-10-25)" (classes A / B / C / D) |
| **Base** | `wip/ccp-d6` at `1d25faad`; production `52ea8de6` |
| **Rule** | **Nothing is DELIVERED.** No CCP code, migration or switch is in production. "Delivered" needs production presence and release (PBD §10, §7.3). |

## 0. Item proposed as class A (listed first, per the freeze directive)

The freeze directive allows only class A to be implemented. Each A item needs a bounded, evidence-based request before any change (`doc/ccp/decisions.md:502`). D6 implements nothing.

### TD-A9-7: requester attestation is not required for non-governance actions

**Proposed class:** A, pending the Architect's classification. No test has demonstrated it end to end.

**What the code does:**
- The requester's D9 one-account-per-human attestation is checked only when the action names a requester role. Those are the governance actions POLICY_ACTIVATE, ROLE_GRANT and ROLE_REVOKE (`libs/subscription/src/lib/commercial/commercial-change-request.service.ts:425-429`).
- Approver eligibility refuses self-approval by account identity only: `actor.user_id === request.requested_by` (`libs/subscription/src/lib/commercial/commercial-approval-eligibility.ts:102`).
- The distinct-human matching excludes the requester by `user_id` (`:149`).

**The gap:** for the other actions (subscription, entitlement, billing, catalog, support, conversion), an unattested requester account and an attested approver account belonging to the same human would not be refused.

**Recorded by:** CCP-A9 as TD-A9-7, "Flag for the Architect: whether A1-3 ('distinct, active, independent eligible humans to the requester and every approval step') should extend requester attestation to every action" (`doc/ccp/slices/CCP-A9-acceptance.md:156`). No ruling is recorded in `doc/ccp/decisions.md`.

**Invariant at stake:**
- PBD §12, "No self-approval, and no repeated approval by the same person under different roles";
- PBD §7.6 / A0-C4 (distinct-human approval).

**How an unattested holder of a requester role can arise** (all on record):
- a commercial-role invite that loses the human-reference race "stays unattested (NOT_HUMAN, fail closed)" (`CCP-A9-acceptance.md:154`);
- a holder whose attestation was revoked (D4-NC2-D9 tests approvers only, `CCP-D4-acceptance.md:66`).

**Mitigation present:** an attested human cannot attest a second account (unique `CommercialOperatorAttestation_active_human_key`, `CCP-D4-acceptance.md:66`). Approvers must be attested. The gap is on the requester side only.

**Owner:** Lead Architect (classification); PO (authorization of any bounded fix).

No other item is proposed as A. The one class-A item recorded during the program, R3-W DV-3 (a provider error text reaching a non-holder), is already fixed (`CCP-R3W-acceptance.md:135`). TD-MERGE-47 (W-1 labelling, class A) is done (`doc/ccp/decisions.md:528-537`). Both are listed as D below.

## 1. Capability register

Classes:
- **EC (engineering complete):** built and verified on the integrated branch. Usable once the standard release steps happen: PR, merge, migration, deploy and bootstrap, each separately authorized.
- **RRD (release-ready-but-disabled):** engineering complete and shipped dark behind a switch or an activation. Switching it on needs a PO release authorization, but no external decision.
- **EB (externally blocked):** NOT DELIVERED until an external decision is made and verified (PBD §10).
- **Delivered:** none.

| # | Capability | Slices | Class | Delivered? | Blocker owner | What releases it |
|---|---|---|---|---|---|---|
| 1 | Commercial role and scope catalog: 6 roles; 25 / 206 / 987, then 25 / 207 / 989 with C8-PR | A1, R3, C8-PR | EC | no | PO (migration) | rollout steps 3–4 |
| 2 | Commercial audit + policy v1 (DB-immutable) | A2 | EC | no | PO | steps 3–4 |
| 3 | Change requests, approvals, eligibility (NC-1…NC-5) | A3 | RRD: inert until bootstrap (`CCP_NOT_BOOTSTRAPPED`) | no | PO | step 6 |
| 4 | Product dimension (`sign` only) | A4 | EC | no | PO | steps 3–4 |
| 5 | Plan versions, price pinning, grandfathering | A5 | EC (0 price pins; env fallback) | no | PO | steps 3–4 |
| 6 | Governed MANUAL apply + checkout / webhook hold | A6, A6-R | RRD (needs the bootstrap) | no | PO | step 6 |
| 7 | Apply deadline (Charter A1) | A6-R, B5-R, FIX1 | RRD: needs POLICY_ACTIVATE of v2 | no | PO (D5 confirmed), Finance → Owner chain | step 8 |
| 8 | Entitlement revoke + explicit provenance | A7, R1 | EC | no | PO | steps 3–6 |
| 9 | Support extension overlay + console | A8, B6 | RRD (bootstrap) | no | PO | step 6 |
| 10 | Platform-owner bootstrap + governed role change | A9, B5 | RRD: one-time production write | no | PO; Lead (runbook refresh) | step 6 |
| 11 | Platform-admin Pact provider + coverage gate | A10 | EC (test infrastructure) | n/a | — | CI |
| 12 | Astre backfill: dry run | A11 | EC (local only) | no | PO | step 7a |
| 13 | Astre backfill: execution | A11 | not built (no execute path) | no | **PO / Architect**: DR-A11-1, DR-A11-2 | step 7b + a reviewed change |
| 14 | Commercial console (rail, Approvals, Catalog, Subscriptions, Contracts, Policy / Audit / Admins, Support extensions) | B1–B6 | EC; final visual acceptance conditional on design v1.1 | no | **Architect** (design v1.1 review) | step 4 |
| 15 | Finance, Usage, Alerts screens; AM-1…AM-10 | UI-V12 | EC (merged) | no | **Architect / design** (amendment 1 not delivered) | merge `c8034b4d` |
| 16 | Policy governance: POLICY_ACTIVATE, rollback, withdraw | B5, B5-R, ACC-1, FIX1 | RRD (bootstrap) | no | PO | step 6 |
| 17 | Enterprise contracts (N-3) | B4 | RRD (bootstrap) | no | PO | step 6 |
| 18 | Enterprise payment record (PAYMENT_RECORD) + payment-gated activation | C8-PR | EC (merged); production use needs its own authorization (PAYMENT_RECORD A2 §6) | no | PO | merge `3b779004`, then step 8 |
| 19 | Enterprise invoicing | B4 | out of CCP (`invoicing.enabled: false`) | no | **Finance / PO**; ACCT program | — |
| 20 | Stripe command outbox / inbox | C1 | RRD (`SIGN_BILLING_COMMANDS_ENABLED`, test mode; live key refused) | no | PO (§7.3) | step 8 |
| 21 | Governed conversion (incl. the §7.2 held-activation resolution) | C2 | RRD (needs the C1 worker) | no | PO | step 8 |
| 22 | Conversion of committed self-service rows | C2 | EB (`FINANCIAL_TREATMENT_UNDEFINED`, DR-C2-1) | no | **Finance / PO** | a commitment-end treatment decision |
| 23 | Invoice and payment status read | C3 | EB | no | **Stripe** (portal configuration, D18) + **Security / PO** (restricted credential, TD-C3-2) | step 8 |
| 24 | Credits and discounts | C4 | EB | no | **Legal** (PBD §10) + **Finance** (credit policy, TD-C4-18) + **Stripe** (live) | step 8 |
| 25 | Refunds (dual gate, remainder) | C4, C4-R, C4-P, DG | EB | no | **Finance, Legal counsel, Platform Owner** (RX-3); **PO** (D5 key confirmation, gate 1) | RX-4 + step 8 |
| 26 | Tax | C5 | EB (`STRIPE_TAX_NOT_REGISTERED`) | no | **Tax / Finance** (Stripe Tax registration) | a future release |
| 27 | Renewals, outstanding, reconciliation reports | C6 | EC (backend); amount owed needs C3 | no | PO; Stripe (via C3) | steps 3–4 |
| 28 | Self-service cancel via a durable command | C7 | EB (`SELF_SERVICE_TERMS_NOT_APPROVED`) | no | **Legal / counsel** | step 8 |
| 29 | Self-service upgrade | C7 | EB, not delivered even with terms (DR-C7-1) | no | **PO / Architect** (+ Finance proration) | a ruling + a new slice |
| 30 | Live Stripe billing and public signup | all | EB + the §7.3 hold | no | **Stripe** (live keys) + **PO** | step 8 |
| 31 | Non-Sign product catalog (ATS, Intelligence, Portal) | A4, B3 | EB | no | **PO / Finance** (approved pricing, PBD §7.1, §10) | a new commercial decision |
| 32 | Usage roll-ups + consumption analytics | D1 | RRD (`CCP_USAGE_ROLLUP_ENABLED`) | no | PO | step 8 |
| 33 | Revenue report (illustrative list-price value) | D2 | EC | no | PO | steps 3–4 |
| 34 | Operational alerts + metrics | D3, FIX1, R3 | RRD (`CCP_ALERTS_ENABLED`) | no | PO (TD-D3-6) | step 8 |
| 35 | Negative-control, isolation and journey suites; UAT scripts | D4 | EC (test); human UAT not signed | n/a | PO (UAT sign-off) | before step 8 |
| 36 | Runbooks | D5, FIX1 | EC; bootstrap runbook needs a refresh | n/a | Lead | before step 6 |
| 37 | Finance amount redaction (FA-1…FA-9, W-2, W-3) | R3, R3-W | EC | no | PO | steps 3–4 |
| 38 | CCP-FU-1 least-privilege console-entry scope | — | not built (TRACKED, OPEN, PBD §13) | no | **Architect** (accountable) | a later instrument |
| 39 | Break-glass (Conv. C-15; A9 last-owner) | D5 | documentation only (TD-D5-2: C) | n/a | PO | per use |

**Counts (39 capabilities):**
- EC 13: rows 1, 2, 4, 5, 8, 11, 12, 14, 15, 18, 27, 33, 37. Rows 15 and 18 count once merged.
- RRD 11: rows 3, 6, 7, 9, 10, 16, 17, 20, 21, 32, 34.
- EB 9: rows 22, 23, 24, 25, 26, 28, 29, 30, 31.
- Not built or outside CCP 3: rows 13, 19, 38.
- Documentation or test only 3: rows 35, 36, 39.
- Delivered: 0.

## 2. Classification of every open TD / DR item (A / B / C / D)

Classes per the freeze directive (`doc/ccp/decisions.md:504-508`):
- **A** blocking: violates an existing invariant; only A may be implemented;
- **B** external: needs Finance, Legal, Stripe, Tax or another external authority;
- **C** deferred: optional or an unsupported v1 feature;
- **D** resolved: implementation and evidence satisfy it.

"Open" means the item's own record left it for a ruling, confirmation, the Lead, the integrator, the design or an external party. Items recorded as built, with no follow-up asked, are D and listed in the last row of each table. A class written by the slice itself is kept, and noted.

### Phase A

| Item | Gist | Class | Resolution / evidence |
|---|---|---|---|
| **TD-A9-7** | requester attestation only for governance actions | **A (proposed)** | §0 |
| CCP-FU-1 | least-privilege console entry | C | TRACKED, OPEN; the per-role tests stay mandatory (PBD §13; `CCP-D4-acceptance.md:39`) |
| TD-A1-11 | the two "superseded" mappings | D | PO "confirmed as written" (`doc/ccp/decisions.md:11`); Architect ratification not recorded (checklist §4 item 11) |
| TD-A1-12 | stale tenant-read description | D | fixed `025fa7cf` (`doc/ccp/decisions.md:12`) |
| TD-A1-1 | prod catalog 19 / 194 / 973 vs seed | D | handled by the runbook P4 / Q1 |
| TD-A2-1 / -2 / -3 | window edge, ≥, non-USD credit | D | PO rulings (`doc/ccp/decisions.md:15-17`) |
| TD-A2-9 | grace still read from `BILLING_PAST_DUE_GRACE_DAYS` | C | "a later slice"; no slice wired it |
| TD-A2-11, TD-A3-17 | no Pact until A10 | D | A10 coverage gate |
| TD-A3-0, -2, -3, -5, -6 | NC-5; chains; attestation path; requesters; step filling | D | `doc/ccp/decisions.md:18-21`; A9 |
| TD-A3-10, TD-D3-9, TD-C2-11 | lazy expiry, no sweep | D | Architect accepted (`doc/ccp/decisions.md:148`); R3-D39-1 |
| TD-A3-14, TD-B4-7 | MIGRATION-kind requests refused at create | C | ties to DR-A11-1 |
| TD-A4-1, TD-A4-7, TD-A4-10 | composition shape; A3 CHECK | D | accepted (`CCP-A4-acceptance.md:172`); fixed (`:166`) |
| TD-A5-1, TD-A5-9 | pinned-version terms; re-pin history | D | RATIFIED (`doc/ccp/decisions.md:22`, `:25`) |
| TD-A6-3, -5, -12, -13, -14, -18 | apply actor; deadline; tenant copy; catalog apply; guard; DR-A6-1…4 | D | `doc/ccp/decisions.md:36-62`; A6-R; B2-backend; TD-A6-25/26 |
| TD-A6-R-3, TD-A6-R-9 | tenant copy; role path deadline | D | confirmed (`doc/ccp/decisions.md:149`); role actions are in `APPLY_EXPIRABLE_ACTIONS` (`commercial-change-request.ts:289`) |
| TD-A7-3, TD-A7-5 | MIGRATION default; revoke at end | D | R1; R3 alert (`doc/ccp/decisions.md:232`, `:239`) |
| TD-A7-6 | core / ats / portal / intelligence not revocable in v1 | C | v1 limitation |
| TD-A8-1, -3, -5, -6 | PAST_DUE window; eligibility; removal; Stripe-owned overlay | D | `doc/ccp/decisions.md:75-76`, `:152`; R3 |
| TD-A8-4 | frequency and cumulative count every applied overlay ("needs PO confirmation") | C | no ruling recorded; stricter, fail-closed counting |
| TD-A9-1, -16 | role apply in the guard; POLICY_ACTIVATE owner | D | `doc/ccp/decisions.md:23-24`; B5 / B5-R |
| TD-A9-5 | the D9-v1 statement and a non-atomic invite attestation ("PO to confirm") | C | no ruling recorded; fails closed (NOT_HUMAN); also bears on §0 |
| TD-A10-5 | the 401 `consumer_header_mismatch` case not contracted | C | executor choice |
| DR-A11-1 | governed MIGRATION request on execution | C | needed only before the separately authorized execution (rollout step 7b); PO / Architect |
| DR-A11-2 | Astre entitlements stay MIGRATION | C | as above |
| TD-A11-4 | no execute path | C | rollout step 7b |
| TD-A11-1, TD-A11-9 | register row; HALT / REVIEW split | C | for Lead review; no ruling recorded |
| Recorded as built (no follow-up asked) | TD-A1-2…-10, -13, -14; TD-A2-4…-8, -10; TD-A3-1, -4, -7…-9, -11…-13, -15, -16, -18…-22; TD-A4-2…-6, -8, -9; TD-A5-2…-8, -10; TD-A6-1, -2, -4, -6…-11, -15…-17, -19…-26; TD-A6-R-1, -2, -4…-8, -10, -11; TD-A7-1, -2, -4, -7…-10; TD-A8-2, -7…-21; TD-A9-2…-4, -6, -8…-15, -17…-21; TD-A10-1…-4, -6, -7; TD-A11-3, -5…-8, -10 | D | as recorded in each acceptance record |

### Phase B

| Item | Gist | Class | Resolution / evidence |
|---|---|---|---|
| TD-B1-2, TD-B1-8, DV-B2-01, DV-B2-02, TD-B2-3 (UI), TD-B2-6 | dashboard; apply UI; shell mask; SAMPLE; requester-only; de-dup | D | `doc/ccp/decisions.md:57-62`, `:104`; TD-MERGE-5/9 |
| TD-B1-6 | backend data follow-ups (names, versions, roster) | C | design follow-up; scope frozen |
| BOUNDED_EXCEPTION chain label (TD-MERGE-31) | "Below threshold" label | D (once merged) | UI-V12 AM-8 (`wip/ccp-v12:…/CCP-UI-V12-acceptance.md:26`) |
| TD-B2-1 (backend), TD-B2-4 (backend) | version-only retire; draft route | D | `doc/ccp/decisions.md:150`; B2 UI draft routes |
| TD-B3-4, TD-B6-1, TD-B6-4 | design gaps | C | conditional design acceptance (`doc/ccp/decisions.md:151`) |
| TD-B3-7 | grant / revoke only for `sign` | B | approved pricing (PO / Finance) |
| TD-B3-8, TD-C3-1 | Stripe link-outs | B | C3 external |
| TD-B4-1 | evidence bytes not stored | C | needs a design and an ownership ruling |
| TD-B4-2, -3, -4, -10 | chain; RBAC; invoicing; slot | D | `doc/ccp/decisions.md:67-68`, `:274`; apply TTL |
| TD-B5-1, TD-B5-13, TD-B5R-3 | APPLIED state; retry; stuck failure | D | B5-R; ACC-1 |
| TD-ACC1-6 | withdrawal design gap | D (once merged) | UI-V12 D-4 dialog |
| TD-B6-5, TD-B6-11…-13 | apply flag; harness; dialog; scopes | D | TD-MERGE-32 |
| TD-B6-14 | client-side filter | C | recorded |
| Recorded as built | TD-B1-1, -3…-5, -7, -9…-16; DV-B2-03…-05; TD-B2-1, -2, -4, -5, -7, -8 (UI); TD-B2-2, -3, -5 (backend); TD-B3-1…-3, -5, -6, -9…-14, TD-B3-BE-1…-3; TD-B4-5, -6, -8, -9, -11, -12; TD-B5-2…-12, -14…-22; TD-B5R-1, -2, -4…-8; TD-ACC1-1…-5, -7; TD-B6-2, -3, -6…-10, -15…-20 | D | as recorded |

### Phase C

| Item | Gist | Class | Resolution / evidence |
|---|---|---|---|
| TD-C1-3, TD-C3-3 | live key refused | B | Stripe / PO at live release |
| TD-C1-2 | price-change command | C | needs a ruling before any slice |
| TD-C1-7, TD-D3-3, TD-D5-5 | no operator retry route for a FAILED command | C | D5 escalation path (`RUNBOOK-ccp-recovery.md` §5) |
| TD-C1-11 | inbox retention | C | retention ruling |
| TD-C1-13 | drain stops after 10 attempts | C | recorded (D5-OBS-2) |
| TD-C1-4, -5, -9, -10, -15 | expiry; cancel; pending display; stuck alert; scope | D | `doc/ccp/decisions.md:69`; DR-C2-1; B3 / UI-V12; D3; C3 |
| DR-C2-1 | committed self-service rows refused | B | Finance / PO (`doc/ccp/decisions.md:137`) |
| DR-C2-2, DR-C2-3, TD-C2-7, TD-C2-9 | release TTL; usage; deadline naming; downgrade rule | D | `doc/ccp/decisions.md:143-145`; TD-MERGE-21/22 |
| TD-C3-2, TD-C3-4 | credential; D18 verification | B | Security / PO; Stripe |
| TD-C3-5, TD-C6-1, TD-D3-13 | money under `platform:billing:read` | D | Finance amount scope (R3) |
| TD-C4-1, -2, -6, -7, -12, -18; TD-C4R-7 | catalog; chain; discount; redaction; flag; DR-C2-1 boundary; partial refunds | D | Catalog A1 (AC-1, AC-2); `doc/ccp/decisions.md:197-207`; R3 |
| TD-C4-13, TD-C4R-3, TD-C4P-5 | accepted-then-failed refund; PARTIAL held; other reversals | B | refund policy (Finance, Legal) |
| TD-C4-8, TD-C4-16 | no C4 dialogs; pending adjustment not on B3 | C | no design; scope frozen |
| TD-C4P-1, TD-C4P-2, DG-D1 / DG G-4 | "Architect to confirm" | C (DG G-4: D as recorded by DG) | no confirmation recorded; behaviour fails closed |
| TD-C4R-5, TD-C4P-6 | integrator items | D | TD-MERGE-43 |
| TD-C5-1 | `STRIPE_AUTOMATIC_TAX` removal from the prod `.env` | B / ops | at deploy (`doc/ccp/decisions.md:512`); rollout step 4 |
| TD-C5-5, TD-C6-2, TD-D1-11, TD-D2-5, TD-D3-7 | no screens | D (once merged) | UI-V12 |
| TD-C6-3 | amount owed not computed | B | C3 |
| TD-C6-9 | no pagination | C | revisit at scale |
| TD-C6-6, TD-C6-11, TD-C6-12 | revoked detection; typecheck; register | D | `doc/ccp/decisions.md:112`; TD-MERGE-11 |
| DR-C7-1 | upgrade refused | B | PO / Architect + Finance |
| TD-C7-1, TD-C7-5 | nullable origin; command-guard union | D | TD-MERGE-42 / CMDGUARD-1 |
| TD-C7-4, TD-C7-6, TD-C7-7 | no UI; no resume; C2 vs a pending cancel ("Lead") | C | no ruling recorded |
| C7 legal terms | `SELF_SERVICE_TERMS_NOT_APPROVED` | B | Legal / counsel |
| DG G-1 | B5 policy UI for the RX keys | C | as classed by DG |
| DG G-2 | the RX-4 release-checklist step | D | carried into checklist §3.1 |
| DG G-3 | approved refund policy; PO D5 key confirmation | B | as classed by DG |
| D-C8PR-1…-9 | interpretations (Lead to confirm 1–3) | D | as classed by C8-PR (`…/CCP-C8PR-acceptance.md:81-89`) |
| G-C8PR-1, -4 | B4 Payments panel; PAYMENT_RECORD label | C | as classed by C8-PR |
| G-C8PR-2, -3 | runbook and records still on the old counts | C | checklist §3.3 placeholder |
| G-C8PR-5 | redaction coordination with R3-W | B as classed by C8-PR | R3-W is merged (`1d25faad`) and lists PAYMENT_RECORD (`CCP-R3W-acceptance.md:32`); re-verify at the C8-PR merge |
| Recorded as built | TD-C1-1, -6, -8, -12, -14, -16, -17; TD-C2-1…-6, -8, -10, -12, -13; TD-C3-6…-12; TD-C4-3…-5, -9…-11, -14, -15, -17, -19…-22; TD-C4R-1, -2, -4, -6; TD-C4P-3, -4, -7…-9; TD-C5-2…-4, -6, -7; TD-C6-4, -5, -7, -8, -10, -13…-15; TD-C7-2, -3, -8, -9; DG-D2…-D10 | D | as recorded |

### Phase D, corrections and the merge train

| Item | Gist | Class | Resolution / evidence |
|---|---|---|---|
| TD-D1-7 | live reconciliation scans the ledger | C | residual risk |
| TD-D1-R-5 | a trigger remains on the ledger | D | Architect ruling TD-D1-3 (`doc/ccp/decisions.md:59-61`) |
| TD-D2-1, TD-D2-2; W-1 vs D2 | revenue inputs; list-price basis | D | freeze directive (`doc/ccp/decisions.md:513`, `:515`); TD-MERGE-47 |
| TD-D3-2, -6, -9, -10 | thresholds; scanner off; expiry; deadline alert | D | `doc/ccp/decisions.md:147-148`; FIX1 item 4 |
| TD-D3-4, TD-D3-11 | held-reason coverage; inbox grace | C | "Confirm"; no ruling recorded |
| O-D4-1, -2, -3 | policy key path; refusal casing; flake | D | FIX1 items 2 and 6; port binding (`doc/ccp/decisions.md:267-270`) |
| O-D4-4 | coverage limits (7 of 13 reads no-leak only) | C | recorded |
| TD-D5-1 | pre-execution items recorded in the acceptance record | C | no ruling recorded |
| TD-D5-2 | break-glass operation set | C | freeze directive (`doc/ccp/decisions.md:514`) |
| TD-D5-3, TD-D5-6, D5-OBS-3 | one-transaction break-glass; `RELEASE-box.md` `tail -1`; C-15 procedural only | C | for the Lead; not edited |
| TD-D5-4, D5-DEF-1…-3, D5-OBS-4 | compensations; three defects; deadline alert | D | FIX1 |
| TD-R3-1 / D-R3-6 | capacity reserve on open, non-sending rows | C | freeze directive (`doc/ccp/decisions.md:511`) |
| D-R3-1, D-R3-3, D-R3-7 | list prices; requester read-back; discount bps | D | W-1 / FA-3; R3-W requester exception; recorded |
| R3-W DV-3 | provider error text to a non-holder | D | class A, fixed in R3-W (`CCP-R3W-acceptance.md:135`) |
| R3-W G-1, G-2, G-5 | amendment summary; inbox `last_error`; `payload_checksum` | C | as classed by R3-W |
| R3-W G-3 | D2 list-price basis | D | TD-MERGE-47 |
| R3-W G-4 | the UI must render the markers | D (once merged) | UI-V12 W-2 / W-3 |
| TD-R1-3 | helper vs inline fixtures | C | for the Lead |
| TD-MERGE-10 | evidence in the reason | D | accepted (`doc/ccp/decisions.md:146`) |
| TD-MERGE-37 B4 blip | 400 without `error.code` under load | D | later integrated runs green, 787 / 787 (`doc/ccp/decisions.md:565`) |
| UI-V12 DV-V12-W2, -W3 | R3-W markers | D (once merged) | R3-W merged at `1d25faad`; V12 recorded them as B before that |
| UI-V12 DV-V12-3, -5, -6, -8 | missing backend contracts (V12 class B) | C | under the freeze, a new backend contract is not authorized (`doc/ccp/decisions.md:492-495`); listed as MBC-V12-1…14 |
| UI-V12 DV-V12-7, -12, -14, -18…-22 | as classed by V12 | C | `…/CCP-UI-V12-acceptance.md:73-88` |
| UI-V12 DV-V12-W1, -REV-1, -9…-11, -13, -15…-17 | as classed by V12 | D | as above |
| Recorded as built | TD-D1-1…-6, -8…-10; TD-D1-R-1…-4; TD-D2-3, -4, -6…-12; TD-D3-1, -5, -8, -12, -14; TD-R1-1, -2, -4, -5; D-R3-2, -4, -5; DV-R3-1; R3-W DV-1, -2, -4, -5; DV-FIX1-1…-5 | D | as recorded |

**Class counts (table rows in §2; one row may group several IDs):** A 1 (proposed: TD-A9-7) · B 12 · C 37 · D every other row, plus every ID in the "Recorded as built" rows. Production-time and external items are tracked in register §1 and in the rollout plan step 8.

## 3. Final values (the ⟪FINAL⟫ placeholders, filled at the final integrated gate `105b382e`)

- `c8034b4d` (§1 row 15)
- `3b779004` (§1 row 18)
