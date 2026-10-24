# D05 — Talent Domain (Record, Evidence, Intake, Trust) (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

Ratified intent only, cited from in-repo `doc/adr/*` and, where stated, from
LOCKED directives filed to OneDrive `Aramo/locked` (cited by exact filename and
section; their text is summarized, not synthesized from code). Where an
amendment overrides its parent, the overriding instrument is named.

## ADR-0033 — Cross-Service Durable Event Foundation
Source: `doc/adr/0033-cross-service-durable-event-foundation.md` (Status:
Accepted, 2026-10-07).

- **Decision 1 (§48–75):** Canonical cross-service transport is Outbox →
  EventBridge → consumer-owned SQS. PostgreSQL remains the authoritative
  transactional system of record; the outbox is written in the same DB tx and
  drained via an `OutboxPublisherPort`. Delivery is at-least-once; every
  consumer is idempotent. Business code must not call AWS SDKs directly.
- **Decision 2 (§76–92):** Orchestration is application-owned by default;
  Step Functions only where durable branching/waits/compensation earn it. A
  state machine may own execution state but NEVER authoritative Talent business
  state, which always lives in `TalentIntakeDraft`, `ResumeExtractionDraft`,
  `TalentRecord`.
- **Decision 3 (§93–122):** Compute runtime is Lambda-first behind a
  runtime-neutral `TalentIntakeMessageHandler.handle(event)`; Fargate is the
  approved fallback. A production-closure checklist (artifact-size bound,
  bounded extraction duration, explicit LLM timeout below the Lambda budget,
  explicit Anthropic SDK retry config, SQS visibility alignment, idempotency,
  bounded concurrency, DLQ + alarms) is required and NOT satisfied by merely
  wrapping today's processor.
- **Decision 4 (§124–135):** Canonical versioned envelope (`event_id`,
  `event_type`, `event_version`, `tenant_id`, `source`, `subject_type`,
  `subject_id`, `occurred_at`, `correlation_id`, `causation_id`, `payload`).
  `tenant_id` is routing/context, NOT authorization — every consumer
  revalidates ownership. Envelope columns added additively (ADD-not-rename).
- **Decision 5 (§136–149):** Talent Intake is behaviorally source-agnostic.
  Job boards, sourcing, agents, integrations, bulk import, external APIs must
  enter the SAME governed Talent Intake authority WITHOUT fabricating an S3
  upload, via a stable `source_ref` / `source_event_id` idempotency seam with
  an OPTIONAL artifact. Invariant: many sources may create Talent Intake, but
  **only the Talent domain authority may create or promote canonical
  `TalentRecord` state** — a job-board/sourcing/agent/import service must never
  independently write `TalentRecord`.
- **Decision 6 (§151–161):** Preserved durable intake semantics — this is a
  transport/platform refactor, not a product rewrite. `TalentIntakeDraft`
  processing/review lifecycle, `ResumeExtractionDraft` as the governed
  extraction/evidence child, persisted recruiter review with recruiter-edits-win,
  S3 artifact authority + hash, CAS/versioning, retry-without-reupload,
  idempotent exactly-one-`TalentRecord` promotion, Draft-Talents recovery, SSE
  notification-only with authoritative GET, admission rules, tenant isolation,
  and the retired synchronous `draft-from-resume` path — all preserved.

### ADR-0036 — Talent Intelligence as an Independent Service (ATS / TI separation)
Source: `doc/adr/0036-talent-intelligence-service.md` (Status: Accepted,
2026-10-23; governing directive ATI-SEP-1 + Addenda A1/A2). It reuses the
ADR-0033 envelope for ATS→TI events and supersedes ADR-0029 `:63` for Talent
Intelligence only (`doc/adr/0036-talent-intelligence-service.md:12`).

- **Decision 1 (`:40`–`:58`):** ATS and Talent Intelligence (TI) are two
  products. ATS identity is `TalentRecord.id` with ATS evidence in
  `talent_evidence`; TI identity is `GoldenTalent.id` (`intelligence_subject_id`)
  with global evidence in its own `intelligence` schema. `scope:ats` must not
  depend on `scope:intelligence`, and `scope:intelligence` must not depend on
  `scope:ats` or `scope:cip` (`:52`). The only shared code is
  `libs/intelligence-contracts` (`scope:shared`).
