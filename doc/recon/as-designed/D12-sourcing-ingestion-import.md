# D12 — Sourcing, Ingestion, Import & Resume Parsing (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

Ratified intent only, cited from `doc/adr/*`. Where no repo-ratified anchor
exists for an as-built behaviour, this is stated explicitly rather than
synthesized from code. Several D12 directives named in code comments
(Plan v1.2, API Contracts Phase 4, DDR-1/DDR-2, the TI-1F Durable-Fact
directive, SRC-1/SRC-2, the VMS Integration Directive) are LOCKED artifacts
held in OneDrive `Aramo/locked`, NOT in the repo `doc/adr` tree; they cannot be
cited by file+section here and are marked accordingly. LOCKED directives
ratified after 2026-10-09 that touch this domain are cited from
`Aramo/locked/` by exact filename and section in the `###` sub-sections below.

## A. AI substrate posture — deterministic parse boundary

`doc/adr/Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md` §"Decision 10 —
Scope of AI consumption" (line 170):

- AI/LLM consumption is confined to `libs/ai-draft` and its declared consumers.
- "New substrate surfaces — A8-2 import column-mapping, A8-3b resume parse, and
  all future parse/inference surfaces — MUST use deterministic heuristics, NOT
  LLM calls." (line 172)
- In-scope deterministic surfaces named: `libs/import` (A8-2 column mapping) and
  `libs/resume-parse` (A8-3b) — the latter described as "resume text-extraction
  (pdf-parse / mammoth) + heuristic field-extraction (regex + structural
  section-matching)" (line 179-180).
- A future LLM extension to any parse/inference surface "amends Decision 10 …
  BEFORE adding the wiring. The PR must NOT silently bypass the structural
  spec." (line 184)
- `redactPii` posture: Decision 6 mandates pre-prompt + post-completion PII
  redaction at the service layer for every ai-draft consumer (line 118-124).
- The structural `no-llm-boundary` assertion was lifted to `@aramo/common`
  (`findNoLlmBoundaryViolations`) so consumer specs share one definition
  (line 176).

### A1. ADR-0015 Amendment v1.3 — Declared-Evidence Extraction (canonical, not in repo)
`Aramo/locked/Aramo-ADR-0015-Amendment-v1_3-Declared-Evidence-Extraction-LOCKED.md`
(LOCKED 2026-07-01) §3 adds **Decision 11**: declared-evidence extraction is a
declared consumer of `libs/ai-draft`, consuming already-parsed declared text
and producing structured declared-source evidence rows through `AiDraftService`
(inheriting Decisions 5, 6, 8). It amends Decision 10 for that surface only;
résumé *file* parse stays deterministic. The repo copy of ADR-0015 still reads
v1.1 (`doc/adr/Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md:3`) and
carries no Decision 11.

### A2. RESUME-A1 — PDF Reading Remediation (LOCKED 2026-10-22)
`Aramo/locked/Aramo-RESUME-A1-PDF-Reading-Remediation-Directive-v1_1-LOCKED.md`:
- §0 scope: R1 same-baseline separator in the PDF branch of
  `extractResumeText`; R2 page-completeness checks, fail-closed; D-5
  extractor-version attribution on `ResumeExtractionDraft.extractor_version`;
  R4 tests. Explicitly unchanged: `buildResumeSourceMap` /
  `resume-source-map/v1`, the DOCX branch, LLM/prompt/token, OCR.
- §2 R1.2: insert one U+0020 between same-baseline items when the gap is
  ≥ 0.25 × font size and neither side is whitespace.
- §3 R2.2–R2.5: an extraction is incomplete if any page in `1..numpages` was
  not reached/resolved or produced 0 non-whitespace characters; incomplete →
  `null` (existing non-blocking contract); one structured warn event
  `resume_text.pdf_incomplete` with no résumé content.
- §4 R3.2: export `RESUME_TEXT_EXTRACTOR_VERSION = 'resume-text-extractor/2'`
  and pass it as `extractor_version` at the two
  `markResumeExtractionDraftReadyForReview` call sites; R3.3 no backfill.
- §7 exclusions and §8 D-8: DOCX footnotes / hidden text / list markers /
  layout handling deferred to a separately governed follow-up (§9 F-1).

