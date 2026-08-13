*Aramo T2 — Selection / Submittal Track Closure Record — DRAFT (pending PO ratification)*

**ARAMO**

*Talent Intelligence and Entrustment Platform*

**Track 2 — Selection / Submittal Track Closure Record**

*Governance close-out of Track 2 — the Engagement→Selection canonicalization*

**VERSION 1.0 — DRAFT (pending PO ratification)**

Classification: Internal — Aramo Program

August 13, 2026

> **Note on status.** This file is the markdown working draft produced by
> Gate 5 of T2-P4 (governance close-out). Post-merge, per the closure-record
> convention (see `doc/m0-closure-record-draft.md` / `doc/m1-closure-record-draft.md`),
> this is converted to `.docx` and filed by the Business Analyst at the canonical
> OneDrive location as `Aramo-T2-Closure-Record-v1_0-LOCKED.docx`. The Product
> Owner ratifies via the §9 block at the bottom; the closure formally takes
> effect upon PO signature. **T2-P4 performs NO product-code, migration, or
> production change — governance/documentation reconciliation only.**

# Document Control

## Purpose

This document is the filed substrate artifact for the Track 2 (Selection /
Submittal) governance close-out (increment T2-P4). It records: the Track-2
scope and history; the final canonical architecture; the public-contract and
persistence/migration state on `main`; the T2-P3 correction lineage discovered
and resolved during T2-P3B; the T2-P3B merge + CI evidence; the zero-residual
classification and the distinct non-Selection `engagement` concepts explicitly
retained; the intentional repository-vs-production migration-baseline divergence
and its fail-closed guard; the separately-governed production reconciliation
boundary; and the enterprise-maturity disposition.

It exists because Track 2 implementation is complete on `main` and the program
requires an explicit, auditable close-out that keeps **repository truth** and
**deployment truth** distinct: repository closure is not production promotion.

## Status

**DRAFT — Version 1.0.** Pending PO ratification. Upon ratification this record
is filed as `LOCKED — Version 1.0` at the canonical OneDrive location.

## Authority

Architect owns Track-2 closure doctrine, correction lineage, and scope
disposition. PO is the sole ratifying authority for track closure. Execution
authority for T2-P4: `Aramo-T2-P4-Governance-Close-Out-Directive-v1_0-LOCKED`.

## Substrate basis

