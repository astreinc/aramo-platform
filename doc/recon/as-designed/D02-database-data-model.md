# D02 — Database & Domain Data Model (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

AS-DESIGNED anchors are sourced ONLY from ratified LOCKED directives / ADRs and the checked-in conventions doc. They are cited by file + section. Nothing here is synthesized from application code. LOCKED directives outside the repo are in the canonical `Aramo/locked/` folder and are cited by file name.

## Ratified anchors

### A1 — Schema-per-Module data architecture
- `doc/05-conventions.md:122` "Database Conventions (Prisma)" and `:124` "Schema-per-Module": "Each module owns a schema." The design intent is one Prisma schema + one Postgres `@@schema` namespace per `libs/*` module.

### A2 — Cross-schema references are UUID-only, no FK; intra-schema relations carry real FKs
- `doc/05-conventions.md:136`: "Cross-schema references use UUID without FK", with the worked example showing `talent_id String // UUID reference to talent_record.TalentRecord; no FK constraint`. The design boundary: FK constraints only within a schema; across schemas a bare UUID column.
- ADR-0036 extends this to a database boundary: "No cross-database reference of any kind" for the Talent Intelligence store (A11).

### A3 — tenant_id required; Talent-core the sole tenant-agnostic exception
- `doc/05-conventions.md:149` "Tenant ID Required": every tenant-scoped table includes `tenant_id` and leads its indexes with it. `:163`: "The Talent core table is the only exception (tenant-agnostic identity)."
- For Talent Intelligence, ADR-0036 §1 (`doc/adr/0036-talent-intelligence-service.md:40`) puts global, cross-tenant subjects in the separate `intelligence` store; that store is the ratified home of tenant-agnostic talent identity at this SHA (A11).

### A4 — Append-only event tables are immutable (no updated_at)
- `doc/05-conventions.md:165` "Append-Only Event Tables": the ratified pattern (immutable event rows, `occurred_at`, no `updated_at`). The DB-trigger enforcement of this immutability is the build convention observed across the event-log / outbox tables.
- `ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md` §2 ("The subject-bound, transaction-bound erasure authorization") amends the affected trigger functions: each is replaced by one new migration (no historical migration edited) that admits only a subject-bound, transaction-bound erasure. Where §2 differs from the plain immutability rule, the amendment governs for erasure (A13).

### A5 — RDS substrate + Core retirement / identity_index successor
- **Status: SUPERSEDED in part** (see the ATI-SEP-1 bullet below).
- `doc/adr/Aramo-ADR-0016-RDS-Substrate-Conventions-v1_0-LOCKED.md` (Context §/Decisions §): the RDS substrate conventions and the Architecture-Realignment that retired the former Core table in favour of the tenant-agnostic `identity_index` resolution index.
- **Superseded by ATI-SEP-1.** `Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A3-T10-Rulings-LOCKED.md` (ruling table, row T10-1, and the line "`talent-trust`, `platform-trust`, `talent-reconcile`, `talent-reconcile-signal` and `identity-index` are deleted, and their schemas are dropped by migration") retires `identity_index` and states that Spec v1.1 I14 (the `identity_index` privacy wall) is superseded for portal identity. `…-Addendum-A4-Portal-Identity-Deferral-LOCKED.md` "Binding interpretation for T10" §1 then defers the portal rebuild: Talent Portal login and `/v1/portal/*` lookups may stop working until a later Portal increment. A4 overrides A3 where they differ: the PortalTalentBinding that A3 T10-1 describes is recorded in A4 "Target boundary" as not built in T10.
- Invariant **I14** is still cited by `doc/adr/0029-pipeline-boundary-modular-monolith.md:14`; that ADR text predates ATI-SEP-1 and is not amended in-repo.

### A6 — Pipeline⊥ATS import wall (modular monolith; UUID-ref + connector contract only)
- `doc/adr/0029-pipeline-boundary-modular-monolith.md:1` and `:7`: ADR-0029 enforces invariant **I15** — Pipeline libs never hard-import ATS libs; the boundary is crossed by UUID reference + versioned, Pact-tested connector contract only, CI-enforced by nx boundary tags. This is the design rationale for the UUID-only `talent_record_id` / `requisition_id` columns on `pipeline.Pipeline` rather than FK relations.

