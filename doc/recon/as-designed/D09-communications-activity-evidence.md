# D09 — Communications, Activity & Recruiting Evidence (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

AS-DESIGNED anchors are drawn ONLY from ratified ADRs under `doc/adr/*`, LOCKED
directives under `doc/directives/*`, and ratified LOCKED directives in the
canonical store (OneDrive `Aramo/locked`). No intent below is synthesized from
code. Where no ratified anchor exists for a code-expressed behavior, that is
stated explicitly rather than invented. Where an amendment overrides its parent,
the amendment governs and that is said.

## Ratified anchors (present and readable)

### ADR-0029 — Pipeline Boundary (Modular Monolith)
- `doc/adr/0029-pipeline-boundary-modular-monolith.md` — ratifies the Pipeline⊥ATS
  wall: Pipeline libraries do not hard-import ATS libraries; cross-boundary
  composition is by UUID reference and versioned connector contract, enforced by
  nx boundary tags. This grounds the AS-BUILT design choice that the
  communication→pipeline milestone advance is orchestrated at the apps/api
  composition root (`TalentResponseService`, `CommunicationCallService`,
  `microsoft-email.service`) and that the evidence verifier is an apps/api
  adapter behind a `libs/pipeline` port, rather than a
  `libs/pipeline → libs/communications` edge.
- `Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md` (canonical
  LOCKED copy) is the ratified form of the same boundary ruling.
- `doc/adr/0036-talent-intelligence-service.md` (Accepted 2026-10-23) supersedes
  ADR-0029 :63 for Talent Intelligence only; it does not change the
  Communications / Pipeline wall that D09 relies on.

### ADR-0031 — Conversation Intelligence Architecture
- `doc/adr/0031-conversation-intelligence-architecture.md:24` — ratifies that
  `libs/communications` OWNS the `CommunicationInteraction` system-of-record plus
  the idempotent provider-event inbox. This is the designed home of the
  communication SoR that D09 extends with recruiter-attested evidence.
- `doc/adr/0031-conversation-intelligence-architecture.md:52` — ratifies REUSE of
  existing primitives (`activity.Activity`, interaction-bound
  `CommunicationDisposition.notes`) for recruiter-approved output, authorizing
  exactly one new CI draft-content carrier. Establishes the design posture that
  activity + disposition are the evidence/annotation substrate (no parallel
  store).

### Lane 2 / L2-H — Unified Talent Journey Read Model (LOCKED)
- `Aramo-Talent-Pipeline-Lane2-H-Unified-Talent-Journey-Read-Model-Directive-v1_0-LOCKED.md:69`
  — ratifies the GET-only journey read model with **owner-specific actions and no
  generic status control**: "Moving the Talent forward always means invoking the
  owning aggregate's own governed command"; the journey endpoint issues zero
  writes and exposes available actions as metadata. This is the design anchor for
  the AS-BUILT `TalentJourneyReadService` and its `actions` /
  `recruiting_available_actions` emission.
- `Aramo-Talent-Pipeline-Lane2-H-Unified-Talent-Journey-Read-Model-Directive-Amendment-v1_1-LOCKED.md`
  — the ratified v1.1 amendment under which the current read-composer operates.

### Lane 2 / L2-C — Recruiter Lifecycle (LOCKED)
- `Aramo-Talent-Pipeline-Lane2-C-Recruiter-Lifecycle-Directive-v1_0-LOCKED.md` —
  the ratified recruiter named-action surface (START_QUALIFICATION / QUALIFY /
  DISPOSITION) that the AS-BUILT `RECRUITER_ACTION_TO_STATUS` implements, and the
  partition of recruiter decision edges from system-only COMPLETE.