`origin/main` at close-out = `743769243e96a1919ae6be874bd742ca2c42bb5f`
(PR #617 merge). This closure record describes the repository state at that
commit. Production state is described only as of the last governed read-only
recon (2026-08-09) and is temporally separate from repository closure.

## Approver

| Role | Authority | Signature | Date |
|---|---|---|---|
| Product Owner | Sole ratifying authority for track closure | [to be filled in by PO] | [to be filled in by PO] |

---

# A. Scope

Track 2 = the Selection / Submittal domain: canonicalization of the
pre-submittal talent-to-job workflow from the legacy `engagement` vocabulary to
the canonical `Selection` vocabulary, plus the Submittal-schema separation and
the pre-GA migration rebaseline. T2-P4 is a governance close-out only — it
reopens no closed technical decision, ships no product code, and authorizes no
production action.

# B. Track history

| Increment | Substance | State |
|---|---|---|
| **T2-P1** | Submittal schema canonicalization / relocation (`engagement`→`submittal` schema) | MERGED / NOT DEPLOYED |
| **T2-P2** | Selection domain canonicalization — persistence/state/repositories moved from `libs/engagement` to `libs/selection` | MERGED / NOT DEPLOYED |
| **T2-P3** | Public Selection contract flip — `/v1/engagements`→`/v1/selections`, `engagement:*`→`selection:*`; public Selection contract canonical | MERGED / NOT DEPLOYED |
| **T2-P3B** | Pre-GA naming completion + Selection-native migration rebaseline (PR #617) | MERGED / NOT DEPLOYED |
| **T2-P4** | Track-2 governance close-out (this record) | GOVERNANCE CLOSE-OUT — close-out record pending merge |

# C. Final canonical architecture

**Selection is the one canonical pre-submittal talent-to-job workflow domain.**
It owns the 11-state workflow (`surfaced`, `evaluated`, `engaged`, `maybe`,
`passed`, `awaiting_response`, `responded`, `in_conversation`, `not_interested`,
`ready_for_submittal`, `submitted`), state-transition enforcement, the
message-delivery workflow, response recording, conversation progression, the
workflow event history, and the workflow provenance consumed by Evidence /
Submittal. There is **no separate current Engagement domain**. `libs/selection`
is canonical; `libs/engagement` and `@aramo/engagement` are **absent**.

# D. Public contract state

Canonical routes `/v1/selections*`; `selection:*` scopes (read / write /
message-delivery). No live `/v1/engagements` route remains. OpenAPI (ats +
common) is Selection-native. Contract parity is carried in §R.

# E. Persistence / migration state

`selection` schema owns `TalentSelection` / `TalentSelectionEvent` (column
`selection_id`); `submittal` schema owns Submittal. Evidence owns
`selection_event_refs`. **REPOSITORY MIGRATION BASELINE: CLOSED / CANONICAL** —
the six Engagement-first Selection migrations were replaced by the single
Selection-native `20260525120000_init_selection_model`; a fresh database
bootstraps Selection directly (no `engagement` schema, no create-then-rename).
The Evidence init migration creates `selection_event_refs` directly.
**PRODUCTION MIGRATION STATE: AWAITING SEPARATE RECONCILIATION** (§K/§M).

# F. T2-P3 correction lineage

See the formal record in `### T2_P3_CORRECTION_LINEAGE` below. In summary: the
T2-P3 predicate ("`engagement_event_refs` occurs 0 times in `openapi/ats.yaml`,
therefore outside the public Selection rename authority") was based on an
ats.yaml-only search that missed `openapi/common.yaml`, where the field existed
and was reachable through the public Submittal/Evidence endpoints. T2-P3's
route/scope/public-Selection flip remains valid and was NOT invalidated as an
implementation outcome; T2-P3B supplied the Architect-authorized corrective
normalization `engagement_event_refs`→`selection_event_refs`. The historical
LOCKED T2-P3 artifact is NOT rewritten; this closure record carries the
correction.

# G. T2-P3B merge evidence

**PR:** #617. **Merge commit:** `743769243e96a1919ae6be874bd742ca2c42bb5f`
(standard two-parent merge). **Parents:**
`92deced63f9303122f8b578c7f518d9bf231d319` (prior `main`) and
`c21918ba93db762e6babd8382471a0d570b1c462` (authorized exact PR head).

# H. CI evidence

PR #617 exact-head CI: run `31668060062`, **39/39 successful** on head
`c21918ba93db762e6babd8382471a0d570b1c462`. Required gates included: `build`,
`test:unit`, `tests:integration`, `verify:vocabulary`, `contract-parity:check`,
`aggregate-gate:check`, `deployment-gate`. `deployment-gate` success proves gate
readiness only — **it is not evidence that a deployment occurred.**

# I. Zero-residual verification

`UNACCEPTABLE_SELECTION_WORKFLOW_ENGAGEMENT_RESIDUAL = 0`. Precise closure
claim: **zero unacceptable former Engagement/Selection-workflow terminology
remains in active shipping implementation.** This is NOT a claim that the
repository contains zero occurrences of the English word `engagement` — distinct
valid concepts (§J) and historical governance/prose remain by design.

# J. Distinct retained `engagement` concepts (NOT the retired workflow)

1. `EvidenceReference.entity_type = 'engagement'` — governance-locked evidence
   dimension (Group 2 §2.4), not the retired workflow domain. **RETAIN.**
2. Talent employment `engagement_type` — employment-relationship classification
   (contract / contract-to-hire / direct-hire). **RETAIN.**
3. `CLIENT_NOT_ELIGIBLE_FOR_REENGAGEMENT` — client-talent-restriction
   vocabulary. **RETAIN.**
4. Ordinary English use and historical governance prose. **RETAIN.**

Track-2 closure does not imply these should later be renamed to obtain a raw
grep of zero.

# K. Production divergence (carry forward — DO NOT fix here)

The repository ships the Selection-native migration baseline; production still
contains the pre-rebaseline Engagement-era migration ledger/schema state.
Phrased correctly: **the last governed production recon (2026-08-09)
established** — production migration ledger `public._local_migrations`
(key = relative migration-directory path); historical Engagement-era migrations
applied; T2-P2 relocation NOT applied at recon time; `selection` schema absent
at recon time; relevant Engagement/Selection workflow rows = 0; persisted
`engagement.state_transition` rows = 0; non-empty `engagement_event_refs`
rows = 0; unrelated production data present (2 tenant rows, 7 `TalentRecord`
rows); classification **P1** for the Selection/Engagement blast radius.
Production state is temporally separate from repository closure and was NOT
re-queried during T2-P4.

# L. Fail-closed release guard (closed implementation control)

`tools/db-sync-local.sh` contains a fail-closed protection that detects the
superseded Engagement-era migration-path ledger against the Selection-native
repository baseline. It is **read-only**, does **not auto-repair**, and
**blocks rather than silently migrates**. Its purpose is to prevent the
Selection-native baseline from being interpreted as ordinary unapplied
migrations against unreconciled production. Production reconciliation still
requires separate authority. Any behavior change to this guard is out of T2-P4
scope.

# M. Production reconciliation boundary

**PRODUCTION_RECONCILIATION: REQUIRED BEFORE FIRST PROMOTION OF THE
SELECTION-NATIVE MIGRATION BASELINE.** **AUTHORIZATION: NOT GRANTED BY T2-P4.**
It remains a separate governed release operation. The canonical non-executable
runbook is `doc/runbooks/t2p3b-selection-rebaseline-prod-reconciliation.md`.
T2-P4 references it but does not execute it, convert it to deployment authority,
add executable production commands, or mutate production / `_local_migrations` /
schemas.

# N. Enterprise maturity disposition

See `### ENTERPRISE_MATURITY_DELTA` below. T2-P3B eliminated the old-Engagement
compatibility surface pre-GA, so **no new maturity debt is created** for
Engagement compatibility, dual-scope, or Selection aliasing. Production
reconciliation is an operational release prerequisite, not automatically an
enterprise-maturity debt item.

# O. Deployment status

**MERGED / REPOSITORY-CLOSED / GOVERNANCE-CLOSED (upon T2-P4 merge) /
NOT DEPLOYED / PRODUCTION RECONCILIATION PENDING.** No `DEPLOYED`, `PROMOTED`,
`PRODUCTION COMPLETE`, `GA LIVE`, or `PRODUCTION CLOSED` state is claimed or
implied.

# P. Closure declaration

**TRACK 2 IMPLEMENTATION / GOVERNANCE:** CLOSED

**TRACK 2 PRODUCTION RECONCILIATION:** OPEN AS SEPARATE RELEASE OPERATION

**TRACK 2 DEPLOYMENT:** NOT AUTHORIZED / NOT PERFORMED BY THIS CLOSURE

---

### T2_P3_CORRECTION_LINEAGE

**Original statement:**
`engagement_event_refs occurs 0 times in openapi/ats.yaml and was treated as outside the public Selection rename authority.`

**Why incomplete:**
`the ats.yaml-only search missed the openapi/common.yaml public surface.`

**Corrected substrate fact:**
`the field existed in openapi/common.yaml and was reachable through the public Submittal/Evidence endpoints (POST /v1/submittals request body + GET .../evidence-package required response).`

**Impact on T2-P3:**
`the route/scope/public-Selection flip outcome remains valid; T2-P3 was not invalidated as an implementation outcome.`

**Resolution:**
`T2-P3B renamed engagement_event_refs -> selection_event_refs end-to-end (Architect-authorized pre-GA breaking normalization).`

**Historical LOCKED artifact modified:** NO

**Closure record carries correction:** YES

---

### ENTERPRISE_MATURITY_DELTA

**Created:** none
**Changed:** none
**Closed:** none
**Carried:** existing register unchanged

---

### PRODUCTION_SAFETY

`PRODUCTION MUTATION PERFORMED: NO`
`PRODUCTION MIGRATION PERFORMED: NO`
`PRODUCTION LEDGER MODIFIED: NO`
`PRODUCTION DEPLOYMENT PERFORMED: NO`
`PRODUCTION RESET PERFORMED: NO`

---

# §9. PO Ratification

By signing below, the Product Owner ratifies this Track 2 closure record and
its closure declaration (§P). Ratification closes Track 2 governance; it does
NOT authorize production reconciliation or deployment, which remain separate
governed release operations.

| Role | Ratification | Signature | Date |
|---|---|---|---|
| Product Owner | Track 2 governance closure | [to be filled in by PO] | [to be filled in by PO] |
