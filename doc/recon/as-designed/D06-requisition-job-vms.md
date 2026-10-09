# D06 — Requisition, Job & VMS (AS-DESIGNED ANCHORS)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

AS-DESIGNED intent below is sourced ONLY from ratified LOCKED directives / ADRs
present in `doc/adr/*`. The detailed per-track requisition directives (Track 1
lifecycle, Lane 1 Req-Lifecycle A–F, Job-Module, SRC-2 distribution, Track 3 /
Lane 5 pre-start, VMS Integration v1.0) live at the canonical OneDrive `locked`
store, NOT in this repo — so those anchors are marked NO IN-REPO ANCHOR and must
not be synthesized from code.

## ADR-0030 — External Lifecycle Authority (ACCEPTED/LOCKED, PO ratified 2026-08-26)

Source: doc/adr/0030-external-lifecycle-authority.md.

- Decision §1 (doc/adr/0030-external-lifecycle-authority.md:16): Connectors NEVER
  directly mutate `Requisition` state — no connector/integration code may
  PATCH/update a requisition or write `RecruitingStatus` directly (HARD
  PROHIBITION).
- Decision §2 (:18): authoritative external lifecycle events MAY issue GOVERNED
  lifecycle COMMANDS — a mapped `TransitionAction` (CLOSE / REOPEN / PUT_ON_HOLD
  / CANCEL / …), NEVER a target status — through the canonical transition
  authority (the same gate → CAS → atomic lifecycle-event pipeline humans use).
- Decision §3 (:20): every external command MUST traverse and never bypass
  ADR-0024 policy (fail-closed), CAS/version concurrency, the legal transition
  matrix (`governingAction`), the atomic audit event stamped honest
  `origin:'integration'`, structured external provenance, tenant isolation, and
  reconciliation handling (unsupported / contradictory / illegal-from-state /
  CAS-conflict → reconciliation queue, never a silent mutation).
- Decision §4 (:26): per-connection AUTHORITY MODES — `EXTERNAL_AUTHORITY`
  (Astre default; invokes the governed command) and `DUAL_CONTROL` (records
  intent / pending reconciliation; does NOT auto-complete).
- Decision §5 (:33): the command chain — provider event → normalization →
  connection/client MAPPING CONTRACT → authority mode → mapped action → governed
  command seam → gateTransition → CAS → lifecycle event (origin=integration) →
  external provenance; else reconciliation queue. Direct-write path remains
  forbidden.
- Consequences (:40): reconciler/composer lives in `apps/api`
  (connector-in-app); connector service account gains authority scoped to the
  command seam, NOT general `requisition:edit`; splits into D1 (contract/seam/
  data-model) and D2 (real event intake + ordering/idempotency + reconciliation
  execution).

## ADR-0029 — Pipeline-ATS Boundary (LOCKED)

Source: doc/adr/0029-pipeline-boundary-modular-monolith.md and
doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md.
Relevant to D06 as a NEGATIVE constraint: Pipeline libs never hard-import ATS
libs; cross-L3 by UUID ref + versioned Pact-tested connector contract only. The
requisition/integration libs stay ignorant of each other; the composition meets
only in `apps/api` (consistent with ADR-0030 consequences). ADR-0030 itself
states I15 is "not implicated" for the lifecycle seam (all libs scope:ats)
(doc/adr/0030-external-lifecycle-authority.md:7).

## ADR-0024 — Business Policy Engine (LOCKED)

Source: doc/adr/0024-business-policy-engine.md. The requisition lifecycle policy
is DATA published to policy-store; the engine EVALUATES, the domain EXECUTES
(evaluator ≠ authority). §D17a provenance (why a command was permitted) and
§D17c append-only lifecycle event (whether/how the change applied) are distinct
records. The seeded requisition package
(apps/api/src/policy/requisition-lifecycle.package.ts) cites §D2/§D13/§D17 and an
ADR ERRATUM (the ADR's own Submit resource / override-capability identifiers use
a Tier-2-banned token and are replaced by canonical PR-4b forms).

## ADR-0015 Amendment v1.2 — JD & GoldenProfile Generation (ISSUED for ratification)

Source: doc/adr/Aramo-ADR-0015-Amendment-v1_2-JD-Generation-LOCKED.md.

- Decision 10 REVISED: the declared LLM consumers become (1) engagement draft
  and (2) NEW — JD & GoldenProfile generation in `libs/requisition` (and/or a
  `libs/job-domain` generation surface) → `AiDraftService`. All other
  parse/inference surfaces stay deterministic (no LLM).
- G1: human-in-the-loop draft → review/edit → confirm; nothing AI-generated is
  committed to the canonical Requisition/GoldenProfile without an explicit
  recruiter confirm.
- G2: idempotency + persisted audit; the draft endpoint re-mints on prompt
  change; confirm is idempotent keyed on the draft event.
- NOTE: the ADR header states "ISSUED for ratification" (not ACCEPTED). The
  as-built implements the draft/confirm endpoints
  (requisition.controller.ts:437,459) and the pre-creation intake lane
  (controller.ts:262).

## ADR-0019 — Manual Recruiter Rating & the R10 Boundary (REJECTED, NOT ratified)

Source: doc/adr/0019-manual-recruiter-rating-r10-boundary.md. A per-talent
ordinal rating surface is REJECTED as a product moat: no rating column, no
rating PATCH route; the "this one matters" need is served by the existing
non-ordinal `is_hot` flag (never a sort key, never aggregated) and the activity
note feed. D06 as-built honors this: `is_hot` is a boolean governed by a
SET_PRIORITY policy, not an ordinal.

## ADR-0018 — Background Jobs Substrate (LOCKED)

Source: doc/adr/Aramo-ADR-0018-Background-Jobs-Substrate-v1_0-LOCKED.md. Decision
1 governs the manualRegistration + onApplicationBootstrap Redis-gate worker
lifecycle that the reconciliation-drain processor follows
(reconciliation-drain.processor.ts:25).

## NO IN-REPO ANCHOR (explicit)

The following as-built surfaces have NO ratified anchor inside `doc/adr/*` at
this SHA; their governing directives are external (OneDrive `locked`) and were
NOT read. Intent is therefore not asserted here:

- Track 1 T1-a..T1-e requisition lifecycle (RecruitingStatus crosswalk, governed
  transitions, CAS version, lifecycle event) — code cites "Track 1" directives.
- Amendment B Approval sub-workflow (SUBMIT_FOR_APPROVAL / APPROVE / REJECT, SoD).
- Lane 1 Req-Lifecycle A–F / L1-A..L1-F2 (establishment authority modes,
  write-visibility parity, policy-store token isolation).
- FIX 6 CLOSE_SUBMITTALS governed transition (package v7.0.0).
- Job-Module Directive v1.0 (enterprise fields, financial-planning gating, LB-2
  GoldenProfile seam).
- SRC-2 (job distribution / channel posting), PR-14/15/17, Requisition Record
  Spec Amendment v1.0, Work Location Autocomplete WL-B1.
- Track 3 / Lane 5 pre-start-requirement directives (L5-P3..P8).
- VMS Integration Directive v1.0 (T8-P1 external identity) and L1-D3-A VMS
  lifecycle mapping administration.
- Track 4 T4-B2 capacity cutover (openings_available derivation).
