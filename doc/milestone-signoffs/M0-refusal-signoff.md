# Aramo Milestone Sign-Off — M0

**Milestone:** M0 — Foundation + Contract Bootstrapping (+ WS9 Authentication & Identity, retroactively ratified per R-DRIFT-1 closure)
**Closure date:** 2026-05-16
**Signed by:** Engineering Lead/Architect (orchestration session, Gate 5 of PR-M0R-3 execution)
**Ratified by (PO):** [signature block — to be filled in by Product Owner at M0 closure]

Per Plan v1.2 §6 DoD criterion #7 ("Refusal layer integrity verified
explicitly — Lead Engineer signs off on refusal preservation"). This
document is the per-M0 substrate-readable record satisfying that
criterion. Refusal text is **verbatim** from Charter v1.0 §8 at canonical
OneDrive location (`Aramo-Charter-v1.0-LOCKED.docx`); per-refusal
evaluation against M0 scope follows.

The Policy 1 allowlist (PR-M0R-2 Amendment v1.0 §4.2, PO-ratified
2026-05-15) covers `doc/milestone-signoffs/*.md`, so legitimate Charter
quotations in this document are permitted by `verify:vocabulary`.

## §6 DoD Status

| Criterion | Status | Evidence |
|---|---|---|
| #1 APIs implemented per OpenAPI specification | PASS | M0 endpoint surface: 6 auth endpoints in `openapi/auth.yaml:33,82,167,226,271,326` mapped to `apps/auth-service/src/app/auth/auth.controller.ts:136/179/243/283/314` + `jwks.controller.ts:12`; 6 consent endpoints in `openapi/common.yaml:33,108,189,304,393,516` mapped to `libs/consent/src/lib/consent.controller.ts`. |
| #2 OpenAPI valid (swagger-cli + redocly lint) | PASS | `npm run openapi:validate` → all 5 YAML files valid, exit 0; `npm run openapi:lint` → 0 errors (warnings only); both wired as CI jobs at `.github/workflows/ci.yml`. |
| #3 Pact consumer tests exist for every endpoint added | PASS (via PR-M0R-1) | `npm run pact:consumer` → 23 ats-thin (consent) + 6 auth-service-consumer (auth) = 29 tests pass. Files: `pact/consumers/ats-thin/src/consent.consumer.test.ts`, `pact/consumers/auth-service-consumer/src/auth.consumer.test.ts`. |
| #4 Provider verification passes against Aramo Core test environment | PASS (via PR-M0R-1) | `npm run pact:provider` → 6/6 auth-service interactions verify end-to-end against running `apps/auth-service`. Pact-provider CI job runs `npm ci → prisma:generate → npm run pact:consumer → npm run pact:provider` per PR-M0R-1 Amendment v1.2 §3.1. |
| #5 Refusal scripts pass (verify-portal-refusal.ts, verify-ats-refusal.ts, others as applicable) | PASS (via PR-M0R-2) | 6 of 6 refusal/drift gates exit 0: `openapi:drift-check`, `portal:refusal-check`, `ats:refusal-check`, `version:sync-check`, `error-codes:check`, `verify:vocabulary`. Scripts at `ci/scripts/`. Deliberate-failure CI test demonstrated portal:refusal-check exit-1 on injected `internal_reasoning` field at commit `51d1ae0` (CI run https://github.com/astreinc/aramo-platform/actions/runs/25919007604), then reverted. |
| #6 CI blocks invalid deployments (deployment-gate.yml enforcing all checks) | PASS (via PR-M0R-3) | `.github/workflows/ci.yml` `deployment-gate` aggregator job wires all 12 named Plan v1.2 §4 Stage 4 gates as `needs:` dependencies (VARIANT B per PR-M0R-3 directive §4.1 — cross-workflow `needs:` is not supported in GitHub Actions; aggregator-in-ci.yml is the authorized fallback). Override-label discipline per directive §4.2 in same job. Pending GitHub branch-protection wiring of `deployment-gate` as required status check (admin-side, post-merge). |
| #7 Refusal layer integrity verified explicitly (Lead Engineer signs off on refusal preservation) | PASS (via PR-M0R-3) | This document. All 13 Charter refusals enumerated below with substrate-anchored at-risk + enforcement + evidence fields. PO ratification block at bottom. |

