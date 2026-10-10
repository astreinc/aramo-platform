# Aramo — Visual Architecture Synchronization Governance v1.0

> **Status:** governance document (process definition). **Deployment:** N/A.
> **Authority:** ratified by Architect Ruling "Aramo Visual Architecture
> Synchronization Governance v1.0 — APPROVED WITH AMENDMENTS."
> This document extends Aramo's **existing** governance; it introduces no new CI
> workflow, service, database, or automated diagram generation.

## Purpose

Keep the **Aramo Visual Architecture Library** synchronized with implementation
changes through a lightweight, GitHub-mediated, **engineer-managed** process that
is **manual and evidence-backed**. Claude Code produces an architecture-impact
handover for every prospective implementation PR; a designated engineer
periodically reviews merged handovers and directs Claude Design to update the
Library; the Architect and PO retain review authority.

## Responsibility model (each authority is distinct)

| Layer | Artifact | Owns |
|---|---|---|
| Historical architecture | Full Repository Baseline Recon — `doc/recon/` @ `12330b0f` | Frozen historical evidence (never rewritten) |
| Transition reconciliation | `doc/architecture/visual-index/TRANSITION-RECONCILIATION.md` | One-time bridge: PRs merged after the baseline through governance activation |
| Prospective handovers | `doc/architecture/handovers/PR-<number>.md` | Per-PR, pre-merge record of **actual** implementation impact |
| Synchronization progress | `doc/architecture/visual-index/SYNC-REGISTER.md` | Sync cycles, dispositions, checkpoints — **not** architectural decisions |
| Semantic decision history | `doc/governance/history/Aramo-Architecture-Change-History.md` | Retirements/supersessions — the existing authority (unchanged) |
| Visual Architecture Library | `doc/architecture/visual-index/` (diagrams/views, when supplied) | Reviewed architecture views + evidence references (a **projection**, not a lifecycle authority) |

A handover is **input to synchronization**; it is **not** architecture approval
and **must not** change any artifact's lifecycle state. The SYNC-REGISTER records
*process*; material architectural retirement/supersession is recorded through the
existing `Aramo-Architecture-Change-History.md` process, not here.

## Three evidence identities (do not conflate)

- **Evidence baseline:** `12330b0f5049c97f01022df0b190035933345212` — the SHA the
  historical architecture evidence (`doc/recon/`) is pinned to.
- **Baseline publication:** PR #912 — the PR that *committed* the recon snapshot.
  (A PR merged after the evidence baseline but before #912 is still a transition
  PR; the window is computed from the **evidence baseline**, not the publication PR.)
- **Governance activation:** the eventual **merge commit SHA + merge date of this
  governance PR**. Unknown before merge → recorded as `ACTIVATION_PENDING` until
  the synchronization engineer stamps the real value post-merge.

## Historical & transition governance

- **Pre-baseline PRs** (represented by `doc/recon/` @ `12330b0f`) require **no
  retrospective handover**. `doc/recon/` is their evidence.
- **Transition window** `(12330b0f .. ACTIVATION]` is covered by **one
  consolidated** `TRANSITION-RECONCILIATION.md` — **not** individual handovers —
  folded into the **initial** synchronization cycle.
- The **governance PR itself** is recorded as an **administrative activation
  event**, not an implementation PR, and requires **no** retrospective handover
  (avoids a circular requirement).

## Prospective governance (from activation onward)

Beginning at the governance activation SHA, **every implementation PR must include
an architecture-impact handover before merge** — even when the impact is
`NO_IMPACT`. The handover contract and PR-number handling are defined in
[`handovers/TEMPLATE.md`](handovers/TEMPLATE.md) and
[`handovers/README.md`](handovers/README.md). Enforcement rides the existing
[`doc/06-lead-review-checklist.md`](../06-lead-review-checklist.md) (review-depth
tiers and approval authority unchanged) and the
[`.github/pull_request_template.md`](../../.github/pull_request_template.md)
reminder. **No CI gate is added.**

## Engineer-managed synchronization cycle

1. Identify PRs merged since the last SYNC-REGISTER checkpoint (GitHub merged-PR
   list ∩ `doc/architecture/handovers/`).
2. Verify each handover against the actual merged diff.
3. Group by affected architecture domain (Visual-Index artifact IDs when
   available, else `doc/recon/` domains D01–D15).
4. Direct Claude Design to update the relevant Library artifacts.
5. Coordinate Architect/PO review.
6. Record completion or deferral in the SYNC-REGISTER and advance the checkpoint
   per the rule below.

### Checkpoint advancement (Amendment A)

A checkpoint advances when **every PR in the synchronization range is accounted
for and dispositioned** — **not** when every diagram update is finished. A
deferred diagram update does **not** block advancement provided it is recorded
with an **owner, reason, and follow-up obligation**. This prevents one complex
artifact from permanently blocking synchronization.

## Historical traceability

When Claude Design needs historical implementation evidence, begin at
`doc/recon/` and follow its repository references to the relevant source files,
contracts, directives, or historical PRs. **Missing evidence is marked
`NOT VERIFIED`, never inferred.** The frozen reconnaissance baseline is **never
rewritten** to incorporate subsequent implementation changes.

## Exceptions

- **`NO_IMPACT` fast path:** documentation-only, test-only, and non-major
  dependency PRs file a one-line handover (Tier-1 per the review checklist).
- **Infrastructure PRs:** handover required; may carry topology impact — classify,
  do not auto-`NO_IMPACT`.
- **Emergency/hotfix PRs:** the handover may be filed retroactively within 24h and
  recorded `deferred→filed` in the SYNC-REGISTER.
- **Material architecture changes:** require a full handover, may trigger an
  out-of-cycle synchronization and Architect review; the
  retirement/supersession is recorded in `Aramo-Architecture-Change-History.md`.

## Non-goals

No automatic diagram generation, no synchronization service, no new CI workflow,
no new database, no blanket vocabulary allowlist. The Visual Index directory may
initially hold only the synchronization and transition records; **missing Phase 3
design artifacts are not invented or imported** by this process.