- **Decision 2 (`:59`–`:76`):** TI has its own database `aramo_intelligence`,
  own role (`INTELLIGENCE_DATABASE_URL`, `:47`) and own migration ledger.
- **Decision 3 (`:77`–`:118`):** ATS → TI uses an ATS outbox in schema
  `talent_record` (ADR-0033 envelope + lease) carrying ids only, with events
  `talent.created`, `talent.profile_updated`, `talent.erased` (`:83`); the ATS
  Intelligence Publisher sends an allowlisted admission payload only for
  tenants holding the `intelligence` capability. TI → ATS is an HMAC-signed
  webhook to `POST /v1/integrations/intelligence/events` (`:98`), after which
  ATS reads the TI profile and applies a per-tenant field sync policy that
  never overwrites recruiter-confirmed values, routing conflicts to
  `TalentRecordReconcileContradiction` / `TalentProfileFieldState`, and records
  `intelligence_link` (`:105`).
- **Decision 4 (`:119`–`:154`):** Admission classes enforced server-side in TI:
  Class A professional evidence, Class B identity/contact/eligibility, Class C
  never admitted (`:141`: notes, pay, source, hot flag, requisition/pipeline/
  submittal/interview data, street address). Documents are rejected
  structurally.
- **Decision 5 (`:155`–`:176`):** Golden identity resolution links
  deterministically only on VERIFIED anchors; unverified matches are discovery
  only; merge/split reversible.
- **Decision 6 (`:177`–`:193`):** Tenant read requires the `intelligence`
  capability AND an ACTIVE external reference; `TI_CROSS_TENANT_READ_ENABLED`
  defaults false (`:183`). `talent.erased` sets the reference ERASED; a subject
  with no ACTIVE reference becomes `AUDIT_RETAINED` (`:188`).
- **Consequences (`:194`–`:214`):** Add Talent has no TI dependency (`:196`).
  The legacy trust substrate (`talent-trust`, `identity-index`,
  `platform-trust`, `talent-reconcile`, trust UI/API surfaces) is retired
  (`:201`); sourcing (`sourced-talent`), screening, within-tenant duplicate
  advisories, matching and every recruiter decision stay in ATS (`:206`); TI
  output is enrichment only and never gates an ATS decision.
- **Operations — backfill (`:215`–`:265`):** TI starts empty and is filled by
  the `intelligence-backfill` CLI; dropping the legacy schemas by migration
  `20261024170000_ati_sep_1_drop_legacy_trust_schemas` is a destructive PROD
  operation requiring explicit PO authorization.

## ADR-0018 — Background Jobs Substrate
Source: `doc/adr/0018-background-jobs-substrate.md` and
`doc/adr/Aramo-ADR-0018-Background-Jobs-Substrate-v1_0-LOCKED.md`. BullMQ +
Redis is the service-local / in-process background-job substrate; it remains
Accepted and binding for that role. ADR-0033 supersedes ONLY ADR-0018's
deferred cross-service `Outbox → SNS → SQS` transport half.

## ADR-0007 Decision F — Talent Right-to-be-Forgotten / Anonymization
Source: `doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md`
(Status: ACCEPTED, deferred implementation).

- RTBF is realized as a talent-module **anonymization state machine**, not a
  hard delete; PII-bearing fields are anonymized/tombstoned while referential
  anchors + append-only audit/consent history are preserved. `is_anonymized`
  is the externally-observable marker.
- The state-machine **build is deferred**. Amendment (TR-15 B2, 2026-07-11):
  `is_anonymized` now derives from a retained `ConsentAuditEvent` marker set
  only by the `erase-talent` CLI; the anonymization state machine itself
  remains deferred.

### S2 Talent Erasure Integrity amendment (overrides Decision F "build deferred" for named tables)
Source: `Aramo/locked/ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md`
(LOCKED, Architect-ratified 2026-10-16).

