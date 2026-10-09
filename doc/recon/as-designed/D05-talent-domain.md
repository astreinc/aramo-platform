# D05 — Talent Domain (Record, Evidence, Intake, Trust) (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

Ratified intent only, cited from in-repo `doc/adr/*`. Where the governing
authority is a LOCKED directive that lives OUTSIDE the repo (OneDrive
`Aramo/locked`), that is stated explicitly — its text is NOT reproduced or
synthesized from code.

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
  remains deferred. A verified deletion request cannot be fully honored today;
  the résumé *file* (Attachment) still orphans on talent-delete. Persisting
  full résumé body text (ADR-0015) raised this carry's priority.

## ADR-0027 — Client-Scoped Talent Restriction and the R10 Boundary
Source: `doc/adr/0027-client-talent-restriction-r10-compatibility.md`
(Status: Accepted — LOCKED, 2026-08-01). Establishes that recording an
externally-originated restriction on a talent/placement is permissible without
breaching the Charter §8 R10 refusal layer, and reaffirms the ADR-0019
rejection of a recruiter rating on Pipeline. Governs how talent restriction
facts may be stored relative to the refusal layer.

## LOCKED directives NOT anchored in-repo (explicit)
The following governing specifications for this domain are LOCKED directives
filed to OneDrive `Aramo/locked`, NOT present under `doc/adr/` or `doc/` in
this repo at this SHA; their ratified text is therefore NOT reproduced here and
must be read from the canonical directory:

- **Talent Admission Invariant** (name + `email1` + `phone_cell` mandatory;
  409 dedup) — implemented in code (`MEMORY.md` records PR #778); no in-repo
  directive anchor.
- **TALENT-INTEL-1** (TI-1A..1H: field-state control, profile hydration,
  work-authorization evidence, edition-aware résumé text) — implemented; no
  in-repo directive anchor.
- **Durable Async Résumé-First Talent Intake** directive and the ADR-0033
  **extraction-DECOUPLED promotion** / **LocalStack local-runtime** amendment
  (PR #906) — the ADR above anchors the transport/platform decisions; the
  product directive text is external.
- **Résumé Revision Lifecycle** (edition = revision, byte-SHA-256 dedup,
  archive, single-owner selection eligibility) — implemented (PR #902); no
  in-repo directive anchor.
- **HF1/HF2 durable fact extraction** (FACT + `source_refs`, `redactPii`) —
  implemented; no in-repo directive anchor.

No in-repo AS-DESIGNED anchor exists for the per-endpoint scope matrix, the
reconcile projection precedence, or the trust band-derivation thresholds; those
are code-level constructs whose governing directives are external.
