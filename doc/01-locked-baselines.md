# Locked Baselines

This file is the **authoritative pointer** to Aramo's four locked program documents. These documents are the source of truth for every architectural, product, and contract decision.

**Hard rule:** Claude Code may not interpret around these documents. If a locked spec says X, the implementation matches X. If a spec is ambiguous, the resolution is in the Lead Engineer's hands, not Claude Code's.

---

## The Seven Locked Baselines

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

### 5. Aramo Phase 1 Delivery Plan v1.5 — LOCKED

**What it is:** The milestone-scoping and delivery-discipline baseline. Defines milestone scope (M0–M7), per-milestone Track A / Track B deliverables, exit criteria, the Definition of Done criteria the CI deployment-gate enforces, and the 4-stage gate sequence each PR must pass.

**Read it for:**
- Milestone scope and sequencing (M0 platform, M1 consent runtime, M2 ingestion, M3 matching, M4 entrustability + IaC + observability + CVE, M5 engagement, M6 sensitive-field, M7 production hardening) — §3
- Per-milestone Track A (Platform Build) + Track B (Contract Enforcement) deliverables — §3
- Definition of Done (7 criteria; criterion #6 names the deployment-gate; criterion #7 names the refusal-layer integrity record) — §6
- 4-stage gate sequence (substrate-check, directive draft, implementation, deployment-gate) — §4
- M4 Track A item 5 — "All cloud resources expressed as declarative IaC artifacts under version control" — the authoritative anchor for M4 PR-8 IaC foundation work

**Supersedes:** Plan v1.2 (locked at M0). Plan v1.2 references are carried as historical context in `doc/m0-closure-record-draft.md`, `doc/m1-closure-record-draft.md`, and the M0/M1 refusal sign-offs under `doc/milestone-signoffs/`; those references remain accurate for the milestones they describe. All new milestone work cites Plan v1.5.

**Do not look here for:**
- Why a refusal exists (use Charter)
- How an entity is structured (use Group 2)
- Engineering decisions like cloud provider (use Architecture)
- API endpoint signatures (use API Contracts)

**File location:** `Aramo-Phase-1-Delivery-Plan-v1.5-LOCKED.docx` (sha256 `d2e62ffb...cc472e`)

---

### 6. Architecture v2.0/v2.1 §15 — Observability and Operations — LOCKED

**What it is:** The locked architectural specification for observability and operational telemetry across the Aramo platform. §15 of Architecture v2.0 (carried through v2.1) defines the canonical observability stack and core metrics.

**Read it for:**
- §15.1 "Observability Stack" — canonical AWS observability services: CloudWatch Metrics, CloudWatch Dashboards, CloudWatch Logs, CloudWatch Insights, AWS X-Ray + OpenTelemetry, CloudWatch Alarms → PagerDuty.
- §15.3 "Metrics" — core metrics named including `outbox_lag_seconds`.

**File location:** `Aramo-Architecture-v2_0-v1_2-LOCKED.docx` (carried in v2.1; sha256 `7b73ce18...b1861f`)

M4 PR-9 (observability) is the first PR consuming §15 substrate. Module population: CloudWatch Logs at PR-9; CloudWatch Metrics + X-Ray + OpenTelemetry + PagerDuty deferred to M4-close hardening / M5.

---

### 7. Aramo Phase 1 Delivery Plan v1.5 §M4 Track A item 6 — Observability standard — LOCKED

**What it is:** The Plan v1.5 mandate establishing observability as a per-PR standard from M4 onward.

**Verbatim text (Anchor 1, Plan v1.5 §M4 Track A):**
> "Observability as a per-PR standard (added v1.4 — D-ENT-READY-1): from M4 onward, every new service/PR ships structured logging, metrics, and trace context per Architecture §15.3; enforced via the PR Execution Model Stage 3 and the Lead review checklist. Dashboards and runbooks built incrementally as their subject systems land."

**Cross-reference (Plan v1.5 amendments preamble):**
> "Version 1.4 amendment … Adds deliverables scheduling implementation of Architecture v2.0/v2.1 §15 (observability), §16 (performance), §17 (disaster recovery), §19.2 (security-scan deployment gate) … into milestones M4–M7 … Front-loads infrastructure-as-code and observability as prerequisite work."

**File location:** `Aramo-Phase-1-Delivery-Plan-v1.5-LOCKED.docx` (sha256 `d2e62ffb...cc472e`; already locked at §5).

**Retroactive compliance:** The mandate applies "from M4 onward." M4 PR-1 through PR-7 shipped without metrics or W3C trace context (only informal structured logging emerged via NestJS Logger). PR-9 establishes the forward-going standard; retroactive sweep across M4 PR-1–PR-7 deferred to M4-close hardening (per PR-9 directive Ruling 8 forthcoming).

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
| 2026-05-23 | Add Plan v1.5 as fifth locked baseline; supersedes Plan v1.2 (carried for M0/M1 historical references). Resolves M4 PR-8 substrate-audit §C.11 finding — Plan v1.5 §M4 Track A item 5 ("declarative IaC artifacts under version control") is the authoritative anchor for the M4 PR-8 IaC foundation directive. | Lead Engineer |
| 2026-05-23 | Add §6 Architecture v2.0/v2.1 §15 (Observability and Operations) + §7 Plan v1.5 §M4 Track A item 6 (Observability as a per-PR standard) as sixth and seventh locked baselines. Resolves M4 PR-9 substrate-audit §A.1 / Q0 finding — §15.1 canonical observability stack (CloudWatch + X-Ray + OpenTelemetry + PagerDuty) and §15.3 core metrics naming are the authoritative substrate for PR-9 IaC module-population work; Plan v1.5 §M4 item 6 establishes observability as a per-PR standard from M4 onward. SECOND INSTANCE of the substrate-coherence pre-PR pattern (PR-8 lesson 1; first instance PR #57). | Lead Engineer |