## B. Durable async Talent intake (resume-first)

`doc/adr/0033-cross-service-durable-event-foundation.md`
(= `Aramo-ADR-0033-...`), "source-agnostic Talent Intake":

- PostgreSQL is the authoritative transactional system of record; durable
  cross-service publication uses a transactional outbox written in the same DB
  transaction, drained by an outbox publisher dispatching via an
  `OutboxPublisherPort` (lines 48-53).
- Canonical transport is Outbox → EventBridge → consumer-owned SQS; supersedes
  the ADR-0018 `Outbox → SNS → SQS` half and the earlier BullMQ-specific
  intake transport (lines 9, 30-37, 48).
- Talent-intake extraction is a short, synchronous orchestration ("CAS-claim
  intake → establish extraction child → one governed LLM call → persist child →
  persist parent"), with no durable waits / no in-execution human pause, so it
  uses application-owned orchestration rather than a workflow engine
  (lines 79-86).
- BullMQ may remain for purely service-local jobs (e.g. the outbox publisher's
  own tick) (line 72).

### B1. ATI-SEP-1 — Draft → Review → Save and truncation (LOCKED 2026-10-23)
`Aramo/locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A2-PO-Rulings-LOCKED.md`:
- **A-a:** create is the Save of a persisted, human-reviewed intake draft;
  every step idempotent and keyed on the draft id; PROMOTED only after all
  steps complete.
- **A-b:** extraction failure, including output truncation, keeps the draft and
  its résumé attached with truthful failure copy and a fully editable form for
  manual completion. **No output-cap change** (overrides ATI-SEP-1 §4 A-b,
  which had ruled to raise the cap).
- In-repo anchor: `doc/adr/0036-talent-intelligence-service.md:77`–`:118`
  (ATS outbox events `talent.created` / `talent.profile_updated` /
  `talent.erased`; the admission payload carries no documents, `:148`–`:152`).

## C. Background-jobs / ingestion poll substrate

`doc/adr/Aramo-ADR-0018-Background-Jobs-Substrate-v1_0-LOCKED.md` — the BullMQ
background-jobs substrate underpinning poll workers (the cold-ingest-extraction
tick worker, outbox publisher). ADR-0033 records that ADR-0018 "remains Accepted
and in force" for service-local jobs while its cloud-dispatch half is superseded
(`doc/adr/0033-cross-service-durable-event-foundation.md:9`).

## D. Schema-per-module data architecture

`doc/adr/Aramo-ADR-0016-RDS-Substrate-Conventions-v1_0-LOCKED.md` ratifies the
schema-per-module Prisma layout and the UUID-only / no-FK cross-schema
convention that every D12 schema header cites (each of the `ingestion`,
`sourced_talent`, `import`, `attachment` schemas carries its own PG namespace
and references other modules by UUID without FK). ADR-0036 Decision 2 adds a
second database (`aramo_intelligence`) for Talent Intelligence only
(`doc/adr/0036-talent-intelligence-service.md:59`); no D12 schema moves there.

## E. Pipeline ⊥ ATS wall (I15)

`doc/adr/0029-pipeline-boundary-modular-monolith.md`
(= `Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`) ratifies
that Pipeline (CIP) libraries never hard-import ATS libraries; cross-boundary
reference is by UUID + versioned connector contract only. The
cold-ingest-extraction module header cites this wall ("scope:cip — I15 CIP⊥ATS
wall clean, no ats edge") as the constraint on its import set.

### E1. ADR-0036 — ATS / Talent Intelligence wall; sourcing stays ATS
`doc/adr/0036-talent-intelligence-service.md:52` adds `scope:intelligence`:
`scope:ats` must not depend on it, and it must not depend on `scope:ats` or
`scope:cip`. ADR-0036 Consequences (`:206`) and ATI-SEP-1 Addendum A2 F-1 /
Addendum A3 (`Aramo/locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A3-T10-Rulings-LOCKED.md`,
"All other T10 dispositions") keep sourcing (`sourced-talent`, rebuilt on
`sourced_talent`), within-tenant duplicate advisories and sourced→record
promotion (tenant-local dedupe) in ATS; ATI-SEP-1 §4 F-1 moves
`identity_index` and cross-tenant advisories to TI. TI admission rejects
documents structurally (`doc/adr/0036-talent-intelligence-service.md:150`).

## F. Legal-basis / consent at ingest

`doc/adr/0005-consent-revoke-contract-and-audit-semantics.md` and the
consent-contract ADRs (0006, 0007) ratify the consent-state contract that
`IngestionService.acceptIndeedSearchResults` registers against via
`SourceConsentService.registerSourceDerivedConsent`. The Indeed = PARTIAL /
channel-limited consent mapping itself is specified in the (OneDrive-LOCKED)
Group 2 v2.3a directive, not a repo ADR — NO repo anchor.

### F1. CONSENT-RECRUITER-CREATE-DEFAULT-1 (LOCKED 2026-10-16)
`Aramo/locked/Aramo-CONSENT-RECRUITER-CREATE-DEFAULT-1-Amendment-v1_0-LOCKED.md`
§2: Import (`createForImport`) and the Sourcing Promotion Gate record **no**
`recruiter_create_default` grant; sourcing promotion keeps its existing
source-derived consent. §9 item 2 makes this an acceptance check.

## Explicit anchor gaps (no repo-ratified AS-DESIGNED)

- **Generic ingestion wire contract** (RawPayloadReference shape, Invariant 7
  "raw payloads stored by reference", the four-source closed vocabulary,
  four-layer prohibited-source refusal) — code cites "API Contracts v1.0
  Phase 4" and "Plan v1.2 §3 M2 Track A"; these are NOT in `doc/adr`. NO repo
  anchor. The OpenAPI contract `openapi/ingestion.yaml` is the only in-repo
  specification of this surface.
- **`source_class` server-derivation + fail-closed default** — code cites
  "DDR-1 §3.1/§3.2/§4"; DDR-1 is OneDrive-LOCKED, NOT in `doc/adr`. NO repo
  anchor.
- **Canonicalize resolution-method vocabulary** (DDR-2 §6) — OneDrive-LOCKED.
  NO repo anchor.
- **SRC-1/SRC-2 ingestion spine** (Indeed Apply webhook, server-side ingestion
  object write, storage_ref = bare S3 key) — code cites "SRC-1 PR-2 R13.*";
  these directives are OneDrive-LOCKED, NOT in `doc/adr`. NO repo anchor.
- **Résumé durable-fact extraction** (FACT-only single-read, `source_refs`
  grounding, retirement of heuristic field-extraction) — code cites a
  "TI-1F-…-v1_0-LOCKED §4-D" directive naming governed LLM as the sole
  production resume fact extractor. This directive is OneDrive-LOCKED, NOT in
  `doc/adr`, and it is NOT reflected as an amendment to ADR-0015 Decision 10
  (see the D12 gap fragment). NO repo anchor for the retirement.
- **sourced_talent L1 staging store + the ADR-0019 sourcing service** — code
  cites a "Talent-Lifecycle & Trust Architecture Spec v1.1" and "ADR-0019
  (un-ratified)". The repo `doc/adr/0019-*.md` is a DIFFERENT subject
  (manual-recruiter-rating R10 boundary), not a sourcing service. ADR-0036
  (`:206`) now anchors only the **ownership** (sourcing stays in ATS); the L1
  staging-store intent itself still has NO repo anchor.
- **VMS canonical requisition import** — code cites "VMS Integration Directive
  v1.0 §13"; OneDrive-LOCKED, NOT in `doc/adr`. NO repo anchor.
- **Import scope tiering** (`import:create` recruiter+, `import:delete`
  tenant_admin-only) — a Lead-reviewed Commit-Plan ruling quoted in the
  controller header; NOT a repo ADR. NO repo anchor.
- **RESUME-A1 PDF reading remediation**, **ATI-SEP-1** and its Addenda, and
  **CONSENT-RECRUITER-CREATE-DEFAULT-1** are LOCKED in OneDrive `Aramo/locked`
  only (cited above); ADR-0036 is the only in-repo anchor of the ATI-SEP-1
  program.
- **DOCX contact-block line-break handling** (PR #1007) — no LOCKED or ADR
  instrument governs it; RESUME-A1 §8 D-8 / §9 F-1 registers DOCX reading as a
  separately governed follow-up that is not yet filed. NO anchor.
