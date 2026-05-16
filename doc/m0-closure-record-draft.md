*Aramo M0 Closure Record — DRAFT (pending PO ratification)*

**ARAMO**

*Talent Intelligence and Entrustment Platform*

**M0 Closure Record**

*Closure of Milestone M0 — Foundation + Contract Bootstrapping (with WS9 Authentication & Identity retroactively ratified under R-DRIFT-1)*

**VERSION 1.0 — DRAFT (pending PO ratification)**

Classification: Internal — Aramo Program

May 16, 2026

> **Note on status.** This file is the markdown working draft produced
> by Gate 5 of PR-M0R-3. Post-merge, the orchestration session
> converts this to `.docx`; the Business Analyst files it at the
> canonical OneDrive location as
> `Aramo-M0-Closure-Record-v1_0-LOCKED.docx`. The Product Owner
> ratifies via the §9 block at the bottom; the closure formally takes
> effect upon PO signature.

# Document Control

## Purpose

This document is the filed substrate artifact for the M0 milestone
closure. It consolidates: (a) the M0 scope and what shipped, (b) the
post-M0R-1 + M0R-2 + M0R-3 DoD status, (c) the per-refusal layer
integrity record (by reference to `doc/milestone-signoffs/M0-refusal-signoff.md`),
(d) cross-cutting achievements of the M0 cycle, (e) outstanding M7
follow-ups carried forward, and (f) going-forward commitments codified
during M0 execution.

It exists because Plan v1.2 §6 DoD criterion #6 requires CI to block
invalid deployments via a deployment gate (operationalized in M0R-3),
and criterion #7 requires explicit Lead-Engineer sign-off on refusal
preservation. This closure record + the M0 refusal sign-off together
constitute the substrate trail those criteria call for.

## Status

**DRAFT — Version 1.0.** Pending PO ratification per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). Upon
ratification this record is filed as `LOCKED — Version 1.0` at the
canonical OneDrive location.

## Authority

Drafted under engineering Lead/Architect authority per ADR-0008
Decision E. Ratified at milestone closure by Product Owner per the
operating-rule recalibration.

## Substrate basis

- Plan v1.2 §3 M0 (deliverables, exit criteria) + §6 DoD (7 criteria)
- M0 Remediation Plan v1.0 + Amendments v1.0/v1.1 (PR-M0R-1) +
  v1.0/v1.1 (PR-M0R-2) + Gate6 Commit Plans v1.0 + v1.1 amendment + v2
