# D06 — Requisition, Job & VMS (AS-DESIGNED ANCHORS)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

AS-DESIGNED intent below is sourced ONLY from ratified instruments: the
LOCKED directives / ADRs present in `doc/adr/*`, and the LOCKED directives in
the canonical OneDrive `Aramo/locked/` store that were ratified after
2026-10-09 and govern this domain (listed under the last section). The older
per-track requisition directives that pre-date 2026-10-09 (Track 1 lifecycle,
Lane 1 Req-Lifecycle A–F, Job-Module, SRC-2 distribution, Track 3 / Lane 5
pre-start, VMS Integration v1.0) also live at the canonical store; they were not
re-read in this refresh and stay marked NO IN-REPO ANCHOR. Intent is never
synthesized from code.

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
- Refinement by the Talent Lifecycle R1–R5 instruments (canonical, see last
  section): `executeExternalLifecycleCommand()` refuses any status change from
  `closed`/`canceled` (409 `REQUISITION_STATUS_TERMINAL`) and an external REOPEN
  of a closed requisition is refused at the seam and routed to reconciliation
  (Impl Directive v1.2 §5.7, via A1 AM-2); a VMS hold is recorded with source
  `vms` and the provider reason only when supplied (v1.2 §6.3, reconciliation
  C-3 in §12).

## ADR-0029 — Pipeline-ATS Boundary (LOCKED)

Source: doc/adr/0029-pipeline-boundary-modular-monolith.md and
doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md.
Relevant to D06 as a NEGATIVE constraint: Pipeline libs never hard-import ATS
libs; cross-L3 by UUID ref + versioned Pact-tested connector contract only. The
requisition/integration libs stay ignorant of each other; the composition meets
only in `apps/api` (consistent with ADR-0030 consequences). ADR-0030 itself
states I15 is "not implicated" for the lifecycle seam (all libs scope:ats)
(doc/adr/0030-external-lifecycle-authority.md:7).

### ADR-0036 — Talent Intelligence as an Independent Service (Accepted, 2026-10-23)

Source: doc/adr/0036-talent-intelligence-service.md. It supersedes ADR-0029
`:63` for Talent Intelligence only (doc/adr/0036-talent-intelligence-service.md:12).
Its admission contract lists requisition, pipeline, submittal and interview
data as Class C — never admitted to Talent Intelligence
(doc/adr/0036-talent-intelligence-service.md:141,146). For D06 this bounds the
TIP-E2E INC-2 requisition-context read seam: requisition facts are read by the
ATS-side adapter under requisition visibility; they are not transferred into the
Talent Intelligence store.

## ADR-0024 — Business Policy Engine (LOCKED)

Source: doc/adr/0024-business-policy-engine.md. The requisition lifecycle policy
is DATA published to policy-store; the engine EVALUATES, the domain EXECUTES
(evaluator ≠ authority). §D17a provenance (why a command was permitted) and
§D17c append-only lifecycle event (whether/how the change applied) are distinct
records. The seeded requisition package
(apps/api/src/policy/requisition-lifecycle.package.ts) cites §D2/§D13/§D17 and an
ADR ERRATUM (the ADR's own Submit resource / override-capability identifiers use
a Tier-2-banned token and are replaced by canonical PR-4b forms). The Talent
Lifecycle R1–R5 Impl Directive v1.2 §10 RP-2 requires a PO-authorized governed
v8 publish plan for production tenants still on package v7; the code-level
terminal rule enforces AM-2 regardless of the published data.

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
- NOTE: the ADR header still states "ISSUED for ratification" (not ACCEPTED)
  (doc/adr/Aramo-ADR-0015-Amendment-v1_2-JD-Generation-LOCKED.md:5; file
  unchanged since the old baseline). The as-built implements the draft/confirm
  endpoints (requisition.controller.ts:467,489) and the pre-creation intake lane
  (controller.ts:292).

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
this SHA; their governing directives are external (OneDrive `locked`) and
pre-date 2026-10-09, and were NOT re-read in this refresh. Intent is therefore
not asserted here:

- Track 1 T1-a..T1-e requisition lifecycle (RecruitingStatus crosswalk, governed
  transitions, CAS version, lifecycle event) — code cites "Track 1" directives.
- Amendment B Approval sub-workflow (SUBMIT_FOR_APPROVAL / APPROVE / REJECT, SoD).
- Lane 1 Req-Lifecycle A–F / L1-A..L1-F2 (establishment authority modes,
  write-visibility parity, policy-store token isolation).
- FIX 6 CLOSE_SUBMITTALS governed transition (package v7.0.0; the package is now
  v8.0.0 under the R1–R5 instruments below).
- Job-Module Directive v1.0 (enterprise fields, financial-planning gating, LB-2
  GoldenProfile seam).