## Refusal Layer Integrity

The 13 Charter v1.0 refusal commitments are enumerated below. Refusal
text quoted verbatim from `Aramo-Charter-v1.0-LOCKED.docx §8` (canonical
OneDrive location). Refusal numbering follows the program's R1–R13
linear convention (Charter §8 grouping: Scope R1–R3, Behavior R4–R10,
Posture R11–R13).

M0 scope (per PR-M0R-3 directive §4.4): 6 auth endpoints in
`apps/auth-service`, 6 consent endpoints in `apps/api` (consumed
through `libs/consent`), `libs/identity`, `libs/auth-storage`,
`libs/consent`, `libs/auth`.

### Refusal R1 — *Will not function as a job marketplace or job board.*
- At risk in M0? **No**
- Enforcement mechanism: **API absence**. M0 ships only auth + consent surfaces; no `/v1/jobs/*`, no `/portal/jobs/*`, no listing/search/feed endpoints exist in `openapi/common.yaml`, `openapi/auth.yaml`, or any other spec on this branch.
- Substrate evidence: `grep -rEn "^\s*/v1/jobs" openapi/` returns no matches; `openapi/ats.yaml`, `openapi/portal.yaml`, `openapi/ingestion.yaml` are all `paths: {}` stubs.
- Re-evaluated in M3 when match-list endpoints (`GET /v1/jobs/{job_id}/matches`) land in `openapi/ats.yaml`.

### Refusal R2 — *Will not act as a sourcing engine as its primary function.*
- At risk in M0? **No**
- Enforcement mechanism: **API absence**. M0 has no free-form Talent search, no bulk export, no `/v1/talents/*` endpoints.
- Substrate evidence: `grep -rEn "^\s*/v1/talents" openapi/` returns no matches.
- Re-evaluated in M3/M4 when the Constrained Talent Access group (`GET /v1/talents/{talent_id}`, `GET /v1/jobs/{job_id}/manual-add-search`) lands in `openapi/ats.yaml` — both are intentionally constrained per API Contracts v1.0 Phase 2.

### Refusal R3 — *Will not provide candidate-facing job discovery or feeds.*
- At risk in M0? **No**
- Enforcement mechanism: **API absence**. M0 has no Portal endpoints whatsoever. `openapi/portal.yaml` is `paths: {}`.
- Substrate evidence: `cat openapi/portal.yaml` shows only the PR-1 scaffold with `paths: {}` and `components.schemas: {}`.
- Re-evaluated in M6 (Talent Portal). Future Portal endpoints will be subject to `ci/scripts/verify-portal-refusal.ts` which enforces forbidden-field exclusion + `additionalProperties: false` discipline.

### Refusal R4 — *Will not infer consent from behavior.*
- At risk in M0? **Yes** — `libs/consent` ships the runtime consent computation in M0.
- Enforcement mechanism: **Code path constraint**. `libs/consent/src/lib/consent.repository.ts` reads exclusively from the `TalentConsentEvent` append-only ledger (Prisma schema at `libs/consent/prisma/schema.prisma`). No behavioral inference path exists. `libs/consent/src/lib/consent.service.ts` derives state by reducing over events; no analytics or session-state input.
- Substrate evidence: `grep -rEn "behavior|infer|implicit" libs/consent/src/lib/` returns zero matches against consent-resolution code. The repository's only read path is `findEventsByTalent` against the consent ledger. Nx module-boundary rule + `libs/consent` schema-per-module isolation (per ADR-0001 D3 + Architecture v2.0 §7.1) prevents consent computation outside the Consent module.

