# ADR-0024 — Amendment A1: Capacity Binding and Vocabulary Corrections

- **Status:** **Accepted — LOCKED** (PO-ratified, 2026-08-01)
- **Amends:** ADR-0024 (Business Policy Engine, LOCKED 2026-07-30) — §D1, §D4, §D5, §D13, §D13b, §D13c, §D19, the v1 matrix, and Register items 5 and 7
- **Program:** Requisition Enterprise Program, amendment **A1–A4** as one controlled amendment (PO ruling 5)
- **Precedes:** Track 1 implementation. This lands **before** any Track 1 code.

> **Why one amendment, not four.** ADR-0024 is being opened for the capacity binding regardless. An earlier draft of the Planning Package deferred the vocabulary and rationale corrections to "whenever it next opens." It is open now. Deferring corrections to a document already being edited is the drift this program exists to eliminate.

---

## A1 — Capacity binds to reservation AND consumption

**Supersedes §D13c's single-phase capacity model.**

ADR-0024 asked for *"an authoritative capacity-consuming record"* and correctly refused to assume one existed. Recon proved **none exists** — no placement, hire, offer, assignment or commitment model anywhere. The Requisition Enterprise Program defines it, and it has **two phases**, not one.

**Reservation.** A `PlacementProcess` in a reserving state — offer accepted, pre-start, ready-to-start — **reserves** an opening. The client has selected someone; the opening is spoken for; recruiters must stop submitting against it.

**Consumption.** A started `ContractAssignment` or `PermanentPlacement` **consumes** an opening. The person is working.

**A person must never count twice.** When a `PlacementProcess` starts, its reservation releases as the resulting Assignment consumes.

**When it falls through** — background check not cleared, no-show, client rescinds, counteroffer — the reservation releases, **the history remains**, and *replacement authorization is evaluated independently*. **Capacity release is not authorization to recruit again.** Those are two facts and the domain tracks both.

## A2 — §D13c's stage-rename rationale is FALSE; the ruling stands on better grounds

**§D13c states:** capacity must never key on pipeline stage names *"which tenants can rename."*

**Tenants cannot rename them.** `PipelineStatus` is a fixed Postgres enum with eleven values. No tenant stage-rename table exists. The stated reason is factually wrong.

**The ruling is unchanged, for the correct reason:** `placed` records **that someone moved a card**, not that a person accepted an offer and started work. Between acceptance and day one sit the background check, the drug screen, the client's paperwork, the counteroffer and the no-show. A workflow position is not a commitment fact, and capacity must key on the fact.

## A3 — Prohibited `submission` identifiers replaced

**`submission` is a Tier-2 banned term.** `verify-vocabulary.sh` gates *product source*, not `doc/`, which is why ADR-0024 merged clean while carrying identifiers that **cannot be implemented** — a future implementer following the ADR literally hits the CI gate.

| ADR-0024 text | Canonical |
|---|---|
| `REQUISITION_SUBMISSION · CREATE` | **`REQUISITION_SUBMITTAL · CREATE`** |
| `requisition.override.submission_closed` | **`requisition.override.submittal_closed`** |
| `SUBMISSIONS_DECLARED_CLOSED` | **`SUBMITTALS_DECLARED_CLOSED`** |
| reason code *"late-recorded submission"* | **`late_recorded_submittal`** |
| §D4 future package *"Submission"* | **"Submittal"** |

**Prose occurrences** in §D13, the matrix notes and Register items 5 and 7 read *"submissions"* and are corrected to *"submittals"* for consistency. They are not CI failures — `doc/` is out of scope for the gate — but leaving them invites the identifiers back.

**PR-4b shipped the canonical forms already**, having hit the gate during implementation. The ADR is what was wrong, not the code.

## A4 — `openings_reserved` added to `resource_state`

**Narrower than the amendment register stated.** `capacity_balance` and `over_capacity_by` are **already present** in §D13b. Only `openings_reserved` is missing — and the balance formula must subtract it.

**§D13b's capacity block is superseded by:**

```
status                declared    lifecycle intent
openings              authored    planned capacity
openings_reserved     derived     count(PlacementProcess in a reserving state)     [NEW]
openings_consumed     derived     count(Assignment | PermanentPlacement, started)
capacity_balance      derived     openings − openings_reserved − openings_consumed  [FORMULA CHANGED]
openings_available    derived     max(capacity_balance, 0)
over_capacity_by      derived     max(−capacity_balance, 0)
```

Unchanged and reaffirmed: the balance is **signed and retained** — clamping erases *how far* capacity is exceeded, and policy needs *exactly full* vs *one over* vs *five over*. The no-negative invariant applies to the **displayed** value, never the balance.

## A5 — `full` splits; §D1 and §D13's "exception" framing superseded

**§D13 calls `full` "the exception"** and §D1 defers Lifecycle v2 behind a named trigger. The Requisition Enterprise Program is that trigger, and it is authorised.

`full` conflates **submittals declared closed** (a declaration) with **openings exhausted** (derived). The program separates them:

- **`RecruitingStatus`** — declared, stored, human-selected. Includes `SUBMITTALS_CLOSED`.
- **`CapacityStatus`** — derived, never stored as a lifecycle label, never selectable. `AVAILABLE` · `FULLY_RESERVED` · `FULLY_CONSUMED` · `OVER_CAPACITY`.

**The v1 matrix's `full` row is superseded at Track 1.** Until then it stands as written — gating on **declaration**, never capacity, exactly as §D13 requires.

**Register item 5 is CLOSED** by this amendment.

## A6 — `user_requisition_bookmark` → `user_requisition_state`

**§D19 names the bookmark table `user_requisition_bookmark`.** The ratified Directive Set (PR-14/PR-16) rules it **`user_requisition_state`** — one personal-state table carrying `bookmarked_at`, with `last_viewed_at` added additively by PR-16, rather than two tables for one concern.

**§D19's substance is unchanged and reaffirmed:** HOT is team-wide and requisition-scoped; Bookmark is personal and invisible to others; Watch is future. **A star must never toggle `is_hot`.**

---

## What is NOT amended

**Everything else stands.** The stateless evaluator · two-library split · policies-as-data · invariants-outside-the-engine · resource+action identifiers · the D6 prohibition on actions encoding policy outcomes · monotonic composition · two-pass override · multi-package composition · PROPOSE/DISPOSE · command-scope-only · the three provenance records · D18's transition rules.

**In particular §D3 is untouched.** Invariants remain compile-time, CI-enforced and unreachable from the policy layer. Nothing in the Requisition Enterprise Program makes an invariant policy-configurable.

## Consequences

**Positive.** Capacity has a real definition for the first time. The reservation/consumption split makes *"three people accepted"* and *"three people are working"* separately answerable — different numbers, both operationally meaningful. The ADR's identifiers become implementable.

**Negative.** PR-6 (capacity-keyed policy) now depends on the program's Track 3 and Track 4 rather than a single commitment record. That is a longer path, and it is the honest one — the shorter path gated on a number nobody could trust.

**Neutral.** No change to the engine, the store, provenance, override, the shipped matrix or `is_hot` governance. PR-1 through PR-5 and PR-7 are merged and unaffected.

## Register

1. **`doc/03-refusal-layer.md` should state the broader R10 rule.** R10 as written is a Portal boundary; the ADR-0019 rejection extended it to *"Aramo does not let recruiters rate or ordinally sort talent"* regardless of surface. Carried from ADR-0027.
2. **`verify-vocabulary.sh` does not gate `doc/`.** That is why this ADR shipped with unimplementable identifiers. Whether governance documents should be gated is a separate decision — but the gap is now known, and it will recur.
