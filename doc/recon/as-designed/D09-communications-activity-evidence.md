# D09 — Communications, Activity & Recruiting Evidence (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

AS-DESIGNED anchors are drawn ONLY from ratified ADRs under `doc/adr/*` and
ratified LOCKED directives in the canonical store (OneDrive `Aramo/locked`). No
intent below is synthesized from code. Where no ratified anchor exists for a
code-expressed behavior, that is stated explicitly rather than invented.

## Ratified anchors (present and readable)

### ADR-0029 — Pipeline Boundary (Modular Monolith)
- `doc/adr/0029-pipeline-boundary-modular-monolith.md` — ratifies the Pipeline⊥ATS
  wall: Pipeline libraries do not hard-import ATS libraries; cross-boundary
  composition is by UUID reference and versioned connector contract, enforced by
  nx boundary tags. This grounds the AS-BUILT design choice that the
  communication→pipeline milestone advance is orchestrated at the apps/api
  composition root (`TalentResponseService`, `ZoomWebhookService`,
  `microsoft-email.service`) rather than by a `libs/communications → libs/pipeline`
  edge.
- `Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md` (canonical
  LOCKED copy) is the ratified form of the same boundary ruling.

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

### COMM program directives (LOCKED, canonical store)
- `Aramo-COMM-V1-Communications-Voice-Directive-v1_0-LOCKED.md` — provider-neutral
  voice interaction SoR and disposition vocabulary (the `communication-enums.ts`
  domain mirrors).
- `Aramo-COMM-C2A-Zoom-Voice-Engagement-Evidence-Directive-v1_0-LOCKED.md` — the
  Zoom voice engagement-evidence orchestration the webhook path mirrors.
- `Aramo-COMM-C2B-Microsoft-Email-Teams-Delegated-Authorization-Directive-v1_0-LOCKED.md`
  — the Microsoft email send path whose acceptance triggers the governed
  `no_contact → contacted` advance.
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

### Engagement / Communications CRM lane (LOCKED)
- `Aramo-TM-L7-Engagement-Communications-CRM-Directive-v2_1-LOCKED.md` — the lane
  framing for engagement communications and CRM primitives.

## Anchors NOT present / NOT verified (explicit)

- **Recruiting-Journey Evidence-Governed Milestones directive** — the LOCKED
  directive that ratifies the `PIPELINE_STAGE_REQUIRES_EVIDENCE` evidence gate,
  the EVIDENCE_BACKED_STAGES set (`contacted`, `talent_responded`), the §16
  recruiter-attested response, and the §14 `recruiting_available_actions` contract
  was NOT located as a readable file under `doc/adr/*` and was NOT identifiable by
  name among the canonical OneDrive `Aramo/locked` directory listing at this SHA.
  The code cites it as "Recruiting-Journey §5/§7/§8/§14/§16/§17 (LOCKED)" and
  invariants "I1–I6", but those section numbers could not be verified against
  ratified spec text in this read-only pass. Treated as an unverified anchor — see
  the gap fragment (type `as_built_vs_as_designed` is NOT asserted here because no
  contradiction was found; the anchor is simply unlocated).
- No ADR under `doc/adr/*` ratifies the `calendar` or `contact` library designs
  directly; their LOCKED directives (if any) were not located in this pass.