- R-DRIFT-1 Closure Record v1.0 (pattern reference + WS9 ratification trail)
- PR-M0R-3 Directive v1.0 (this PR's authoring directive)
- `doc/milestone-signoffs/M0-refusal-signoff.md` (the §6 DoD #7 sign-off)
- Post-merge main HEAD `99aacd5` (the substrate state at which M0 closes)

## Relationship to other artifacts

- Aramo Charter v1.0 — LOCKED (unchanged by M0 closure)
- Aramo Architecture v2.0 — v2.1 LOCKED (referenced; M0 work is consistent with §1.1 deployable list as amended under R-DRIFT-1)
- Aramo Phase 1 Delivery Plan v1.2 — LOCKED (M0 is the first milestone closing under v1.2; subsequent milestones M1–M7 follow)
- Aramo API Contracts v1.0 — Phases 1-6 LOCKED (M0 implements Phase 1 consent surface + Phase 6 CI infrastructure machinery)
- Aramo Group 2 Consolidated Baseline v2.0 — LOCKED (unchanged by M0)
- R-DRIFT-1 Closure Record v1.0 — LOCKED (M0 inherits the WS9 ratification trail; the authentication service vector is in-scope for M0 via that closure record)

## Approver

| Role | Responsibility | Signature | Date |
|---|---|---|---|
| Product Owner | Sole ratifying authority for milestone closure per operating-rule recalibration | [to be filled in by PO] | [to be filled in by PO] |

# 1. Subject of Closure

## 1.1 What M0 is

M0 is the first milestone of the Aramo Phase 1 Delivery Plan. Per Plan
v1.2 §3 M0, the scope is:

**Track A — Platform Build:**
- Nx monorepo (`aramo-core`)
- NestJS application bootstrap
- Prisma setup with first schema migration
- Auth module skeleton (JWT issuance/validation)
- CI pipeline baseline (build, lint, test)

**Track B — Contract Enforcement:**
- OpenAPI structure initialized (`common.yaml`)
- Pact framework initialized (consumer + provider scaffolding)
- First deliberate-failure CI test (drift detection)

Plus the **retroactive WS9 (Authentication & Identity)** scope ratified
under R-DRIFT-1 closure (May 15, 2026):
- PR-8.0a-prereq (`bfa05dc`, 2026-05-12): `libs/identity` foundation
- PR-8.0a (`a130f45`, 2026-05-13): `apps/auth-service` — 6 OAuth/PKCE/JWKS endpoints; `libs/auth-storage` refresh-token persistence with rotation chain and reuse detection
- PR-8.0b (`7366de3`, 2026-05-13): Aramo Platform Auth Integration — `libs/auth` guards, AuthContext, cookie session integration with `apps/api`

## 1.2 What shipped in the M0 Remediation cycle

Three PRs landed between May 15 and May 16, 2026, closing the five M0
DoD gaps identified by the May 15 substrate-verification pass:

### PR-M0R-1 — Pact provider scaffolding + auth-service consumer pacts

- Branch: `feature/pr-m0r-1-pact-infrastructure`
- Base commit: `21ab625` (Gate 5 v1); v2 commit: `545076e` (post-Amendment v1.2 + v1.3 fixes)
- Merge commit: `9f117a55f61c22924b3a5f9ec3ac7c8af291479e` (PR #26, merged 2026-05-16T01:08:49Z)
- Closes §6 DoD #3 (PARTIAL → PASS) and #4 (FAIL → PASS).
- Amendments: v1.0 (operative correction `apps/api` → `apps/auth-service`), v1.1 (deferred items registry), v1.2 (CI orchestration + Nx-alias fix rulings), v1.3 (replaced v1.2 §3.2 with Fix Option B — narrow eslint allow rule).

### PR-M0R-2 — Refusal enforcement scripts + drift-check + CI gate replacement

- Branch: `feature/pr-m0r-2-refusal-scripts`
- Base commit: `c91ea2b` (Gate 5 v1); drift inject commit `51d1ae0`; v2 commit `3c1b9fd` (post-Amendment v1.0 + v1.1 fixes; drift reverted)
- Merge commit: `99aacd5d64fbfd9ba1d343843c9126d1717adec5` (PR #27, merged 2026-05-16T01:16:38Z; this is also current main HEAD)
- Closes §6 DoD #5 (FAIL → PASS).
- Amendments: v1.0 (Policy 1 ratification + vocabulary fixes + doc allowlist), v1.1 (§4.5 refusal-script self-reference allowlist).
- Deliberate-failure CI test demonstrated: commit `51d1ae0` injected `internal_reasoning` into `openapi/portal.yaml`; CI run https://github.com/astreinc/aramo-platform/actions/runs/25919007604 produced `portal:refusal-check FAILED — 1 violation(s)` with exit code 1; drift then reverted in `3c1b9fd`; evidence in `doc/00-ci-deliberate-failure-evidence.md`.

### PR-M0R-3 — deployment-gate.yml + Refusal Sign-Off + M0 Closure Record (this PR)

- Branch: `feature/pr-m0r-3-deployment-gate-closure`
- Closes §6 DoD #6 (FAIL → PASS) and #7 (FAIL → PASS).
- Adds: `deployment-gate` aggregator job in `.github/workflows/ci.yml` wiring all 12 Plan v1.2 §4 Stage 4 named gates as `needs:` dependencies (VARIANT B per directive §4.1 — GitHub Actions does not support cross-workflow `needs:` natively; in-ci.yml aggregator is the authorized functionally-identical fallback); override-label discipline per §4.2; `doc/08-milestone-signoff-template.md` template; `doc/milestone-signoffs/M0-refusal-signoff.md` instantiation with all 13 Charter refusals verbatim and substrate-anchored per-refusal evidence; this Closure Record markdown draft.

## 1.3 Substrate baseline at M0 closure

- Repo: `astreinc/aramo-platform`
- Main HEAD at this draft's authoring: `99aacd5d64fbfd9ba1d343843c9126d1717adec5` (post-M0R-2 merge); PR-M0R-3 work pending merge will become the next main HEAD
- All four locked baselines (Charter v1.0, Architecture v2.1, Group 2 Baseline v2.0, API Contracts v1.0) at canonical OneDrive location, byte-verified

# 2. M0 DoD Status (7-criteria table)

| Criterion | Pre-remediation (2026-05-15) | Post-M0R-1+M0R-2 (2026-05-16) | Post-M0R-3 (this PR) |
|---|---|---|---|
| #1 APIs implemented per OpenAPI specification | PASS | PASS | PASS |
| #2 OpenAPI valid (swagger-cli + redocly lint) | PASS | PASS | PASS |
| #3 Pact consumer tests exist for every endpoint added | PARTIAL | **PASS** (via M0R-1) | PASS |
| #4 Provider verification passes against Aramo Core test environment | FAIL | **PASS** (via M0R-1) | PASS |
| #5 Refusal scripts pass | FAIL | **PASS** (via M0R-2) | PASS |
| #6 CI blocks invalid deployments (deployment-gate.yml enforcing all checks) | FAIL | FAIL | **PASS** (via M0R-3) |
| #7 Refusal layer integrity verified explicitly (Lead Engineer signs off on refusal preservation) | FAIL | FAIL | **PASS** (via M0R-3) |
| **Total PASS** | **2 of 7** | **5 of 7** | **7 of 7** |

Per Plan v1.2 §6 — "A milestone is complete ONLY if all seven criteria
pass. No partial closure; no 'we'll do that in the next milestone.'"
With all 7 PASS upon PR-M0R-3 merge + PO ratification of this record,
M0 is complete.

# 3. Refusal Layer Integrity

Per Plan v1.2 §6 DoD #7. The 13 Charter v1.0 refusal commitments have
been enumerated verbatim and evaluated against M0 scope. Full per-refusal
record at:

**`doc/milestone-signoffs/M0-refusal-signoff.md`**

Summary from that document:

| Group | Refusals | At-risk in M0 | Not-at-risk in M0 |
|---|---|---|---|
| Scope (R1–R3) | 3 | 0 | R1, R2, R3 |
| Behavior (R4–R10) | 7 | R4, R5, R6 (consent-related) | R7, R8, R9, R10 |
| Posture (R11–R13) | 3 | 0 (in M0 code paths) | R11, R12, R13 |
| **Total** | **13** | **3** | **10** |

All 3 at-risk refusals (R4, R5, R6) have substrate-anchored enforcement
mechanisms (code paths in `libs/consent`) and substrate-anchored
evidence (Pact tests at `pact/consumers/ats-thin/src/consent.consumer.test.ts`).
All 10 not-at-risk refusals have explicit rationale (API absence) plus
forward enforcement plans (CI scripts pre-staged, target milestone
named). The refusal layer is intact at M0 closure.

# 4. Cross-Cutting M0 Achievements

The M0 cycle (M0 v1 work + M0 Remediation) produced several
cross-cutting program-level achievements beyond the per-milestone DoD
list:

## 4.1 WS9 Authentication & Identity vector retroactively ratified

The authentication service vector (3 PRs: PR-8.0a-prereq, PR-8.0a,
PR-8.0b) shipped during M0–M1 execution but was not initially named in
the locked Phase 1 Delivery Plan v1.1. R-DRIFT-1 raised the alignment
question on May 15, 2026; PO ratification under amended §23.2 produced
Architecture v2.1 + Plan v1.2 amendments adding WS9 (Authentication &
Identity) as a named workstream with full retroactive scope. Filed at
`Aramo-R-DRIFT-1-Closure-Record-v1_0-LOCKED.docx` at canonical.

## 4.2 12 CI gates promoted from echo-deferred to real machinery

The Plan v1.2 §4 Stage 4 12-gate list — pre-remediation, 6 of 12 were
echo-deferred `::notice::` stubs that exited 0 trivially without
performing any check. M0R-1 + M0R-2 + M0R-3 promoted all 6:

| Gate | Pre-M0R | Post-M0R |
|---|---|---|
| `openapi:validate` | real (swagger-cli) | unchanged |
| `openapi:lint` | real (redocly) | unchanged |
| `openapi:drift-check` | echo-deferred | real (`compare-spec-to-openapi.ts`) via M0R-2 |
| `portal:refusal-check` | echo-deferred | real (`verify-portal-refusal.ts`) via M0R-2 |
| `ats:refusal-check` | echo-deferred | real (`verify-ats-refusal.ts`) via M0R-2 |
| `version:sync-check` | echo-deferred | real (`check-version-sync.ts`) via M0R-2 |
| `error-codes:check` | echo-deferred | real (`verify-error-codes.ts`) via M0R-2 |
| `pact:consumer` | real (vitest) | extended to chain `ats-thin` + `auth-service-consumer` via M0R-1 |
| `pact:provider` | echo-deferred | real (Postgres testcontainer + Pact verifier) via M0R-1 |
| `tests:unit` (`test-unit`) | real (nx test) | unchanged |
| `tests:integration` | real (vitest) | unchanged |
| `lint:nx-boundaries` | real (nx lint) | unchanged |

The new `deployment-gate` aggregator job (M0R-3) wires all 12 as
`needs:` dependencies and provides a single PASS/FAIL status check for
GitHub branch-protection wiring.

## 4.3 Deliberate-failure CI test demonstrated and recorded

Plan v1.2 §3 M0 Track B requires "First deliberate-failure CI test
(drift detection)." Demonstrated on the `feature/pr-m0r-2-refusal-scripts`
branch:

- Commit `51d1ae0` injected `DriftEvidenceMatchExplanation.properties.internal_reasoning` into `openapi/portal.yaml` (a Charter R10 violation).
- CI run https://github.com/astreinc/aramo-platform/actions/runs/25919007604 produced `portal:refusal-check FAILED — 1 violation(s): components.schemas.DriftEvidenceMatchExplanation.properties.internal_reasoning: exact-match forbidden field: internal_reasoning` with exit code 1.
- Commit `3c1b9fd` (M0R-2 v2) reverted the drift; `portal:refusal-check` returned to green.
- Full evidence in `doc/00-ci-deliberate-failure-evidence.md`.

The drift inject commit (`51d1ae0`) remains in branch history (and now
in main history) as the substrate trail proving the machinery works.

## 4.4 Five amendments authored and ratified

The M0 Remediation cycle produced five amendment documents, each
addressing a substrate-detected defect at a specific stage:

| Amendment | Defect / scope | Authority |
|---|---|---|
| PR-M0R-1 Directive Amendment v1.0 | `apps/api` → `apps/auth-service` provider-verification target correction | Engineering Lead/Architect |
| PR-M0R-1 Directive Amendment v1.1 | Deferred-items registry (M7 follow-ups F1–F5 + auth hardening) | Engineering Lead/Architect |
| PR-M0R-1 Directive Amendment v1.2 | CI orchestration fix (Defect A) + Nx-alias attempted fix (Defect B 3.2.A) | Engineering Lead/Architect |
| PR-M0R-1 Directive Amendment v1.3 | Replaced v1.2 §3.2 with Fix Option B (narrow eslint allow rule) — Defect B structurally requires app-boundary exception | Engineering Lead/Architect |
| PR-M0R-2 Directive Amendment v1.0 | Vocabulary fixes (§3) + Policy 1 doc-path allowlist (§4) | Engineering Lead + PO (Policy 1 ratification) |
| PR-M0R-2 Directive Amendment v1.1 | §4.5 refusal-enforcement-script allowlist (structural-design-need scope) | Engineering Lead + PO (Policy 1 ratification) |

Each amendment was filed at canonical OneDrive location, byte-verified,
read by Gate 5 substrate-grounded. The pattern this establishes — when
substrate detects a defect in a directive, a standalone amendment
artifact corrects it, not a re-issue of the parent plan — is now
program convention.

# 5. Outstanding M7 Follow-Ups

Items deferred from the M0 cycle to M7 (Hardening + Phase 6 Closure):

- **F1 — `tsconfig.base.json` TS 6.0 `baseUrl` cleanup** (PR-M0R-1 Amendment v1.1 §4 + v1.2 §3.2 follow-up).
- **F2 — `openapi/common.yaml` exception allowlist for refusal-check scripts** (PR-M0R-2 Amendment v1.1 §4 — so `portal:refusal-check` / `ats:refusal-check` can scan `common.yaml` without false positives on legitimate `additionalProperties: true` schemas).
- **F3 — Pact verifier request-filter for per-interaction cookie injection** (PR-M0R-1 Amendment v1.1 §4 — enables nominal-success Pact interactions for `/refresh` and `/session`).
- **F4 — `libs/auth-storage` `RefreshTokenService` test-seed helpers** for nominal-path refresh-token Pact interactions (pairs with F3).
- **F5 — Pact `followRedirects: false` config** for `GET /auth/{consumer}/login` 302 nominal verification.
- **Authentication production hardening.** Migrate `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` from environment variables to AWS Secrets Manager with quarterly rotation cadence per Architecture v2.1 §12.2 "Signing keys posture." Plan v1.2 §3 M7 Track A names this as a M7 deliverable with "must complete before production launch. Not deferrable past M7."
- **Full-coverage refusal enforcement.** Five of the refusal/drift scripts currently exit 0 trivially against `paths: {}` stubs for ATS / Portal / Ingestion. Enforcement coverage grows as M2–M6 populate those schemas; full coverage target M7.

# 6. Going-Forward Commitments

Codified during the M0 cycle and intended to persist across future
milestones.

## 6.1 Gate 1 substrate-check addition (Plan v1.2 §8)

Every Gate 1 substrate verification from this point forward explicitly
checks: *"Is this work named in the current (amended) Delivery Plan and
consistent with Architecture v2.1 §1.1 deployable list?"* This is the
prophylactic against future R-DRIFT-class scope-vs-plan drift,
ratified under R-DRIFT-1 closure and exercised through M0R-1, M0R-2,
M0R-3.

## 6.2 Strengthened acceptance — every CI job (not just directive-named)

PR-M0R-1 Amendment v1.2 §4 (carried forward through M0R-2 v1.0 §5 and
M0R-3 directive §8) establishes the discipline: every CI job in
`.github/workflows/ci.yml` must pass at Gate 5 acceptance, not only
the directive-named gates. The post-M0R-1 v1 CI surprise (lint /
lint:nx-boundaries / pact:provider all failing on a "directive-only"
verification) was the substrate-detected event that motivated this
discipline.

## 6.3 Policy 1 — Charter quotations in program documentation

PO-ratified May 15, 2026. The `verify:vocabulary` script's allowlists
permit legitimate Charter quotations at named documentation paths:
`doc/milestone-signoffs/*.md`, `doc/00-ci-deliberate-failure-evidence.md`,
`doc/adr/*.md`, `Aramo-*-LOCKED.docx` / `Aramo-*-Closure-Record-*.docx`.
Extended in M0R-2 Amendment v1.1 §4.5 to include refusal-enforcement
scripts that legitimately contain the terms they enforce against.

## 6.4 Amendment-not-re-issue convention

When substrate verification detects a defect in a directive at Gate 5,
the correction is filed as a standalone amendment artifact at canonical
(not as a re-issue of the parent plan). Each amendment carries:
(a) substrate basis citing the prior pass + the specific defect,
(b) ratification authority (engineering Lead for technical
interpretation; PO for substantive scope), (c) explicit relationship to
prior versions ("supersedes" / "carries forward"). M0 produced six
such amendments; the pattern is mature.

## 6.5 Option β Gate 6 automation

Gate 6 v2 (PR-M0R-1 + PR-M0R-2 post-fix push cycle) demonstrated the
"Lead-drafted commit messages, agent executes verbatim" pattern. The
agent commits + pushes + watches CI but authors no substrate text. This
reduces Gate 6 wall-clock latency without diluting authorship
attribution.

## 6.6 Deliberate-drift CI evidence convention

Each milestone or major remediation cycle records its deliberate-failure
CI test in `doc/00-ci-deliberate-failure-evidence.md` (or successor
file) with the failing-run URL, the inject commit hash, and the revert
commit hash. Substrate trail outlives ephemeral CI logs.

# 7. Closing

M0 — Foundation + Contract Bootstrapping, expanded under R-DRIFT-1
closure to include WS9 Authentication & Identity — formally closes
upon PO ratification of this Closure Record.

The 7 of 7 §6 DoD criteria PASS. The 13 Charter refusals are
substrate-verified for integrity in M0 scope. Five M0R cycle
amendments have moved the program forward without disturbing the
locked Charter v1.0. The CI machinery for refusal enforcement,
drift detection, contract verification, and deployment-gating is
operational and demonstrated.

PR-M0R-3 merges, this Closure Record is filed at canonical, PO
ratifies, and M0 closes. M1 (Consent + Talent Core Operational —
already substantially complete via the consent module shipped in M0
window) becomes the next substantive milestone in the Phase 1
Delivery Plan v1.2 §3 sequence.

# 8. PO Ratification

I, the Product Owner, ratify M0 closure per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). The
7-of-7 §6 DoD status table reflects substrate truth; the refusal layer
integrity record at `doc/milestone-signoffs/M0-refusal-signoff.md` is
complete and substrate-anchored; the outstanding M7 follow-ups are
explicitly named with milestone hooks.

M0 is closed.

— Product Owner
— [Date of ratification]

*End of M0 Closure Record v1.0*

*Drafted under engineering Lead/Architect authority; ratified by
Product Owner per operating-rule recalibration of 2026-05-15.*