### Refusal R5 — *Will not widen consent through aggregation.*
- At risk in M0? **Yes** — `libs/consent` computes per-tenant per-scope consent state.
- Enforcement mechanism: **Code path + contract**. `libs/consent/src/lib/consent.service.ts` resolves consent per `(tenant_id, talent_id, scope)` triple; no cross-tenant aggregation widens consent. The `GET /consent/state/{talent_id}` response shape returns explicit per-scope state with no merge across tenants (Group 2 §2.7 most-restrictive-wins).
- Substrate evidence: Pact test `pact/consumers/ats-thin/src/consent.consumer.test.ts:729-806` ("mixed states — granted + revoked + no_grant") asserts per-scope states are preserved independently; the response shape carries 5 distinct scope entries without aggregation.

### Refusal R6 — *Will not act on stale consent for high-impact actions.*
- At risk in M0? **Yes** — `libs/consent` ships the stale-consent logic in M0.
- Enforcement mechanism: **Runtime check at consent resolver**. `libs/consent/src/lib/consent.service.ts` applies the 12-month staleness threshold (Group 2 §2.7) to contacting-scope requests. Stale consent returns `result: denied` with `reason_code: stale_consent`.
- Substrate evidence: Pact test `pact/consumers/ats-thin/src/consent.consumer.test.ts:429-477` ("returns 200 denied with reason=stale_consent for an old contacting grant") asserts the exact denial shape including `reason_code: 'stale_consent'`.

### Refusal R7 — *Will not perform automated LinkedIn scraping.*
- At risk in M0? **No** — M0 has no ingestion endpoints or adapters.
- Enforcement mechanism: **API absence + repo-wide CI vocabulary gate + future schema-layer constraints**. (a) No `/v1/ingestion/*` endpoints exist (`openapi/ingestion.yaml` is `paths: {}`); (b) `scripts/verify-vocabulary.sh` Tier 1 R7 gate scans the entire repo for the literal `linkedin` and rejects unallowlisted occurrences; (c) future ingestion adapters will face `AdapterType`/`SourceType` closed enums + `linkedin_automation_allowed: const: false` schema constraints per API Contracts v1.0 Phase 4 four-layer refusal.
- Substrate evidence: `scripts/verify-vocabulary.sh` R7_ALLOWLIST + R7_ALLOWLIST_GLOB enforced as CI job `verify-vocabulary` at `.github/workflows/ci.yml:124-131`; gate currently green at HEAD `99aacd5` (`bash scripts/verify-vocabulary.sh` → exit 0).
- Re-evaluated in M2 when Indeed + GitHub + Astre Import + Candidate-Direct adapter endpoints land.

### Refusal R8 — *Will not allow recruiter judgment to override system classification.*
- At risk in M0? **No** — M0 has no examination, no override endpoints.
- Enforcement mechanism: **API absence + future schema-layer constraint**. (a) No `/v1/examinations/*/overrides` endpoint in `openapi/ats.yaml` (which is `paths: {}`); (b) `ci/scripts/verify-ats-refusal.ts` enforces `override_*` prefix exclusion on Portal-facing schemas and the `examination_mutated: const: false` invariant on any override response schema.
- Substrate evidence: `npm run ats:refusal-check` → exit 0 against current ATS stub; script content at `ci/scripts/verify-ats-refusal.ts:11-17` documents the `examination_mutated` invariant.
- Re-evaluated in M3 (Examination) + M4 (Overrides endpoint group).

### Refusal R9 — *Will not permit submission of Stretch-tier candidates.*
- At risk in M0? **No** — M0 has no submittal, no entrustability classification.
- Enforcement mechanism: **API absence + future error-code-based block**. No `/v1/submittals/*` endpoints exist. Future enforcement at submittal-create + submittal-confirm via the `SUBMITTAL_STRETCH_BLOCKED` error code (Phase 5 registry, currently not in the 9-code subset shipped at `libs/common/src/lib/errors/error-codes.ts`).
- Substrate evidence: `grep -rEn "SUBMITTAL_STRETCH_BLOCKED" libs/ apps/ openapi/` returns no matches — the code path doesn't exist yet because the endpoint doesn't exist.
- Re-evaluated in M4 (Entrustability + Evidence Package).

