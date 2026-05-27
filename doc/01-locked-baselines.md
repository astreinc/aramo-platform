# Locked Baselines

This file is the **authoritative pointer** to Aramo's four locked program documents. These documents are the source of truth for every architectural, product, and contract decision.

**Hard rule:** Claude Code may not interpret around these documents. If a locked spec says X, the implementation matches X. If a spec is ambiguous, the resolution is in the Lead Engineer's hands, not Claude Code's.

---

## The Locked Baselines

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

### 3. Aramo Architecture v2.0 — v2.2 LOCKED (current canonical; v2.1 full text + v2.2 amendment)

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

**File location (dual citation per BA-1 audit ruling):**
- `Aramo-Architecture-v2_0-v2_1-LOCKED.docx` (full architecture text; sha256 `7b73ce18...b1861f`) — citation locus for §15 + §19.2 body text quoted at §6 + §8.
- `Aramo-Architecture-v2_0-v2_2-LOCKED.docx` (current canonical revision; sha256 `37096fc3...fb801`; supersedes v2.1 entirely; delta-amendment adding only §1.1 9th deployable `aramo-tenant-console` + §2.4 deployable description; carries forward v2.1's body — including §15 Observability + §19.2 Deployment Gates — unchanged by reference).

A single-revision swap was rejected: v2.2 is a delta-amendment that does not physically contain the §15 + §19.2 text §6/§8 cite verbatim, so pointing the sha256 anchor at v2.2 alone would break the citation contract for readers who pull the file looking for that text. Dual citation reconciles freshness (current canonical = v2.2) with citation-locus integrity (§15/§19.2 body text = v2.1's hash).

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

**File location:** `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx` (sha256 `d2e62ffb...cc472e`)

---

### 6. Architecture v2.0/v2.1 §15 — Observability and Operations — LOCKED

**What it is:** The locked architectural specification for observability and operational telemetry across the Aramo platform. §15 of Architecture v2.0 (carried through v2.1) defines the canonical observability stack and core metrics.

**Read it for:**
- §15.1 "Observability Stack" — canonical AWS observability services: CloudWatch Metrics, CloudWatch Dashboards, CloudWatch Logs, CloudWatch Insights, AWS X-Ray + OpenTelemetry, CloudWatch Alarms → PagerDuty.
- §15.3 "Metrics" — core metrics named including `outbox_lag_seconds`.

**File location (dual citation per BA-1 audit ruling; §3 has full rationale):**
- `Aramo-Architecture-v2_0-v2_1-LOCKED.docx` (full §15 text; sha256 `7b73ce18...b1861f`).
- `Aramo-Architecture-v2_0-v2_2-LOCKED.docx` (current canonical revision; sha256 `37096fc3...fb801`; supersedes v2.1 entirely; carries §15 forward unchanged by reference).

M4 PR-9 (observability) is the first PR consuming §15 substrate. Module population: CloudWatch Logs at PR-9; CloudWatch Metrics + X-Ray + OpenTelemetry + PagerDuty deferred to M4-close hardening / M5.

---

### 7. Aramo Phase 1 Delivery Plan v1.5 §M4 Track A item 6 — Observability standard — LOCKED

**What it is:** The Plan v1.5 mandate establishing observability as a per-PR standard from M4 onward.

**Verbatim text (Anchor 1, Plan v1.5 §M4 Track A):**
> "Observability as a per-PR standard (added v1.4 — D-ENT-READY-1): from M4 onward, every new service/PR ships structured logging, metrics, and trace context per Architecture §15.3; enforced via the PR Execution Model Stage 3 and the Lead review checklist. Dashboards and runbooks built incrementally as their subject systems land."

**Cross-reference (Plan v1.5 amendments preamble):**
> "Version 1.4 amendment … Adds deliverables scheduling implementation of Architecture v2.0/v2.1 §15 (observability), §16 (performance), §17 (disaster recovery), §19.2 (security-scan deployment gate) … into milestones M4–M7 … Front-loads infrastructure-as-code and observability as prerequisite work."

**File location:** `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx` (sha256 `d2e62ffb...cc472e`; already locked at §5).

**Retroactive compliance:** The mandate applies "from M4 onward." M4 PR-1 through PR-7 shipped without metrics or W3C trace context (only informal structured logging emerged via NestJS Logger). PR-9 establishes the forward-going standard; retroactive sweep across M4 PR-1–PR-7 deferred to M4-close hardening (per PR-9 directive Ruling 8 forthcoming).

---

### 8. Architecture v2.0/v2.1 §19.2 — Deployment Gates (Security-Scan) — LOCKED

**What it is:** The locked architectural specification for the deployment-gate aggregator across the Aramo platform. §19.2 of Architecture v2.0 (carried through v2.1) defines the required gates that must pass before production deployment, including the security-scan gate that authorizes M4 PR-10 (CVE-scanning) and onward security-scan deliverables.

**Verbatim text (Architecture v2.0/v2.1 §19.2 "Deployment Gates"):**
> "Required before production deployment:
> - unit tests pass
> - integration tests pass
> - contract tests pass
> - migration dry run passes
> - security scan passes
> - OpenAPI diff reviewed
> - module-boundary checks pass"

**Read it for:**
- The seven-item deployment-gate list — `security scan passes` is the authoritative anchor for CVE / dependency / IaC-security scan deliverables.
- Sequencing relative to the other gate items (security scan is one of seven peer gates; not gated by, and does not gate, the other six).
- Gate placement: pre-production-deployment, in-CI, aggregated.

**File location (dual citation per BA-1 audit ruling; §3 has full rationale; same files referenced at §6):**
- `Aramo-Architecture-v2_0-v2_1-LOCKED.docx` (full §19.2 text; sha256 `7b73ce18...b1861f`).
- `Aramo-Architecture-v2_0-v2_2-LOCKED.docx` (current canonical revision; sha256 `37096fc3...fb801`; supersedes v2.1 entirely; carries §19.2 forward unchanged by reference).

M4 PR-10 (CVE-scanning) is the first PR consuming §19.2 substrate. Module population at PR-10: tfsec (IaC security scanning) + npm audit (Node dependency scanning). Other scan types (SAST, secrets, container) deferred to M4-close housekeeping and M5+. The §19.2 gate is also wired explicitly into the deployment-gate CI aggregator as a Plan v1.5 §M6 Track A deliverable ("Architecture §19.2 security-scan deployment gate wired"); PR-10 is the M4 prerequisite that delivers the scan jobs the M6 aggregator wiring consumes.

---

### 9. Aramo Phase 1 Delivery Plan v1.5 §M4 Track A item 7 — Dependency-vulnerability scanning CI gate — LOCKED

**What it is:** The Plan v1.5 mandate establishing dependency/CVE scanning as a required CI gate from M4 onward.

**Verbatim text (Anchor 2, Plan v1.5 §M4 Track A):**
> "Dependency-vulnerability scanning CI gate (added v1.4 — D-ENT-READY-1): a dependency/CVE scanning job added to CI so new code is scanned from M4 onward."

**Cross-reference (Plan v1.5 amendments preamble):**
> "Version 1.4 amendment … Adds deliverables scheduling implementation of Architecture v2.0/v2.1 §15 (observability), §16 (performance), §17 (disaster recovery), §19.2 (security-scan deployment gate), §9 (background jobs), and §14 (security review) into milestones M4–M7 … Front-loads infrastructure-as-code and observability as prerequisite work."

**File location:** `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx` (sha256 `d2e62ffb...cc472e`; already locked at §5).

**Forward-going compliance:** The mandate applies "from M4 onward." PR-10 establishes the forward-going standard via tfsec (IaC) + npm audit (Node deps) CI jobs. Baseline vulnerabilities present at HEAD `466298f` (4 high / 5 moderate per audit §B.4) are handled at PR-10 via an allow-list mechanism so the gate fails only on new findings; retroactive triage of the baseline vulnerability set is deferred to M4-close hardening (per PR-10 directive Ruling 6 forthcoming).

---

## §10. Plan v1.5 §M5 Track A item 1 — Engagement state machine

**Source 1:** `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx` §M5 Track A item 1 (canonical; sha256 `d2e62ffb…cc472e`).

**Source 2:** `Aramo-Plan-v1_5-Correction-Note-v1_0-LOCKED.md` (Plan parenthetical count corrected from "10 states" to "11 states on `TalentJobEngagement` per Group 2 §2.3b Part 2 Loops 1-5"; NOT §23.2 scope-affecting; informational count fix aligning with binding canonical source per Hierarchy of Authority §207-213).

**Source 3:** `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx` §2.3b Part 2 Loops 1-5 (binding product specification per Hierarchy of Authority).

**Verbatim anchor 1** — Plan v1.5 §M5 Track A item 1 (post-Correction-Note v1.0):

> Engagement state machine (11 states on `TalentJobEngagement` per Group 2 §2.3b Part 2 Loops 1-5).

**Verbatim anchor 2** — Group 2 §2.3b Part 2 Loops 1-5 (binding canonical state-machine narrative):

```
Loop 1 — Matching Loop (system-driven)
  Re-matching behavior table:
    Engaged       → Excluded from match list
    Maybe         → Included, may move in rank
    Passed        → Excluded (v1 default)
    Not evaluated → Included
  State transitions: null → surfaced → evaluated

Loop 2 — Recruiter Evaluation Loop
  State transitions:
    surfaced → evaluated →
      ├── engaged
      ├── maybe
      └── passed

Loop 3 — Engagement Loop (Human + AI Assisted)
  State transitions:
    evaluated → engaged → awaiting_response

Loop 4 — Response Conversation Loop
  State transitions:
    awaiting_response → responded   (trigger: candidate reply)
    responded → in_conversation     (trigger: recruiter sends first reply)
    in_conversation →
      ├── not_interested
      └── ready_for_submittal

Loop 5 — Submittal Handoff Loop
  State transitions:
    Entity: TalentSubmittalRecord
      created → handoff_draft → ready_for_review → submitted_to_ats → confirmed
    Entity: TalentJobEngagement
      ready_for_submittal → submitted
```

**TalentJobEngagement state enumeration (11 binding values, post-Correction-Note v1.0):**

1. `surfaced` — initial state on matching-engine row creation (Loop 1 `null → surfaced`).
2. `evaluated` — recruiter has begun evaluation (Loop 1 `surfaced → evaluated`; Loop 2 source).
3. `engaged` — recruiter chose to engage (Loop 2 branch).
4. `maybe` — recruiter deferred decision (Loop 2 branch; terminal from engagement-entity perspective; re-matching may re-rank per Loop 1).
5. `passed` — recruiter declined (Loop 2 branch; terminal).
6. `awaiting_response` — outreach message sent; awaiting candidate reply (Loop 3).
7. `responded` — candidate replied (Loop 4; trigger: candidate reply).
8. `in_conversation` — recruiter sent first reply; conversation active (Loop 4; trigger: recruiter sends first reply).
9. `not_interested` — candidate not interested in opportunity (Loop 4 branch; terminal).
10. `ready_for_submittal` — recruiter judges candidate ready for ATS submittal (Loop 4 branch).
11. `submitted` — submittal handoff completed; engagement-side terminal (Loop 5 `Entity: TalentJobEngagement`).

**10 legal transitions** per Loops 2-5 narrative (Loop 1 `null → surfaced` is row creation, not a state transition):

1. `surfaced → evaluated`
2. `evaluated → engaged`
3. `evaluated → maybe`
4. `evaluated → passed`
5. `engaged → awaiting_response`
6. `awaiting_response → responded`
7. `responded → in_conversation`
8. `in_conversation → not_interested`
9. `in_conversation → ready_for_submittal`
10. `ready_for_submittal → submitted`

**Terminal states** (no outgoing transitions): `maybe`, `passed`, `not_interested`, `submitted`.

**Note on `not_evaluated`**: the Loop 1 re-matching behavior table label "Not evaluated" describes the row-absence case ("engagement record not yet created for this talent+requisition pair") — operationally equivalent to `null` in Loop 1's `null → surfaced → evaluated` transition. It is NOT a stored `TalentJobEngagement.state` value. Per Plan Correction Note v1.0 §2.4.

**Note on TalentSubmittalRecord scope**: Loop 5's `TalentSubmittalRecord` state machine (`created → handoff_draft → ready_for_review → submitted_to_ats → confirmed`) is a distinct entity's state machine — M5 PR-8 territory per `Aramo-M5-Charter-v1_2-LOCKED.md` §4.3. NOT in scope for the M5 PR-1 `TalentJobEngagement` entity foundation; F37 (SubmittalState 3→5 expansion) closes at M5 PR-8.

**M5 PR-1 directive anchors** (read jointly):
- `Aramo-M5-PR-1-Directive-v1_0-LOCKED.md` Rulings 1, 2, 3, 5, 8, 9, 10, 11 (unchanged).
- `Aramo-M5-PR-1-Directive-Amendment-v1_1-LOCKED.md` §2 (Ruling 4 — 11-state enum), §3 (Ruling 6 — 10-transition trigger), §4 (Ruling 7 — `canTransition` 11×11 matrix).

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
| 2026-05-24 | Add §8 Architecture v2.0/v2.1 §19.2 (Deployment Gates — security-scan) + §9 Plan v1.5 §M4 Track A item 7 (Dependency-vulnerability scanning CI gate) as eighth and ninth locked baselines. Resolves M4 PR-10 substrate-audit §A / Q0 finding — §19.2 deployment-gate list (with `security scan passes` as the authoritative anchor) and Plan v1.5 §M4 item 7 (CVE-scanning gate from M4 onward) are the authoritative substrate for PR-10 CVE-scanning CI integration work. THIRD INSTANCE of the substrate-coherence pre-PR pattern (PR-8 lesson 1; first instance PR #57; second instance PR #59). Pattern PROMOTED from "recurring lesson" to documented program convention for foundation-laying work in new spec territory. | Lead Engineer |
| 2026-05-24 | M4-close housekeeping HK-PR-1 (items 1 + 2 doc-layer bundle): (a) ADR index alignment at `doc/adr/README.md` — appended 4 missing rows (ADR-0011 / ADR-0012 / ADR-0013 / ADR-0014); (b) Architecture dual-citation refresh at §3 / §6 / §8 per BA-1 audit ruling — `Aramo-Architecture-v2_0-v2_1-LOCKED.docx` (sha256 `7b73ce18...b1861f`; full text + citation locus for §15 / §19.2) carried forward unchanged by `Aramo-Architecture-v2_0-v2_2-LOCKED.docx` (sha256 `37096fc3...fb801`; current canonical revision; delta-amendment adding only §1.1 9th deployable + §2.4 description); single-revision swap rejected (would break citation contract for §15/§19.2 body text). Plan v1.5 confirmed full-rewrite (NOT delta-amendment) by reading canonical Status block — no dual-citation needed for §5 / §7 / §9. (c) ci.yml stale "13 required deployment gates" comments at the `deployment-gate` step resolved via approach (b) — count removed from `name:` + final `echo` so the dynamic `grep -qE` check is the sole source of truth (resilient to future CI growth). M4-close housekeeping lesson 1 RECORDED: delta-amendment documents require dual citation when the superseding revision is a delta (not full rewrite); pattern likely applies at future foundation-laying doc-lock pre-PRs. | Lead Engineer |
| 2026-05-24 | M4-close housekeeping HK-PR-2 (items 5 + 6 + Plan filename hygiene): (a) Item 5 — npm audit baseline triage: 3 baseline HIGH GHSAs (GHSA-2w69-qvjg-hvjx + GHSA-q3j6-qgpj-74h6 + GHSA-v39h-62p7-jpjc) resolved via react-router-dom 6.22.0 → 6.30.3 (exact-pin per Lead supply-chain-hardening preference, deliberate divergence from workspace tilde-pin convention) + `overrides.fast-uri: "3.1.2"` (forces all transitive instances; resolves both fast-uri GHSAs via single override). `.github/npm-audit-allowlist.json` advisories array now empty; CI gate fires only on NEW HIGH/CRITICAL findings going forward. (b) Item 6 — Dependabot YAML: `.github/dependabot.yml` codified (BA-2 confirmed org-enabled). Three ecosystems: npm (weekly Monday + security-updates grouped), github-actions (weekly Monday), terraform (monthly). Conservative open-PR limit (10 npm); standard commit-message prefixes (deps/ci/infra). (c) Item 6B — Plan filename hygiene: replaced `Aramo-Phase-1-Delivery-Plan-v1.5-LOCKED.docx` (dotted, stale) → `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx` (underscored, matches canonical store) at §5 / §7 / §9. Lesson 2 grep-based scope applied (single-pass; post-edit grep returns zero dotted hits). | Lead Engineer |
| 2026-05-24 | M5 PR-1 doc-lock: Added §10 (Plan v1.5 §M5 Track A item 1 — Engagement state machine; Group 2 §2.3b Part 2 Loops 1-5 binding canonical; 11-state TalentJobEngagement enumeration; 10-transition matrix). Renamed "The Nine Locked Baselines" → "The Locked Baselines". Per Plan Correction Note v1.0 + Directive Amendment v1.1. | Lead Engineer |
## §11. Plan v1.5 §M5 Track B verbatim anchor (PR-9 + PR-10 + PR-11 + M5-close binding)

The M5 milestone (per `Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx`) ships in two tracks. Track A scope is decomposed into M5 PR-1 through PR-8b2 (closed at PR #84, #85, #86, #87, #88, #89, #90, #103, #104, #105, #106; trifecta-close on row 8). Track B scope ships across the remaining M5 PRs.

**Plan v1.5 §M5 Track A verbatim** (CLOSED on PR-#106):

> ### Track A
> - Engagement state machine (10 states per Group 2 v2.3b Part 2)
> - Outreach flow with AI-assisted draft generation
> - Submittal handoff_draft → confirmed flow
> - Examination version pinning at draft creation
> - Disaster-recovery mechanism implementation begins (added v1.4 — D-ENT-READY-1): RDS automated backups and point-in-time recovery configuration per Architecture §17.2, on the M4 infrastructure-as-code track.
> - Architecture §9 background jobs scheduled (added v1.4 — D-ENT-READY-1): the four Aramo Core BullMQ jobs (stale-consent, outbox publisher, cross-schema consistency check, skill canonicalization) implemented explicitly, each in the milestone owning its domain; not left implicit.

Track A items 1-4 closed via M5 PR-1 through PR-8b2. Track A items 5-6 (DR + background jobs) remain OPEN and ship via M5 PR-10 + PR-11.

**Plan v1.5 §M5 Track B verbatim** (PR-9 binding):

> ### Track B
> - Pact tests for illegal state transitions returning ENGAGEMENT_STATE_INVALID
> - Idempotency replay tests (same key + same body returns original; same key + different body returns 409)
> - Consent enforcement at message send time (not just engagement creation)
> - Pinned examination version verified; newer version triggers EXAMINATION_PINNED_OUTDATED

**Track B item-to-PR mapping** (per Lead disposition + audit-time verification):

| Track B Item | Verbatim text | M5 PR | Status |
|---|---|---|---|
| 1 | Pact tests for illegal state transitions returning ENGAGEMENT_STATE_INVALID | TBD (audit-verify at PR-9 substrate audit) | OPEN (may be substantively shipped via PR-4 + PR-8b2; PR-9 audit Axis to confirm) |
| **2** | **Idempotency replay tests (same key + same body returns original; same key + different body returns 409)** | **PR-9 (target)** | **OPEN; PR-9 target scope** |
| 3 | Consent enforcement at message send time (not just engagement creation) | PR-9b (closed at #TBD) | CLOSED at PR-9b |
| 4 | Pinned examination version verified; newer version triggers EXAMINATION_PINNED_OUTDATED | PR-4 + PR-8b1 examination-pinning Ruling 24 verification | CLOSED at PR-8b1 Gate 5 §6.21 + PR-8b2 Ruling 24 reaffirmation |

**Plan v1.5 §M5 Exit Criteria verbatim**:

> ### Exit Criteria
> - No outreach without runtime contacting consent
> - State transitions deterministic; illegal transitions return 422
> - Submittal confirm requires all three attestations true

Exit Criteria items 1-3 ship across Track A + Track B; M5 close-out verification at M5-close handoff.
