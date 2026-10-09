# D12 — Sourcing, Ingestion, Import & Resume Parsing (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

Ratified intent only, cited from `doc/adr/*`. Where no repo-ratified anchor
exists for an as-built behaviour, this is stated explicitly rather than
synthesized from code. Several D12 directives named in code comments
(Plan v1.2, API Contracts Phase 4, DDR-1/DDR-2, the TI-1F Durable-Fact
directive, SRC-1/SRC-2, the VMS Integration Directive) are LOCKED artifacts
held in OneDrive `Aramo/locked`, NOT in the repo `doc/adr` tree; they cannot be
cited by file+section here and are marked accordingly.

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
and references other modules by UUID without FK).

## E. Pipeline ⊥ ATS wall (I15)

`doc/adr/0029-pipeline-boundary-modular-monolith.md`
(= `Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`) ratifies
that Pipeline (CIP) libraries never hard-import ATS libraries; cross-boundary
reference is by UUID + versioned connector contract only. The
cold-ingest-extraction module header cites this wall ("scope:cip — I15 CIP⊥ATS
wall clean, no ats edge") as the constraint on its import set.

## F. Legal-basis / consent at ingest

`doc/adr/0005-consent-revoke-contract-and-audit-semantics.md` and the
consent-contract ADRs (0006, 0007) ratify the consent-state contract that
`IngestionService.acceptIndeedSearchResults` registers against via
`SourceConsentService.registerSourceDerivedConsent`. The Indeed = PARTIAL /
channel-limited consent mapping itself is specified in the (OneDrive-LOCKED)
Group 2 v2.3a directive, not a repo ADR — NO repo anchor.

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
  (manual-recruiter-rating R10 boundary), not a sourcing service. NO repo
  anchor for the L1 staging / sourcing-service intent.
- **VMS canonical requisition import** — code cites "VMS Integration Directive
  v1.0 §13"; OneDrive-LOCKED, NOT in `doc/adr`. NO repo anchor.
- **Import scope tiering** (`import:create` recruiter+, `import:delete`
  tenant_admin-only) — a Lead-reviewed Commit-Plan ruling quoted in the
  controller header; NOT a repo ADR. NO repo anchor.