### Refusal R10 — *Will not expose internal reasoning or evaluation outputs.*
- At risk in M0? **No (in M0 code paths)** — M0 has no Portal endpoints. The CI machinery enforcing R10 is, however, active at M0 closure and was operationally demonstrated.
- Enforcement mechanism: **CI script with forbidden-field exclusion**. `ci/scripts/verify-portal-refusal.ts` enforces exact-match exclusion of `internal_reasoning`, `entrustability_tier_raw`, prefix exclusion of `override_*` and `recruiter_*`, and universal `additionalProperties: false` on Portal schemas. Wired as CI job `portal-refusal-check` at `.github/workflows/ci.yml`.
- Substrate evidence: **Deliberate-failure CI test** — commit `51d1ae0` (`DELIBERATE-DRIFT (will revert): inject internal_reasoning field into portal.yaml`) injected `DriftEvidenceMatchExplanation.properties.internal_reasoning` into `openapi/portal.yaml`; CI run https://github.com/astreinc/aramo-platform/actions/runs/25919007604 produced `portal:refusal-check FAILED — 1 violation(s): components.schemas.DriftEvidenceMatchExplanation.properties.internal_reasoning: exact-match forbidden field: internal_reasoning` (exit 1). Drift then reverted in M0R-2 v2 (commit `3c1b9fd`); current `npm run portal:refusal-check` → exit 0. Full evidence in `doc/00-ci-deliberate-failure-evidence.md`.
- Re-evaluated in M6 when Portal endpoints actually populate `openapi/portal.yaml`.

### Refusal R11 — *Will not optimize engagement metrics over consent integrity.*
- At risk in M0? **No** — M0 has no engagement endpoints, no outreach surfaces.
- Enforcement mechanism: **API absence**. No `/v1/engagements/*`, no message-send endpoints exist. Future enforcement via mandatory consent-check pattern at every engagement transition + message-send time (Architecture v2.0 §13.3 + Plan v1.2 M5 Track B "Consent enforcement at message send time").
- Substrate evidence: `grep -rEn "^\s*/v1/engagements" openapi/` returns no matches; `libs/engagement/src/lib/engagement.module.ts` is the empty module scaffold.
- Re-evaluated in M5 (Engagement + Submittal Flow).

### Refusal R12 — *Will not replace recruiter judgment with system autonomy.*
- At risk in M0? **No** — M0 has no submittal-confirm path, no automatic submission.
- Enforcement mechanism: **API absence + future schema-layer attestation constraints**. No `/v1/submittals/{submittal_id}/confirm` endpoint exists. Future enforcement at the `RecruiterAttestations` schema with all three attestation fields (`candidate_evidence_reviewed`, `constraints_reviewed`, `submission_risk_acknowledged`) declared `const: true` per API Contracts v1.0 Phase 2 — preventing OpenAPI validation from accepting an auto-confirmed submittal.
- Substrate evidence: `grep -rEn "submission_risk_acknowledged" openapi/ libs/ apps/` returns no matches — the schema doesn't exist yet because the endpoint doesn't exist.
- Re-evaluated in M4 + M5 (Submittal pipeline).

### Refusal R13 — *Will not compromise consent integrity for engagement velocity.*
- At risk in M0? **No (in M0 code paths)** — M0 has no engagement; nothing to compromise consent integrity *for* yet. The architectural precedent that enables R13 — consent-first sequencing — is, however, established in M0.
- Enforcement mechanism: **Architectural sequencing (Plan v1.2 §1.2 Consent-First System Behavior)** + **future runtime checks at engagement transitions**. Consent module is built before any dependent workflow (ingestion, matching, engagement); no engagement code can land without a consent check, by sequencing discipline. Future enforcement at engagement state transitions per Architecture v2.0 §13.3.
- Substrate evidence: `libs/consent` exists and is operational in M0 (`libs/consent/src/lib/consent.service.ts`); `libs/engagement` is an empty scaffold (`libs/engagement/src/lib/engagement.module.ts`) — sequencing intact. Plan v1.2 §1.2: *"The Consent module is built before any dependent workflow. No code path that touches a Talent may exist without consent enforcement at runtime."*
- Re-evaluated in M5 (Engagement) when the first dependent workflow lands.