### Talent Lifecycle R1–R5 — Amendment A1 + Implementation Directive v1.2 (LOCKED 2026-10-20)
The governing source for the evidence-backed milestones at this SHA.
- `Aramo-Talent-Lifecycle-R1-R5-Amendment-A1-Dispositions-and-Superseding-Amendments-v1_0-LOCKED.md`
  §1 D-1 — records that the original Evidence-Governed Milestones directive
  (PR #903) is missing from every store and **explicitly supersedes it** on the
  named points; if the original text is found later it is filed unchanged and A1
  still prevails.
- A1 §5 AM-4 (`:97-127`) — **supersedes** the PR #903 Zoom/voice convergence
  (a call reaching `connected`/`completed` no longer establishes Talent responded),
  the L2I `RESPONSE_EVIDENCE → talent_responded` convergence, and
  COMM-C2A :89-93 (no disposition alone establishes Talent responded). New rule:
  three separate facts (communication happened / it contains a relevant response /
  the Talent reaches Talent responded); only an authorized recruiter
  confirmation — bound to the Pipeline entry, carrying an explicit
  substantive-response attestation and either a reviewed source communication or
  a recruiter-authored note — establishes Talent responded. Admissible evidence is
  a per-stage allowlist whose referenced row must match tenant, Talent and
  requisition; history is append-only and earlier automatic advances stay
  recorded. C2A :134-135 ("MUST NOT automatically advance
  `contacted → talent_responded`") is reaffirmed.
- A1 §6 AM-5 (`:129-149`) — Contacted may also be established by a verified,
  recruiter-accepted inbound application (`inbound_application`); its
  implementation (S5) is DEFERRED by v1.2 §8.
- `Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md` §7 (S4,
  `:548-700`):
  - §7.1 — evidence ingestion is independent of progression: remove the Zoom
    automatic advance; a persisted `RESPONSE_EVIDENCE` mapping takes an explicit
    retired branch (`RESPONSE_EVIDENCE_RETIRED`).
  - §7.2 — the per-stage allowlist (`contacted` ← `communication_interaction`,
    `recruiter_response_confirmation`, `provider_observation` only with a durable
    verified receipt; `talent_responded` ← `recruiter_response_confirmation` only);
    the mandatory `EVIDENCE_REFERENCE_VERIFIER` port bound in apps/api
    (`verifier_unbound` refusal); every provider observation stays pending
    `EVIDENCE_NOT_DURABLE` until a durable-receipt ingress exists.
  - §7.3 — `reconcileForward` runs all hops in one transaction.
  - §7.4 — the confirmation command: recruiter USER principal only; DTO adds
    `substantive_response_attested: true` and `source_interaction_id`; note required
    without a source; non-substantive source dispositions refused
    (`source_not_substantive`); additive `response_confirmed` disposition and
    `source_interaction_id` column; both times and the reviewer preserved.
  - §7.5 — on a Closed/Canceled requisition a response that occurred before the
    closing instant is appended and never advances (`advanced: false`); a later one
    is refused `REQUISITION_NOT_ADVANCEABLE`.
  - §7.6 — FE attestation checkbox, note-or-source rule, reviewer and time shown.
- `Aramo-Talent-Lifecycle-PO-Rulings-R1-R5-Recon-Directive-v1_0-LOCKED.md` — the
  PO rulings R1–R5 that A1 amends.

### Pipeline & RTR Recon Remediation Directive v1.0 (LOCKED 2026-10-21)
- `Aramo-Pipeline-RTR-Recon-Remediation-Directive-v1_0-LOCKED.md` §2 R4
  (`:107-111`):
  - DEF-15(d) — `POST /v1/communications/talent-responses` gets
    `@RequireSiteMatch()`.
  - DEF-15(f) / D-2 Option A — a backward correction into an evidence-backed
    stage is allowed without new evidence when the episode's history already holds
    admissible evidence for that stage; a correction note is required; otherwise
    422 `PIPELINE_STAGE_REQUIRES_EVIDENCE`.
  - D-1 Option C (`:121-136`) — a confirmation that starts at `no_contact` requires
    the Talent's contact consent; refused 422 `PIPELINE_EVIDENCE_INADMISSIBLE`
    `consent_required_from_no_contact`; no consent check from `contacted` onward.

### COMM program directives (LOCKED, canonical store)
- `Aramo-COMM-V1-Communications-Voice-Directive-v1_0-LOCKED.md` — provider-neutral
  voice interaction SoR and disposition vocabulary (the `communication-enums.ts`
  domain mirrors).
- `Aramo-COMM-C2A-Zoom-Voice-Engagement-Evidence-Directive-v1_0-LOCKED.md` — the
  Zoom voice engagement-evidence orchestration the webhook path mirrors.
  **Amended by A1 AM-4**: its :89-93 two-way-evidence dispositions are superseded;
  :134-135 is reaffirmed.
- `Aramo-COMM-C2B-Microsoft-Email-Teams-Delegated-Authorization-Directive-v1_0-LOCKED.md`
  — the Microsoft email send path whose acceptance triggers the governed
  `no_contact → contacted` advance.
- `Aramo-COMM-C2B-Amendment-A1-Outlook-Scheduling-v1_0-LOCKED.md` (ratified
  2026-10-10; repo copy `doc/directives/Aramo-COMM-C2B-Amendment-A1-Outlook-Scheduling-v1_0-LOCKED.md`,
  byte-identical) — amends C2B R8/R15/R17 for M365-SCHED-1:
  - §2.1 / R4 — a separate opt-in scheduling scope set adds `Calendars.ReadWrite`;
    the baseline set and create-link-only / send-only paths are unchanged.
  - §2.2–§2.3 / R1 — Talent-directed calendar invitations are outbound contact and
    must pass the existing `communication → contacting` consent gate, fail closed.
  - R2 — scopes `communication:meeting:read|edit|cancel` added; mutation also
    enforces organizer ownership and tenant isolation.
  - R3 — durable scheduling-operation identity persisted BEFORE the Graph call;
    Graph `transactionId` where supported; explicit unresolved-operation state; no
    blind re-create after an unknown outcome; reschedule/cancel target the existing
    provider event.
  - R5 — durable scheduling audit within Communications using `@@schema("audit")`;
    no tokens or secrets.
  - R6 — reads may return last-known provider state and must not be presented as
    live Outlook state; Outlook-originated sync deferred.
  - §4 — recruiter screening / qualification / follow-up meetings belong to
    Communications; client interviews stay with Client Selection; `CalendarEvent`
    must not be repurposed; **scheduling does not independently advance Pipeline
    stages**.
- `ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md` Part E (as C2B Amendment A2) and Part F
  (`:323-368`) — adds the separately opt-in `meeting_artifacts` delegated
  capability (Teams transcript / recording read) and, for screening meetings, the
  association Talent × `screening_session` with Requisition optional; preserves
  create-link-only as the default, the consent gate, the idempotency ledger,
  last-known-state reads and no Pipeline advancement.
- `Aramo-COMM-C4-Requisition-Contextual-Email-Compose-v1_0-LOCKED.md` — the
  requisition-contextual email compose + durable content-capture the email
  evidence rests on.
- `Aramo-COMM-RECRUITER-W1-Recruiter-Communications-Wave-1-v1_0-LOCKED.md` — the
  General-Talent-Contact email draft surface (`email-drafts/general-contact`).
- `Aramo-COMM-EMAIL-TEMPLATE-GOVERNANCE-1-Recruiter-Selector-Governance-v1_0-LOCKED.md`
  — email-template governance (code-default + tenant-override).

### Activity / RN-1 (LOCKED)
- `Aramo-RN-1-Amendment-A1-ActivityNoteEvent-Ledger-v1_0-LOCKED.md` — ratifies the
  append-only `ActivityNoteEvent` lifecycle ledger as RN-1-owned (NOT libs/audit),
  DB-level immutable, IDs/enums/counts only (no content). This is the design
  anchor for `libs/activity/prisma/schema.prisma:183` and the ledger writes in
  `activity.repository.ts`.
- `ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md` (ratified
  2026-10-16) — **amends RN-1-A1** (its supersession table row for RN-1-A1):
  DELETE is additionally admitted under the subject-bound erasure authorization
  for talent-subject notes only; UPDATE stays rejected. It also records the
  tenant-reset `ActivityNoteEvent` correction (ruling F4). Where RN-1-A1 says
  "UPDATE and DELETE are rejected", this amendment governs for those two
  escapes.

### Engagement / Communications CRM lane (LOCKED)
- `Aramo-TM-L7-Engagement-Communications-CRM-Directive-v2_1-LOCKED.md` — the lane
  framing for engagement communications and CRM primitives.

## Anchors NOT present / NOT verified (explicit)

- **Original Recruiting-Journey Evidence-Governed Milestones directive (PR #903)**
  — still not located in the repo or the canonical store. It is no longer an
  unanchored gap: Talent Lifecycle R1–R5 A1 §1 D-1 records the loss and
  supersedes it on the named points, and v1.2 §7 ratifies the current evidence
  rules. Rules from PR #903 that A1/v1.2 do NOT restate (for example the
  `EVIDENCE_BACKED_STAGES` membership and the §14 `recruiting_available_actions`
  contract as originally worded) remain anchored only by A1's references to the
  PR #903 record and by L2-H for the actions metadata.
- No ADR under `doc/adr/*` ratifies the `calendar` or `contact` library designs
  directly; their LOCKED directives (if any) were not located in this pass.
  C2B-A1 §4 constrains `CalendarEvent` only negatively (not to be repurposed as the
  Outlook sync authority).
