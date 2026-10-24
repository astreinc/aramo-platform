# D07 — Pipeline, Placement & Selection (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under `doc/adr/` and, for instruments ratified after 2026-10-09, from LOCKED directives in the canonical OneDrive `Aramo/locked/` store (listed in the last section). Intent is NOT synthesized from code. Where no ratified anchor exists, this is stated explicitly.
> Note: two ADR-0029 verbatim quotes contain Tier-2-guarded tokens; those are paraphrased here with a line cite so the reader can confirm the exact wording in the ADR (per `scripts/verify-vocabulary.sh`).

## ADR-0029 — Pipeline Boundary: Modular Monolith, Extract When Forced (ACCEPTED · LOCKED)

Anchors (`doc/adr/0029-pipeline-boundary-modular-monolith.md`; LOCKED mirror `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`):

- **D1** — "The Pipeline stays in the monorepo, with the boundary made HARD." Portability guaranteed by continuously-verified extractability, not physical separation (`doc/adr/0029-pipeline-boundary-modular-monolith.md:33`).
- **D2 / I15** — "the Pipeline⊥ATS import wall (CI-enforced — the load-bearing invariant). The Pipeline intelligence libs MUST NOT directly import the ATS libs... only by UUID reference and through the connector contract (D3) — never a hard import, never a cross-schema FK." Enforced via nx boundary tags (`doc/adr/0029-pipeline-boundary-modular-monolith.md:35`).
- **D3** — "Contract-first L3 seam." Pipeline↔ATS talk only through a first-class, versioned, Pact-tested connector contract, even in-process (`doc/adr/0029-pipeline-boundary-modular-monolith.md:37`).
- **D4** — "Extractability is continuously verified, not assumed" (`doc/adr/0029-pipeline-boundary-modular-monolith.md:39`).
- **D5** — The lib partition is drawn deliberately, including the boundary libs. Intelligence libs = Pipeline; the ATS bucket lists `engagement`, `submittal`, `examination`, `talent_record`, and the recruiter engagement-draft libs (exact term in ADR); `canonicalization` + `consent` sit on the boundary (`doc/adr/0029-pipeline-boundary-modular-monolith.md:34`).
- **Forcing function (§3)** — physical extraction happens only on a real tier-3 client (the first Pipeline-only buyer needing the Pipeline deployed into their own ATS) or an independent-scaling/deployment need; "Tier-3 might exist someday is NOT a forcing function" (`doc/adr/0029-pipeline-boundary-modular-monolith.md:49`).
- **Invariants (§5)** — adds I15; consistent with I1 (UUID-only cross-schema, no FK) and I14 (`identity_index` PII/tenant boundary); no invariant relaxed (`doc/adr/0029-pipeline-boundary-modular-monolith.md:61`).

### ADR-0036 — Talent Intelligence as an Independent Service (Accepted, 2026-10-23)

Anchors (`doc/adr/0036-talent-intelligence-service.md`):

- **Supersedes** ADR-0029 `:63` for Talent Intelligence only — the forcing function for a separate TI deployable is named in its Decision 2 (`doc/adr/0036-talent-intelligence-service.md:12`, `:59`).
- **Admission contract, Class C** — requisition, pipeline, submittal and interview data are never admitted to Talent Intelligence (`doc/adr/0036-talent-intelligence-service.md:141`, `:146`). The D07 aggregates therefore stay ATS-owned; no Pipeline, selection or placement fact crosses into the TI store.
- It does not change the ADR-0029 statement that `libs/pipeline` (scope:ats) is outside the I15 wall; it moves the TI libs, not the ATS funnel.

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

The following D07 behaviours are implemented and documented in code/comments but have no in-tree ADR under `doc/adr/`. Where a canonical LOCKED directive governs them, it is listed in the next section:

- **Pipeline canonical 8-state funnel + evidence-backed milestones** (the Recruiting-Journey Evidence-Governed Milestones directive; §3/§7/§17 referenced in `libs/pipeline/src/lib/pipeline-state.ts:82`). No in-tree ADR; anchored canonically by Talent-Lifecycle A1 D-1 (`Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md:22`, which explicitly supersedes the missing milestones record) and Implementation Directive v1.2 §7.
- **Accidental-Add VOID correction** (Pipeline Void / Accidental-Add Correction Directive; referenced in `libs/pipeline/src/lib/pipeline-state.ts:239`). No in-tree ADR.
- **PlacementProcess lifecycle & acyclicity** (Aramo-Track3-E1a-PlacementProcess-Directive v1.3 LOCKED; referenced in `libs/placement/src/lib/lifecycle/placement-lifecycle.ts:1`). No in-tree ADR.
- **TalentSelection 11-state machine** (M5 PR-1 Directive Amendment v1.1 §2/§4; referenced in `libs/selection/src/lib/selection-state.ts:2`). No in-tree ADR.
- **ClientSelectionProcess / InterviewSession lifecycle** (Lane 2 / L2-F directive; referenced in `libs/client-selection/src/lib/client-selection-state.ts:1`). No in-tree ADR.
- **Placement→Pipeline lifecycle bridge** (Lane 2 / L2-G Part 3 directive v1.2; referenced in `apps/api/src/placement-pipeline-orchestration/placement-lifecycle-orchestrator.service.ts:11`). No in-tree ADR.
- **Offer lifecycle as a dedicated aggregate** (Offer Lifecycle slice #2 / Lane 4 Hiring-Commitment; referenced in `libs/placement/src/lib/lifecycle/placement-lifecycle.ts:20`). No in-tree ADR.

These are recorded so a gap of type `as_built_vs_as_designed` is only ever raised against a ratified anchor (in-tree or canonical LOCKED), never against an absent one.

### Canonical LOCKED anchors ratified after 2026-10-09 (OneDrive `Aramo/locked/`)

Read for this refresh. They are canonical, not in-tree; gaps may cite them by file and section. Where an amendment and its parent differ, the amendment governs for the clause it names.

- **Aramo-Talent-Lifecycle-PO-Rulings-R1-R5-Recon-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-20) — §1 R1 "On hold: recruiting continues, client submittal stops"; R2 "A two-way Zoom call must not automatically advance Talent to 'Talent responded'"; R4 "Closed and Canceled are terminal"; R5 RTR policy inherits the tenant default.
- **Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md** (LOCKED 2026-10-20; supersedes the earlier LOCKED clauses it names) — AM-1 §2.2 the requisition-status → Pipeline-activity table (ADD / CONTACT_SEND / CONTACT_EVIDENCE allowed on open, on_hold, lead; RESPONSE and QUALIFY_DECISION allowed on open and on_hold only; all denied on closed/canceled; the `lead` row is PROVISIONAL, D-2); AM-1 §2.4 historical recording on Closed/Canceled; AM-4 §5 Talent responded needs a recruiter-confirmed, substantive response; AM-6 §7 RTR policy resolution with an UNRESOLVED state and atomic enforcement. AM-5 (verified inbound application establishes Contacted) is deferred by the implementation directive §8 (S5).
- **Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md** (LOCKED 2026-10-20):
  - §2.1 facts owned by documents, communications or client-submittal policy reach `libs/pipeline` only through string-token ports bound at `apps/api`; no new nx edge; the Pipeline⊥ATS wall is kept.
  - §2.2 T-2 global lock order (client-submittal-policy advisory lock shared → submittal → Pipeline → requisition → documents); T-3 bounded transactions with 409 `TRANSACTION_CONFLICT_RETRYABLE` and no automatic retry; T-6 a pre-transaction decision is valid only if the locked re-read returns the same status.
  - §3 S0: `/transition` refuses `completed` (`PIPELINE_COMPLETE_SYSTEM_ONLY`); Add Talent denies an unresolved requisition (`REQUISITION_NOT_FOUND`) and requires the Talent to exist in the tenant.
  - §4.3–§4.6 S1: the `qualified` transition takes the shared policy lock first, then the CAS, then resolves the RTR requirement at the linearization instant and locks the executed RTR `FOR SHARE`; UNRESOLVED refuses (`PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED`); the applied RTR decision is audited in the transaction.
  - §5.2–§5.5 S2: the requisition gate inside `transition()` and `create()` (requisition `FOR SHARE`); on closed/canceled forward targets and ordinary backward corrections are denied, a governed final disposition and the `ADDED_BY_MISTAKE` VOID are allowed (§12 C-2), and system downstream commands are ungated.
  - §7.1–§7.2 S4: evidence ingestion is independent of progression (Zoom stops auto-advancing; provider `RESPONSE_EVIDENCE` retired); the per-stage evidence allowlist; reference verification; provider observations need a durable verified receipt (§12 C-4).
  - §8: S5 (inbound application) DEFERRED.
- **Aramo-Pipeline-RTR-Recon-Remediation-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-21 by PO; builds on v1.2 + A1) — R1 (DEF-5/DEF-6) Not in consideration only via a governed disposition with a reason; R3 DEF-9 Add Talent conceals a hidden requisition as 404 (C-1 changes S0's 403 to 404), DEF-10 voided episodes never count, DEF-15(b) re-add after an ended episode only for `pipeline:re-add` holders (4 roles); R4 DEF-15(d) site match on the talent-response route, DEF-15(f) backward corrections into evidence-backed stages allowed with a required note when history already holds the evidence (D-2 Option A); R5 DEF-15(e) document the live Pipeline and Talent Journey endpoints in OpenAPI.
- **Aramo-DOC-TEMPLATE-ADMIN-RTR-1-Tenant-Document-Template-Administration-RTR-Governed-Template-v1_0-LOCKED.md** (LOCKED 2026-10-16) — the Qualified transition requires an EXECUTED RTR when the client policy requires one, gated at the authoritative transition owner (the code cites §29-32); refined by v1.2 §4 above.
- **Aramo-ATS-QA-1-Package-1-Implementation-Directive-v1_0-LOCKED.md** + **Aramo-ATS-QA-1-Package-1-Conforming-Amendments-v1_0-LOCKED.md** (filed LOCKED with `.sha256` sidecars; ATI-SEP-1 §2 records their in-file "RATIFICATION-READY" status as historical) — I-1 D5 counts use the collapsed current set; I-5 the requisition résumé may be chosen when adding Talent, with server checks on edition ownership, tenant, status, `pipeline:resume:set` and requisition visibility; amendment A4 grants `pipeline:resume:set` additionally to lead_recruiter, recruiting_manager and sourcer (supersedes TI-1D-D §2 for that clause); A5/A6 display label "Not contacted" for `no_contact` with canonical state unchanged.
- **Aramo-Talent-Intelligence-Enterprise-Architecture-Delivery-Directive-v1_0-LOCKED.md** (TIP-E2E v1.0, LOCKED 2026-10-12) — §0 journey ends Pipeline → Client Submittal; §1.1 examination is mandatory for client submittal; no autonomous Pipeline action (§7).
- **ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md** (LOCKED, filed 2026-10-16) — §3.1/§3.2 subject-bound erasure branches on the append-only Pipeline and ClientSelectionEvent tables (cited by the two S2 migrations); activation is not authorized.