### Refusal layer summary

| Group | Refusals | At-risk in M0 | Not-at-risk in M0 |
|---|---|---|---|
| Scope (R1–R3) | 3 | 0 | R1, R2, R3 |
| Behavior (R4–R10) | 7 | R4, R5, R6 (consent-related) | R7, R8, R9, R10 |
| Posture (R11–R13) | 3 | 0 (in M0 code paths) | R11, R12, R13 |
| **Total** | **13** | **3** | **10** |

All 3 at-risk refusals (R4, R5, R6) have substrate-anchored enforcement
mechanisms and substrate-anchored evidence (pact tests + code paths).
All 10 not-at-risk refusals have explicit rationale (API absence) plus
forward enforcement plans (CI scripts pre-staged, target milestone
named).

## Outstanding Items

Forward references to follow-ups identified during M0R-1 + M0R-2
amendments. Each item has an explicit milestone hook.

- **F1 — `tsconfig.base.json` TS 6.0 `baseUrl` cleanup.** Identified in PR-M0R-1 Amendment v1.1 §4 + v1.2 §3.2 follow-up. Target: M7 (hardening).
- **F2 — `openapi/common.yaml` exception allowlist for refusal-check scripts.** So `portal:refusal-check` / `ats:refusal-check` can scan `common.yaml` without false positives on legitimate `additionalProperties: true` schemas (`ErrorObject.details`, `Consent*.metadata`, `ConsentDecisionLogEntry.event_payload`). Target: M7 (full-coverage refusal enforcement).
- **F3 — Pact verifier request-filter for per-interaction cookie injection.** Enables nominal-success Pact interactions for `/refresh` and `/session` (currently only error-case coverage). Target: M7.
- **F4 — `libs/auth-storage` `RefreshTokenService` test-seed helpers** for nominal-path refresh-token Pact interactions. Pairs with F3. Target: M7.
- **F5 — Pact `followRedirects: false` config** for `GET /auth/{consumer}/login` 302 nominal verification (currently the 302 interaction is deferred because the Pact verifier follows the cross-origin Cognito redirect). Target: M7.
- **Authentication production hardening.** Migrate `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` from environment variables to AWS Secrets Manager with quarterly key rotation cadence per Architecture v2.1 §12.2 "Signing keys posture". Target: **M7 Track A** (Plan v1.2 §3 M7 — "Authentication production hardening… must complete before production launch. Not deferrable past M7.")
- **Full-coverage refusal enforcement.** Five of the 12 deployment-gate refusal/drift scripts (`openapi:drift-check`, `portal:refusal-check`, `ats:refusal-check`, `version:sync-check`, `error-codes:check`) currently exit 0 trivially against `paths: {}` stubs for ATS / Portal / Ingestion. Enforcement coverage grows as M2–M6 populate those schemas. Target: ongoing through M2–M6, full coverage by M7.

## Sign-off

I, the Engineering Lead/Architect (orchestration session, executing
Gate 5 of PR-M0R-3 per the M0 Remediation Plan v1.0 §4 and the PR-M0R-3
Directive v1.0), sign off on the refusal layer integrity for M0 per
Plan v1.2 §6 DoD criterion #7.

All 13 Charter v1.0 refusal commitments have been evaluated against the
M0 milestone's scope. The 3 at-risk refusals (R4, R5, R6) have
substrate-verified enforcement mechanisms with specific code-path and
Pact-test evidence cited above. The 10 not-at-risk refusals each carry
explicit rationale (API absence) plus a forward-enforcement plan (CI
script pre-staged, target milestone named).

The refusal layer is intact at M0 closure.

— Engineering Lead/Architect (orchestration session)
— 2026-05-16

## PO Ratification

I, the Product Owner, ratify M0 closure per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). The
DoD status table reflects substrate truth; the refusal layer integrity
section is complete and substrate-anchored.

[Signature block — to be filled in by PO at M0 closure]
[Date]
