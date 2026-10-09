# D02 — Database & Domain Data Model (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

AS-DESIGNED anchors are sourced ONLY from ratified LOCKED directives / ADRs and the checked-in conventions doc. They are cited by file + section. Nothing here is synthesized from application code.

## Ratified anchors

### A1 — Schema-per-Module data architecture
- `doc/05-conventions.md:122` "Database Conventions (Prisma)" and `:124` "Schema-per-Module": "Each module owns a schema." The design intent is one Prisma schema + one Postgres `@@schema` namespace per `libs/*` module.

### A2 — Cross-schema references are UUID-only, no FK; intra-schema relations carry real FKs
- `doc/05-conventions.md:136`: "Cross-schema references use UUID without FK", with the worked example showing `talent_id String // UUID reference to talent_record.TalentRecord; no FK constraint`. The design boundary: FK constraints only within a schema; across schemas a bare UUID column.

### A3 — tenant_id required; Talent-core the sole tenant-agnostic exception
- `doc/05-conventions.md:149` "Tenant ID Required": every tenant-scoped table includes `tenant_id` and leads its indexes with it. `:163`: "The Talent core table is the only exception (tenant-agnostic identity)."

### A4 — Append-only event tables are immutable (no updated_at)
- `doc/05-conventions.md:165` "Append-Only Event Tables": the ratified pattern (immutable event rows, `occurred_at`, no `updated_at`). The DB-trigger enforcement of this immutability is the build convention observed across the event-log / outbox tables.

### A5 — RDS substrate + Core retirement / identity_index successor
- `doc/adr/Aramo-ADR-0016-RDS-Substrate-Conventions-v1_0-LOCKED.md` (Context §/Decisions §): the RDS substrate conventions and the Architecture-Realignment that retired the former Core table in favour of the tenant-agnostic `identity_index` resolution index. The privacy-wall intent (no `tenant_id`, no PII in `identity_index`; opaque salted fingerprints) is the ratified design the as-built `identity_index` schema realises.
- Supporting invariant **I14** (cross-tenant privacy wall) is referenced by `doc/adr/0029-pipeline-boundary-modular-monolith.md:14` ("I1 / I14 — consistent (UUID-only cross-schema; `identity_index` PII/tenant boundary). No invariant relaxed.").

### A6 — Pipeline⊥ATS import wall (modular monolith; UUID-ref + connector contract only)
- `doc/adr/0029-pipeline-boundary-modular-monolith.md:1` and `:7`: ADR-0029 enforces invariant **I15** — Pipeline libs never hard-import ATS libs; the boundary is crossed by UUID reference + versioned, Pact-tested connector contract only, CI-enforced by nx boundary tags. This is the design rationale for the UUID-only `talent_record_id` / `requisition_id` columns on `pipeline.Pipeline` rather than FK relations.

### A7 — Cross-service durable event foundation (Outbox → EventBridge → SQS)
- `doc/adr/0033-cross-service-durable-event-foundation.md:1` (title) + `:46` "Decision" §1: the canonical cross-service transport is a transactional **outbox** written in the same DB transaction as the authoritative business state, drained by an outbox publisher through an `OutboxPublisherPort`. `:23` notes the baseline state: "the shared `libs/outbox-publisher` drains 7 domain `OutboxEvent` tables but emits structured logs only". This is the ratified design for the per-module `OutboxEvent` tables and the 7-schema drain observed as-built.

### A8 — Company Party/Role model
- ADR-0032 (referenced in the as-built `libs/company/prisma/schema.prisma:300` header as "Company Party/Role model (ADR-0032 / Aramo-Company-PartyRole-Model-Correction-Directive-v1.0)"): one neutral organization master; roles (CLIENT | VENDOR | PARTNER) are independently lifecycle-managed relationships, never duplicate org rows per role.

### A9 — Manual recruiter rating R10 boundary (no ordinal/numeric talent-grading columns)
- `doc/adr/0019-manual-recruiter-rating-r10-boundary.md`: the ratified decision that Aramo deliberately does not let recruiters ordinally grade talent. This is the design rationale for the R10 "no portal-forbidden numeric/ordinal fields" constraint enforced structurally across talent-bearing schemas (e.g. the `pipeline.Pipeline` design note).

### A10 — Talent RTBF / anonymization
- `doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md`: the ratified right-to-be-forgotten / anonymization posture that informs the Talent-context cascade-delete design (e.g. `TalentResumeText` onDelete Cascade as the self-cleaning purge guarantee).

## Where no ratified anchor was located (explicit)

- **No single ratified document enumerates the canonical namespace set at exactly 50.** The conventions doc states the per-module rule (A1) but the "ten-schema list" phrasing appears only inside individual schema-file comments (code), not in a checked-in LOCKED catalog under `doc/adr/*` or `doc/architecture/*` at this SHA. The namespace count is therefore an AS-BUILT fact, not an AS-DESIGNED anchor.
- **No ratified anchor was found that specifies which outbox tables the shared publisher must drain.** ADR-0033 states the transport design and names "7 domain OutboxEvent tables" as the baseline fact (A7), but does not ratify a required/forbidden drain set for `documents`, `esign`, `offer`, or `talent-evidence` outbox tables. The drain-coverage observation in the gap fragment is an AS-BUILT finding, not a code-vs-spec contradiction against a located anchor.
- **No `doc/architecture/*` file at this SHA restates §7.1/§7.2/§7.3** verbatim; schema headers cite "Architecture v2.0/v2.1 §7.x" but those versioned architecture documents are not the checked-in files under `doc/architecture/` (which are the enterprise-context + console + e-sign records). The §7.x citations are code-internal references; the checked-in ratified equivalent is `doc/05-conventions.md` (A1–A4).
