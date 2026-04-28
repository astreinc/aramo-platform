# Locked Baselines

This file is the **authoritative pointer** to Aramo's four locked program documents. These documents are the source of truth for every architectural, product, and contract decision.

**Hard rule:** Claude Code may not interpret around these documents. If a locked spec says X, the implementation matches X. If a spec is ambiguous, the resolution is in the Lead Engineer's hands, not Claude Code's.

---

## The Four Locked Baselines

### 1. Aramo Charter v1.0 — LOCKED

**What it is:** The program-level canonical reference. Defines what Aramo is, why it exists, how it operates, and what it refuses to become.

**Read it for:**
- Program vision and the intentional tradeoff between evidence-discipline and edge-case flexibility
- The thirteen Charter refusals (Section 8 — what Aramo will not do)
- The architectural posture (tenant isolation, consent immutability, declared/ingested/derived separation)
- Specification discipline meta-principles

**Do not look here for:**
- Specific entity definitions (use Group 2)
- API specifications (use API Contracts)
- Engineering decisions like cloud provider (use Architecture)

**File location:** `Aramo-Charter-v1.0-LOCKED.docx` (program documentation; ask Lead Engineer for current location)

---

### 2. Aramo Group 2 Consolidated Baseline v2.0 — LOCKED

**What it is:** The product specification baseline. Ten locked specs covering the talent record, ingestion pipeline, recruiter workflow, examination output, entrustability, evidence package, consent contract, and talent portal.

**Read it for:**
- Entity definitions (24 first-class entities) — Section 2.2
- Threshold definitions (Graph Entry, Examinable, Entrustable) — Section 2.1
- Ingestion source policies — Section 2.3a
- Recruiter workflow loops and state machines — Section 2.3b
- Examination output schema (TalentJobExamination) — Section 2.4
- Entrustability rule set with role-family thresholds — Section 2.5
- Evidence Package schema (TalentJobEvidencePackage) — Section 2.6
- Consent scope semantics and the staleness stance — Section 2.7
- Talent Portal Minimum surface and refusal commitments — Section 2.8

**Do not look here for:**
- API endpoint definitions (use API Contracts)
- Cloud architecture (use Architecture)
- Implementation specifics

**File location:** `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx`

---

### 3. Aramo Architecture v2.0 — v1.2 LOCKED

**What it is:** The engineering blueprint. Hybrid architecture (Aramo Core modular monolith + extracted Talent Portal + per-source Ingestion Adapters). Technology stack, deployment topology, persistence strategy, refusal enforcement mechanisms, and operational requirements.

**Read it for:**
- Service architecture (modular monolith vs extracted services) — Section 1
- Repository structure (`aramo-core` Nx monorepo, separate adapter repos) — Section 4
- Technology stack (TypeScript, NestJS, PostgreSQL, Prisma, Redis, AWS) — Section 5
- Communication topology (star topology, no inter-service calls) — Section 3
- Schema-per-module data architecture — Section 7
- Outbox pattern for async events — Section 7.6
- Skills Taxonomy module — Section 8
- Consent enforcement architecture — Section 10
- Refusal enforcement mapping — Section 11

**Do not look here for:**
- Specific endpoint signatures (use API Contracts)
- Product behavior (use Group 2)

**File location:** `Aramo-Architecture-v2.0-v1.2-LOCKED.docx`

---

### 4. Aramo API Contracts v1.0 — Phases 1-6 LOCKED

**What it is:** The machine-readable contract surface. Six phases covering common foundations, ATS API, Portal API, Ingestion API, error model, and OpenAPI/Pact/CI infrastructure.

**Read it for:**
- Foundation conventions (auth, tenant scoping, idempotency, pagination) — Phase 1
- ATS endpoint surface (39 operations, 11 groups) — Phase 2
- Portal endpoint surface (12 operations, 7 groups, refusal-filtered) — Phase 3
- Ingestion endpoint surface (15 operations, 7 groups, four-layer LinkedIn refusal) — Phase 4
- Unified error envelope and 36-code registry — Phase 5
- OpenAPI files and CI enforcement scripts — Phase 6

**Companion artifacts:**
- `openapi/common.yaml` — 51 schemas, 5 consent endpoints
- `openapi/ats.yaml` — 39 operations
- `openapi/portal.yaml` — 12 operations
- `openapi/ingestion.yaml` — 15 operations
- `ci/scripts/` — drift detection, refusal enforcement, version sync, error codes

**Do not look here for:**
- Why a refusal exists (use Charter)
- How an entity is structured (use Group 2)
- Why a tech choice was made (use Architecture)

**File location:** `Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx`

---

## Hierarchy of Authority

When sources appear to conflict:

1. **Charter** wins over everything (program identity)
2. **Group 2** wins over Architecture and API Contracts (product specification)
3. **Architecture** wins over API Contracts (engineering decisions)
4. **API Contracts** governs API behavior

If a real conflict exists, **stop and escalate to Lead Engineer or Architect.** Do not resolve conflicts by interpretation.

---

## How Claude Code Should Reference These

In every PR prompt, the "Locked Specs" section must reference specific section numbers, not paraphrases.

**Good:**
> "Per Group 2 Section 2.4, TalentJobExamination is immutable after creation."

**Bad:**
> "Per the spec, examinations can't change after they're created."

The first reference is verifiable; the second is a paraphrase that may drift.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
