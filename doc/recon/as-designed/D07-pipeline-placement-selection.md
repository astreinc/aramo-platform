# D07 — Pipeline, Placement & Selection (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under `doc/adr/`. Intent is NOT synthesized from code. Where no ratified in-tree anchor exists, this is stated explicitly.
> Note: two ADR-0029 verbatim quotes contain Tier-2-guarded tokens; those are paraphrased here with a line cite so the reader can confirm the exact wording in the ADR (per `scripts/verify-vocabulary.sh`).

## ADR-0029 — Pipeline Boundary: Modular Monolith, Extract When Forced (ACCEPTED · LOCKED)

Anchors (`doc/adr/0029-pipeline-boundary-modular-monolith.md`; LOCKED mirror `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`):

- **D1** — "The Pipeline stays in the monorepo, with the boundary made HARD." Portability guaranteed by continuously-verified extractability, not physical separation (`doc/adr/0029-pipeline-boundary-modular-monolith.md:33`).
- **D2 / I15** — "the Pipeline⊥ATS import wall (CI-enforced — the load-bearing invariant). The Pipeline intelligence libs MUST NOT directly import the ATS libs... only by UUID reference and through the connector contract (D3) — never a hard import, never a cross-schema FK." Enforced via nx boundary tags (`doc/adr/0029-pipeline-boundary-modular-monolith.md:35`).
- **D3** — "Contract-first L3 seam." Pipeline↔ATS talk only through a first-class, versioned, Pact-tested connector contract, even in-process (`doc/adr/0029-pipeline-boundary-modular-monolith.md:37`).
- **D4** — "Extractability is continuously verified, not assumed" (`doc/adr/0029-pipeline-boundary-modular-monolith.md:39`).
- **D5** — The lib partition is drawn deliberately, including the boundary libs. Intelligence libs = Pipeline; the ATS bucket lists `engagement`, `submittal`, `examination`, `talent_record`, and the recruiter engagement-draft libs (exact term in ADR); `canonicalization` + `consent` sit on the boundary (`doc/adr/0029-pipeline-boundary-modular-monolith.md:41`).
- **Forcing function (§3)** — physical extraction happens only on a real tier-3 client (the first Pipeline-only buyer needing the Pipeline deployed into their own ATS) or an independent-scaling/deployment need; "Tier-3 might exist someday is NOT a forcing function" (`doc/adr/0029-pipeline-boundary-modular-monolith.md:49`).
- **Invariants (§5)** — adds I15; consistent with I1 (UUID-only cross-schema, no FK) and I14 (`identity_index` PII/tenant boundary); no invariant relaxed (`doc/adr/0029-pipeline-boundary-modular-monolith.md:61`).

## ADR-0019 — Manual Recruiter Rating and the R10 Boundary (ACCEPTED)

Anchors (`doc/adr/0019-manual-recruiter-rating-r10-boundary.md`):

- **Rejection ruling (§ Rejection)** — a manual per-talent ordinal rating column was considered and REJECTED; Aramo deliberately does not let recruiters ordinally sort talent (`doc/adr/0019-manual-recruiter-rating-r10-boundary.md:7`).
- **Decision (§Decision)** — row-level triage is the non-ordinal flag; qualitative read is the activity feed (`doc/adr/0019-manual-recruiter-rating-r10-boundary.md:65`).
- **Boundary tripwires (§Boundary tripwires)** — how a reviewer confirms R10 still holds (no ordinal/numeric ordering fields on the Pipeline surface) (`doc/adr/0019-manual-recruiter-rating-r10-boundary.md:101`).

This is the ratified intent behind the pipeline schema's R10 note (no ordinal ordering columns on `Pipeline`).

## ADR-0030 — External Lifecycle Authority (R-INVARIANT · LOCKED)

Anchors (`doc/adr/0030-external-lifecycle-authority.md`) — governs how external/connector events may affect Requisition (and by the no-bypass rule, the governed command seam Pipeline entry-provenance relies on):