- §0: an authorized talent erasure ends either fully complete or in an
  explicit truthful BLOCKED / FAILED / STORAGE_PENDING state; it never reports
  success while governed personal data remains in Aramo custody.
- §1 amends ADR-0007 Decision F: implemented for the §3.2 / §3.3 tables
  (tombstone + redaction); `is_anonymized` stays tied to a COMPLETED run.
- §2: each amended append-only trigger admits a change only through
  `consent.s2_erasure_permits`, which requires a `TalentErasureRun` row created
  by the same transaction, in state `DB_PASS_IN_PROGRESS`, same tenant,
  subject in `run.record_ids`, operation-class match and exact redaction
  patch; no trigger disabling and no `session_replication_role`.
- §3.1 DELETE of talent-owned immutable content; §3.2 RETAIN with one fresh
  tombstone per (run, requisition) and enumerated redaction; §3.3 client
  talent restriction redaction (BLOCKED pending Legal class).
- §4: commercial and legally retained records remain BLOCKED (PENDING_PO_LEGAL).
- §6: retained ledger after COMPLETED is limited to `TalentErasureRun`,
  `TalentErasureArtifact`, the `ConsentAuditEvent` marker (plus the runbook
  list).

### ATI-SEP-1 Addendum A1 — erasure semantics across ATS / TI
Source: `Aramo/locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A1-Erasure-Ruling-LOCKED.md`
(LOCKED 2026-10-23; supersedes ATI-SEP-1 §5 "Legal gate L-2" default).
ATS erasure emits `talent.erased`; TI sets that tenant's reference `ERASED`
(never revived by replay); Golden evidence is not deleted; a subject with no
active reference is `AUDIT_RETAINED`. ATS-side erasure (ATS rows, documents,
S2 guards) is unchanged (§"Binding semantics" item 6).

## ADR-0027 — Client-Scoped Talent Restriction and the R10 Boundary
Source: `doc/adr/0027-client-talent-restriction-r10-compatibility.md`
(Status: Accepted — LOCKED, 2026-08-01). Establishes that recording an
externally-originated restriction on a talent/placement is permissible without
breaching the Charter §8 R10 refusal layer, and reaffirms the ADR-0019
rejection of a recruiter rating on Pipeline. Governs how talent restriction
facts may be stored relative to the refusal layer. (Erasure handling of the
restriction row is governed by the S2 amendment §3.3 above.)

## LOCKED directives NOT anchored in-repo (explicit)
The following governing specifications for this domain are LOCKED directives
filed to OneDrive `Aramo/locked`, NOT present under `doc/adr/` or `doc/` in
this repo at this SHA (ADR-0036 is the only in-repo anchor of the ATS / TI
program); their ratified text is summarized from the canonical files:

- **Talent Admission Invariant** (name + `email1` + `phone_cell` mandatory;
  409 dedup) — implemented in code; no in-repo directive anchor. Amended by
  ATS-QA-1 Package 1 Conforming Amendments row A1 (below): City / State are
  completeness guidance, not a creation invariant, for recruiter Add Talent.
- **TALENT-INTEL-1** (TI-1A..1H: field-state control, profile hydration,
  work-authorization evidence, edition-aware résumé text) — implemented; no
  in-repo directive anchor. ATI-SEP-1 §2 supersedes Multi-Source TI-1 `:429`,
  `:507` and Gate-5 Ruling 30 for Talent Intelligence; TI-1G (résumé never
  authoritative for work authorization) remains binding (ATI-SEP-1 §3 item 7).