### A7 — Cross-service durable event foundation (Outbox → EventBridge → SQS)
- `doc/adr/0033-cross-service-durable-event-foundation.md:1` (title) + `:46` "Decision" §1: the canonical cross-service transport is a transactional **outbox** written in the same DB transaction as the authoritative business state, drained by an outbox publisher through an `OutboxPublisherPort`. `:23` records the then-baseline fact: "the shared `libs/outbox-publisher` drains 7 domain `OutboxEvent` tables but emits structured logs only".
- ADR-0036 §3 "Integration" (`doc/adr/0036-talent-intelligence-service.md:77`) applies this to ATS → TI: an ATS outbox in schema `talent_record`, shaped like `TalentIntakeOutboxEvent` (ADR-0033 envelope plus lease columns), carrying ids only, drained by the ATS Intelligence Publisher.

### A8 — Company Party/Role model
- ADR-0032 (referenced in the as-built `libs/company/prisma/schema.prisma:300` header as "Company Party/Role model (ADR-0032 / Aramo-Company-PartyRole-Model-Correction-Directive-v1.0)"): one neutral organization master; roles (CLIENT | VENDOR | PARTNER) are independently lifecycle-managed relationships, never duplicate org rows per role.

### A9 — Manual recruiter rating R10 boundary (no ordinal/numeric talent-grading columns)
- `doc/adr/0019-manual-recruiter-rating-r10-boundary.md`: the ratified decision that Aramo deliberately does not let recruiters ordinally grade talent. This is the design rationale for the R10 "no portal-forbidden numeric/ordinal fields" constraint enforced structurally across talent-bearing schemas (e.g. the `pipeline.Pipeline` design note). `ARAMO-TIP-E2E-INC-3-v1.0-LOCKED.md` §4 "Data model (schema `technical_screening`)" applies the same boundary to screening findings (A16).

### A10 — Talent RTBF / anonymization
- `doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md`: the ratified right-to-be-forgotten / anonymization posture that informs the Talent-context cascade-delete design (e.g. `TalentResumeText` onDelete Cascade as the self-cleaning purge guarantee).
- `Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A1-Erasure-Ruling-LOCKED.md` "Binding semantics" item 2: golden evidence in Talent Intelligence is **not deleted** because one tenant erased the talent; source-tenant provenance stays on each assertion. For TI data this overrides a cascade-delete reading of ADR-0007.

### A11 — Talent Intelligence in its own database (ATI-SEP-1 / ADR-0036)
- `doc/adr/0036-talent-intelligence-service.md` (Status Accepted, 2026-10-23) §2 "Own database (the forcing function)" (`:59`): database `aramo_intelligence` with its own role; migrations in `libs/intelligence-core/prisma/migrations`, applied by `tools/db-sync-intelligence.sh` with ledger `public._intelligence_migrations`.
- `Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md` (PO-ratified 2026-10-23) §3 "Architecture (binding)" item 2 and §4 "Rulings adopted" row G3 (TI database, own role, per-database runner and ledger) and row F-1 (cross-tenant advisories, trust proposals, portal disputes, email verification and `identity_index` move to TI; sourced→record promotion uses tenant-local dedupe; screening findings are ATS-private). §5: merge, deploy and PROD migration (destructive drops included) each need separate PO authorization.
- `…-Addendum-A2-PO-Rulings-LOCKED.md` ruling A-a: Create is the Save of a persisted, human-reviewed intake draft; idempotent, keyed on the draft id, resumable.

### A12 — Sign naming unification (`esign` → `sign`)
- `Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md` (LOCKED 2026-10-20) §1 "Intent and scope": the database schema is renamed; identifier migration only, no behaviour change; P-4 "Historical `migration.sql` files … are never edited". §2 "Ratified decisions" N-2 (migration-ledger re-key preserving identity and idempotency) and N-3 (schema rename migration with cross-schema dependency verification).