- **Decision 1** — "Connectors NEVER DIRECTLY mutate Requisition state" (HARD PROHIBITION) (`doc/adr/0030-external-lifecycle-authority.md:16`).
- **Decision 2** — authoritative external events MAY issue GOVERNED lifecycle COMMANDS (a mapped `TransitionAction`, never a target status) through the canonical transition authority (`doc/adr/0030-external-lifecycle-authority.md:18`).
- **Decision 3** — every external command MUST traverse ADR-0024 policy, CAS/version, the legal transition matrix, the atomic audit event (`origin:'integration'` not `'ui'`), external provenance, tenant isolation, and reconciliation handling — never a silent mutation (`doc/adr/0030-external-lifecycle-authority.md:21`).
- **Decision 4 (Authority modes)** — EXTERNAL_AUTHORITY (Astre default) vs DUAL_CONTROL (`doc/adr/0030-external-lifecycle-authority.md:27`).
- **Consequences** — the reconciler/composer lives in apps/api; "no I15 relevance — all libs are scope:ats" (`doc/adr/0030-external-lifecycle-authority.md:45`).

This is the ratified intent behind the pipeline `PipelineEntryOriginType` / `PipelineEntryProvenance` external-lineage fields and the governed (non-direct) pathway for externally-originated episodes.

## ADR-0033 — Cross-Service Durable Event Foundation

Anchor (`doc/adr/0033-cross-service-durable-event-foundation.md`) — the Outbox→EventBridge→SQS→Lambda durable-async foundation (supersedes ADR-0018 for the intake transport). Relevant to D07 as the ratified target transport for the per-schema `OutboxEvent` streams emitted by pipeline / selection / placement and drained by `libs/outbox-publisher`. The detailed per-event-type contract for D07 aggregates is NOT specified in this ADR.

## No ratified in-tree anchor (stated explicitly)

The following D07 behaviours are implemented and documented in code/comments but have NO ratifying ADR under `doc/adr/`. Their governing directives are LOCKED `.md` files filed in the canonical store (OneDrive `Aramo/locked/`), which are OUT OF TREE and therefore NOT citable here:

- **Pipeline canonical 8-state funnel + evidence-backed milestones** (the Recruiting-Journey Evidence-Governed Milestones directive; §3/§7/§17 referenced in `libs/pipeline/src/lib/pipeline-state.ts:82`). No in-tree ADR.
- **Accidental-Add VOID correction** (Pipeline Void / Accidental-Add Correction Directive; referenced in `libs/pipeline/src/lib/pipeline-state.ts:239`). No in-tree ADR.
- **PlacementProcess lifecycle & acyclicity** (Aramo-Track3-E1a-PlacementProcess-Directive v1.3 LOCKED; referenced in `libs/placement/src/lib/lifecycle/placement-lifecycle.ts:1`). No in-tree ADR.
- **TalentSelection 11-state machine** (M5 PR-1 Directive Amendment v1.1 §2/§4; referenced in `libs/selection/src/lib/selection-state.ts:2`). No in-tree ADR.
- **ClientSelectionProcess / InterviewSession lifecycle** (Lane 2 / L2-F directive; referenced in `libs/client-selection/src/lib/client-selection-state.ts:1`). No in-tree ADR.
- **Placement→Pipeline lifecycle bridge** (Lane 2 / L2-G Part 3 directive v1.2; referenced in `apps/api/src/placement-pipeline-orchestration/placement-lifecycle-orchestrator.service.ts:11`). No in-tree ADR.
- **Offer lifecycle as a dedicated aggregate** (Offer Lifecycle slice #2 / Lane 4 Hiring-Commitment; referenced in `libs/placement/src/lib/lifecycle/placement-lifecycle.ts:20`). No in-tree ADR.

These are recorded so a gap of type `as_built_vs_as_designed` is only ever raised against a ratified in-tree anchor, never against an absent one.