- SRC-2 (job distribution / channel posting), PR-14/15/17, Requisition Record
  Spec Amendment v1.0, Work Location Autocomplete WL-B1.
- Track 3 / Lane 5 pre-start-requirement directives (L5-P3..P8).
- VMS Integration Directive v1.0 (T8-P1 external identity) and L1-D3-A VMS
  lifecycle mapping administration.
- Track 4 T4-B2 capacity cutover (openings_available derivation).

### Canonical LOCKED anchors ratified after 2026-10-09 (OneDrive `Aramo/locked/`)

These were read for this refresh. Where an amendment and its parent differ, the
amendment governs for the clause it names.

- **Aramo-Talent-Lifecycle-PO-Rulings-R1-R5-Recon-Directive-v1_0-LOCKED.md**
  (LOCKED 2026-10-20). R1 "On hold: recruiting continues, client submittal
  stops" (§1 R1); R4 "On hold can resume; Closed and Canceled are terminal"
  (§1 R4). PO product intent; reconciled by A1 below.
- **Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md**
  (LOCKED 2026-10-20; overrides the earlier LOCKED clauses it names).
  AM-2 §3 "Closed is terminal": a reopened hiring need is a new requisition.
  AM-3 §4 hold details: a hold carries its reason and source. AM-1 §2.2: the
  requisition-status → Pipeline-activity table (`lead` row PROVISIONAL, D-2).
- **Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md**
  (LOCKED 2026-10-20; precedence A1 > PO rulings > Lead reviews > this
  directive, §0.1).
  - §2.2 T-1/T-3/T-6: a status writer re-reads its row `FOR UPDATE` inside its
    own transaction; every touched transaction sets `timeout`/`maxWait`; lock /
    deadlock / timeout aborts map to 409 `TRANSACTION_CONFLICT_RETRYABLE`, never
    an automatic retry; a decision is valid only if the locked re-read returns
    the same status.
  - §2.3: requisition status writers (PATCH and external seam) take requisition
    `FOR UPDATE` → CAS, and lock nothing else.
  - §5.4: submit vs hold — the submit reads the requisition `FOR SHARE` so a
    `PUT_ON_HOLD` cannot commit under an in-flight submit.
  - §5.6: requisition-scoped email, call and RTR request/send/remind are gated
    `CONTACT_SEND` before the external send.
  - §5.7 (AM-2): `update()` and `executeExternalLifecycleCommand()` refuse any
    status change from `closed`/`canceled` with 409 `REQUISITION_STATUS_TERMINAL`
    (registered in §2.4), including changes to `lead`/`draft`; package v8.0.0
    sets REOPEN from `closed` to DENY for data consistency; an external REOPEN
    of a closed requisition is refused at the seam and routed to
    reconciliation; `on_hold` → `open` is unchanged.
  - §6 (S3, AM-3): ADD-only hold columns on the lifecycle event; a manual
    PUT_ON_HOLD requires reason + source; a VMS hold keeps a missing provider
    reason as NULL (§12 C-3); the detail read shows "not recorded" for legacy
    holds.
  - §10 RP-2: production inventory of tenants on package v7 and a governed v8
    publish plan are release prerequisites (PO-authorized separately).
- **ARAMO-TIP-E2E-INC-2-v1.0-LOCKED.md** (LOCKED 2026-10-13) §3.1/§4 with
  **ARAMO-TIP-E2E-INC-2-v1.0-RECONCILIATION-ADDENDUM-001.md** (canonically
  filed and Architect-accepted per its FILING-ACK of 2026-10-13; its embedded
  DRAFT status line is superseded by that acknowledgment). The
  requisition-context read port reads requirements from the
  `requisition_id`-keyed `RequisitionSkillRequirement` surface by a thin read
  method (no migration), and its batch summary read applies the authoritative
  requisition visibility predicate itself. The addendum (Option A) rules that
  the requisition visibility predicate has no site axis, so no site filter is
  applied there (it overrides the INC-2 §3.1 "+ site" wording).
- **Aramo-TIP-E2E-INC-1-Security-and-Handoff-Integrity-Directive-v1_0-LOCKED.md**
  (LOCKED 2026-10-12) §2 INC-1b: submittal create resolves the requisition
  under actor visibility and site server-side (the D06 contribution is the
  lightweight visibility read).
- **Aramo-ATS-QA-1-Package-1-Implementation-Directive-v1_0-LOCKED.md** (filed
  LOCKED with a `.sha256` sidecar; ATI-SEP-1 §2 records that its in-file
  "RATIFICATION-READY" status line is historical) §4 I-1 row D4: requisition
  pickers use server-side search and paging, label title · requisition number
  · client, statuses open / on_hold / lead per A1 AM-1, and hidden
  requisitions are not enumerable.