### A13 — S2 erasure integrity (write serialization and erasure authorization)
- `ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md` (ratified 2026-10-16) §1 "Authorities amended" and §2: the transaction-bound erasure authorization (`DB_PASS_IN_PROGRESS` added to the run state CHECK; subject resolved through each table's own parent and required to be in `run.record_ids`), with no trigger disabling and no blanket session flag. This is the ratified design for `consent.TalentErasureRun` and the per-lib S2 migrations.

### A14 — Sign commercial layer (subscription, provider routing, legal acceptance)
- `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md` (2026-10-18), sections §B/§C (allowance authority kept separate from the signing engine and from provider routing) and §D/§E (provider integration layer), as cited by the schema headers. In-repo `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md` is a "program record" (its Status line) and is not used as intent here.
- `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED.md` (2026-10-19): amends the Standalone Product authorization's single paid plan; source of the A1 catalog, capacity, feature and legal-acceptance tables.
- `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED.md` §7 "Data model (additive; new tables, no new columns on identity tables)": new `identity.PersonalSignupRequest`, `identity.TenantRiskState`, `sign.AbuseReport`; the allowance ledger gains a daily window. `…-v1_1-Amendment-A1-v1_0-LOCKED.md` A1-1 (geographic eligibility, amends §6.6) and A1-3 (retention, amends §8) override the parent where they differ.

### A15 — Identity tenancy, domain and signup data model
- `Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md` §2 "Domain claim (new state; ADD-only columns on `identity."Tenant"`)": `domain_claim`, `domain_claim_expires_at`, `domain_claim_reason`, `domain_exception`, a partial unique holder index, and the grandfather backfill (ruling 9); §5 new `identity."DomainVerificationDelegation"` table; §6 audited operator exceptions.
- `Aramo-Sign-Signup-Federated-Owner-Directive-v1_2-LOCKED.md` and `…-Amendment-A1-Organization-Details-US-Only-v1_0-LOCKED.md` §1 "Lead Architect rulings" (organization details, US-only billing region).
- `Aramo-ROLES-1-Organization-and-Product-Role-Model-Implementation-Directive-v1_0-LOCKED.md` (2026-10-21) §4 "Last-owner invariant" and §5 "Migration" (one guarded, idempotent `DO $$` role-mapping migration); parent `Aramo-ADR-0035-Organization-and-Product-Role-Model-v1_0-LOCKED.md`. ROLES-1 §2 records its own divergences from ADR-0035 text and governs where they differ.

### A16 — Technical screening data model
- `ARAMO-TIP-E2E-INC-3-v1.0-LOCKED.md` (2026-10-15) §4 "Data model (schema `technical_screening`)" and §10.1 "Deletion boundary (D8: UPDATE immutability, governed DELETE)"; `ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md` Part B (B.2 provenance model, B.3 question plan, B.4 assistance ledger) adds the A1 tables and governs where it differs from INC-3. ATI-SEP-1 §4 row F-1 makes screening findings ATS-private.

### A17 — Shared document template library
- `Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED.md` (2026-10-20) §2 D1 "One template library, two owners", D4 "Tenants can use a default without copying it", D7 "One Aramo-maintained catalog of variables"; implemented under `Aramo-DOC-TEMPLATE-LIB-1-Shared-Document-Template-Library-Implementation-Directive-v1_0-LOCKED.md` and its Conforming Amendments (the amendments govern where they differ).

### A18 — Outlook meeting scheduling persistence
- `doc/directives/Aramo-COMM-C2B-Amendment-A1-Outlook-Scheduling-v1_0-LOCKED.md` §3 "Ratified rulings (Architect, M365-SCHED-1)", R3 "Provider-side idempotency": the ratified basis for the `communications.MeetingSchedulingOperation` sidecar ledger.

## Where no ratified anchor was located (explicit)

- **No single ratified document enumerates the canonical namespace set at exactly 51.** The conventions doc states the per-module rule (A1); the namespace count is an AS-BUILT fact, not an AS-DESIGNED anchor.
- **No ratified anchor was found that specifies which outbox tables the shared publisher must drain.** ADR-0033 states the transport design and names "7 domain OutboxEvent tables" as a baseline fact (A7); ADR-0036 §3 names the ATS → TI outbox drain. Neither ratifies a required/forbidden drain set for `documents` or `offer` outbox tables. The drain-coverage observation in the gap fragment is an AS-BUILT finding, not a code-vs-spec contradiction against a located anchor.
- **No `doc/architecture/*` file at this SHA restates §7.1/§7.2/§7.3** verbatim; schema headers (including the new `subscription`, `signature_routing` and `technical_screening` headers) cite "Architecture v2.0/v2.1 §7.x" but those versioned architecture documents are not the checked-in files under `doc/architecture/`. The checked-in ratified equivalent is `doc/05-conventions.md` (A1–A4).
- **No ratified anchor was found for a shared `audit` namespace owned by two modules** (`consent` and `communications`).
- **Not cited as intent:** `Aramo-ATS-QA-1-Package-1-Implementation-Directive-v1_0-LOCKED.md` carries the status line "RATIFICATION-READY, **not LOCKED**" despite its file name; it is the stated source of the `talent_evidence` education retirement/audit tables but is not used as an anchor here. DRAFT directives in `Aramo/documents/` (e.g. the ORG-UX-1 draft lineage, the S5-A addendum) are likewise not cited.