- **Durable Async Résumé-First Talent Intake** directive
  (`Aramo-Durable-Async-Resume-First-Talent-Intake-Directive-v1_0-LOCKED.md`)
  and the ADR-0033 **extraction-DECOUPLED promotion** / **LocalStack
  local-runtime** amendment (PR #906) — the ADR above anchors the
  transport/platform decisions; the product directive text is external.
  Its I7 `:134` / §8.5 `:188` (extraction cannot clobber recruiter edits;
  per-field dirty state owned by the backend) is re-affirmed as a conformance
  requirement by ATS-QA-1 Package 1 §2.
- **Résumé Revision Lifecycle** (edition = revision, byte-SHA-256 dedup,
  archive, single-owner selection eligibility) — implemented (PR #902); no
  in-repo directive anchor.
- **HF1/HF2 durable fact extraction** (FACT + `source_refs`, `redactPii`) —
  implemented; no in-repo directive anchor. HF2 §14 `:481`/`:505` `key_skills`
  clarified by ATS-QA-1 Conforming Amendments row A2.

### ATI-SEP-1 — ATS / Talent Intelligence Separation Program Directive (LOCKED 2026-10-23)
Source: `Aramo/locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md`
and Addenda A1–A4 (all LOCKED 2026-10-23). In-repo anchor: ADR-0036.

- §2 supersedes, for TI and recruiter Add Talent, Talent-Lifecycle & Trust
  Spec v1.1 §2 and invariants I4, I6, I7, I8, I13, I14; Security-S1 `:11`,
  `:14` (acting-tenant ownership rule → subject-scoped access per §3.4); and
  ADR-0029 `:63` for TI only.
- §3 item 1: ATS Add Talent is ATS-local — zero synchronous TI or legacy-trust
  calls; create is one all-or-nothing ATS write (TalentRecord, ATS
  `talent_evidence`, intake promotion, outbox).
- §3 item 6 / Addendum A2 E-1: ATS events are past-tense business facts
  (`talent.created`, `talent.profile_updated`, `talent.erased`); TI event
  `golden_talent.profile_updated`; versioning by envelope `event_version`.
- **Addendum A2 A-a (overrides §4 A-a):** create is the **Save** of a
  persisted, human-reviewed draft; Save materializes TalentRecord + ATS
  `talent_evidence` + ATS outbox event from the persisted reviewed draft;
  every step idempotent and keyed on the draft id, resumable; the draft is
  marked PROMOTED only after all steps complete; a failed Save leaves the draft
  editable and re-savable. The multi-schema write client is NOT adopted.
- **Addendum A2 A-b (overrides §4 A-b):** extraction failure (including output
  truncation) keeps the draft and its résumé attached, shows truthful failure
  copy, and leaves the form fully editable for manual completion and Save.
  **No output-cap change.**
- **Addendum A2 F-1 (overrides §4 F-1):** ATS keeps sourcing, screening,
  within-tenant identity / duplicate advisories (re-implemented on ATS data),
  matching and all recruiter decisions including sourced→record promotion. TI
  owns only evidence, verification, trust, disputes / proposals as evidence
  lifecycle, reference attestations; TI output never gates an ATS decision.
- **Addendum A3 (T10 cutover):** `talent-trust`, `platform-trust`,
  `talent-reconcile`, `talent-reconcile-signal`, `identity-index` are deleted
  and their schemas dropped by migration; disputes, trust-proposal worklist and
  contradiction resolution rebuilt in TI and called through the ATS HTTP
  client; reference attestations and the recruiter raise/resolve dispute
  routes are deleted; talent email verification switches to a 6-digit OTP.
  Row T10-1 (portal identity rebuild) is **superseded by Addendum A4**.
- **Addendum A4:** portal login / `/v1/portal/*` lookups may degrade until a
  Portal identity increment (GAP-PORTAL-ID-1); Portal endpoints that cannot
  resolve a Talent return a uniform non-leaking "not available"; `PortalUser`
  / `TalentRecord.cluster_id` stay inert (ADD-not-rename).
- §5: merge, deploy and PROD migration (destructive drops included) are not
  authorized by the directive; `TI_CROSS_TENANT_READ_ENABLED` defaults false
  (Legal L-1).

### Security S1 and G1 — trust-ledger directives (LOCKED 2026-10-14; substrate since retired)
Sources: `Aramo/locked/Aramo-Security-S1-Talent-Trust-Tenant-Isolation-Remediation-Directive-v1_0-LOCKED.md`
(§1: Talent Trust must refuse any lifecycle mutation of an evidence row not
owned by the acting tenant, 404-indistinguishable) and
`Aramo/locked/Aramo-G1-TrustState-Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED.md`
(§3.1–§3.4: recompute the active survivor under a per-survivor advisory lock,
durable `trust_recompute_requested_at` request + a 2-minute repair job, atomic
evidence creation). Both target `libs/talent-trust/**`. ATI-SEP-1 §2
supersedes Security-S1 `:11`, `:14` with subject-scoped TI access, and
Addendum A3 deletes `talent-trust`; these two directives therefore govern no
live ATS code at this SHA and survive only as historical intent for the
retired ledger.

### CONSENT-RECRUITER-CREATE-DEFAULT-1 (LOCKED 2026-10-16)
Source: `Aramo/locked/Aramo-CONSENT-RECRUITER-CREATE-DEFAULT-1-Amendment-v1_0-LOCKED.md`.
§1–§3: on recruiter creation (manual create, résumé-first confirm, intake
promotion — both branches) record `profile_storage`, `matching`, `contacting`
grants with `permitted_channels ['email','phone']`, method
`recruiter_create_default`, text version `recruiter-create-default-v1`; import
and sourcing promotion get **no** default grant (§2). §5: creation never fails
because of the consent write. §6: no backfill, no migration, reached through a
talent-record port bound in `apps/api`. Supersedes Talent-Detail Backend
Enablement `:98-99` (§7).

### ATS-QA-1 Package 1 + Conforming Amendments (LOCKED per ATI-SEP-1 §2)
Sources: `Aramo/locked/Aramo-ATS-QA-1-Package-1-Implementation-Directive-v1_0-LOCKED.md`
and `Aramo/locked/Aramo-ATS-QA-1-Package-1-Conforming-Amendments-v1_0-LOCKED.md`.
Their in-file status line reads "RATIFICATION-READY"; ATI-SEP-1 §2 records both
as LOCKED and that status text as historical.

- Directive §2: draft-save integrity (Durable-Async I7 `:134`), explicit
  skills (HF1 §8 `:71`), contact labels (Talent360 §14 `:372-375`) are
  conformance fixes, not amendments. §3 in-scope: I-3 extraction v4 + draft
  integrity, I-4 education read/edit, I-5 résumé picker on requisition
  association.
- Amendment A1: City / State are completeness guidance, not a creation
  invariant, for recruiter Add Talent (supersedes Durable-Async §1.1 `:35` for
  that clause).
- Amendment A3: `TalentEducationEntry` remains the only education authority;
  adds authorized read through Talent 360 and recruiter edit as source
  `manual`, where a correction supersedes (retires) the earlier row keeping
  provenance.

### TIP-E2E INC-3 — Manual Technical Screening (LOCKED 2026-10-15)
Sources: `Aramo/locked/ARAMO-TIP-E2E-INC-3-v1.0-LOCKED.md`,
`Aramo/locked/ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md`, vocabulary DDR
`Aramo/locked/Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED.md`. §3: new lib
`libs/technical-screening` (`scope:ats`); §9: routes under
`/v1/talent-records/:talentId/screening-sessions` and `/v1/screening-sessions/*`
with `screening:*` scopes. The §3 "Trust write" (Talent Trust owns
`recordScreeningFindingIfAbsent`) and the TR-SCREEN-1 trust-ledger write
contract are **superseded** by ATI-SEP-1 §4 F-1 / Addendum A3: screening
findings are ATS-private (Class C) with ATS-local publication state.

### Talent Lifecycle R1–R5 (LOCKED 2026-10-20) — boundary note
`Aramo/locked/Aramo-Talent-Lifecycle-R1-R5-Implementation-Directive-v1_2-LOCKED.md`
(+ A1 and the R-DIR recon directive) governs Pipeline / RTR / requisition
lifecycle / hold / talent-responded slices (§3–§7). It names no Talent Record,
evidence or intake surface of this domain beyond build targets (§2 `:211`);
it is owned by the pipeline domain and is not restated here.

No in-repo AS-DESIGNED anchor exists for the per-endpoint scope matrix or the
inbound field-sync precedence; those are code-level constructs whose governing
directives are external (ADR-0036 Decision 3 states the policy shape only).
