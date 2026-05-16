# Aramo Milestone Sign-Off — M1

**Milestone:** M1 — Consent + Talent Core Operational
**Closure date:** 2026-05-16
**Signed by:** Engineering Lead/Architect (orchestration session, executing Gate 5 of PR-11)
**Ratified by (PO):** [signature block — to be filled in by Product Owner at M1 closure]

Per Plan v1.2 §6 DoD criterion #7 ("Refusal layer integrity verified
explicitly — Lead Engineer signs off on refusal preservation"). This
document is the per-M1 substrate-readable record satisfying that
criterion. Refusal text is **verbatim** from Charter v1.0 §8 at canonical
OneDrive location (`Aramo-Charter-v1.0-LOCKED.docx`); per-refusal
evaluation against M1 scope follows.

The Policy 1 allowlist (PR-M0R-2 Amendment v1.0 §4.2, PO-ratified
2026-05-15) covers `doc/milestone-signoffs/*.md`, so legitimate Charter
quotations in this document are permitted by `verify:vocabulary`.

## §6 DoD Status

| Criterion | Status | Evidence |
|---|---|---|
| #1 APIs implemented per OpenAPI specification | PASS | M1 endpoint surface (consent ledger + resolver + 6 consent endpoints) lives in `openapi/common.yaml` `/consent/grant`, `/consent/revoke`, `/consent/check`, `/consent/state/{talent_id}`, `/consent/history/{talent_id}`, `/consent/decision-log/{talent_id}`, mapped to `libs/consent/src/lib/consent.controller.ts` (`@Post('grant')`, `@Post('revoke')`, `@Post('check')`, `@Get('state/:talent_id')`, `@Get('history/:talent_id')`, `@Get('decision-log/:talent_id')`). Talent core data model in `libs/talent/prisma/schema.prisma` per PR-10. |
| #2 OpenAPI valid (swagger-cli + redocly lint) | PASS | `npm run openapi:validate` → all 5 YAML files valid, exit 0; `npm run openapi:lint` → 0 errors. Wired as CI jobs `openapi-validate` and `openapi-lint`; green on main run `25958707073` (HEAD `c8a6bad`). |
| #3 Pact consumer tests exist for every endpoint added | PASS | `pact/consumers/ats-thin/src/consent.consumer.test.ts` — 46 interactions covering grant/revoke/check/state/history/decision-log; `pact/consumers/tenant-console-consumer/src/consent.consumer.test.ts` — state/history/decision-log interactions for the recruiter-side reads (PR-9). `npm run pact:consumer` green on main run `25958707073`. |
| #4 Provider verification passes against Aramo Core test environment | PASS | `npm run pact:provider` green on main run `25958707073`; ats-thin consumer's 46 consent interactions verified end-to-end. F7 (extend provider verifier to cover tenant-console-consumer interactions) is a registered follow-up pinned to early M2 per PO decision 2026-05-16; F7 does not block criterion #4 — the criterion as written passes on the current provider surface. |
| #5 Refusal scripts pass (verify-portal-refusal.ts, verify-ats-refusal.ts, others as applicable) | PASS | 6 of 6 refusal/drift gates exit 0 on main run `25958707073`: `openapi:drift-check`, `portal:refusal-check`, `ats:refusal-check`, `version:sync-check`, `error-codes:check`, `verify:vocabulary`. Scripts at `ci/scripts/` and `scripts/verify-vocabulary.sh`. |
| #6 CI blocks invalid deployments (deployment-gate.yml enforcing all checks) | PASS | `.github/workflows/ci.yml` `deployment-gate` aggregator job wires the 12 named gates as `needs:` dependencies (VARIANT B per PR-M0R-3 §4.1). Green on main run `25958707073`. The PR-10 cycle demonstrated the aggregator catching a substantive failure pre-merge (build/test:unit red on commit `e559dec`; fix-up `94375a8` landed green before merge). §9.1 branch-protection wiring of `deployment-gate` as a required status check remains Lead-deferred and is a standing item for PO ratification. |
| #7 Refusal layer integrity verified explicitly (Lead Engineer signs off on refusal preservation) | PASS | **This document.** All 13 Charter refusals enumerated below with substrate-anchored at-risk + enforcement + evidence fields. PO ratification block at bottom. |

## Refusal Layer Integrity

The 13 Charter v1.0 refusal commitments are enumerated below. Refusal
text quoted verbatim from `Aramo-Charter-v1.0-LOCKED.docx §8` (canonical
OneDrive location). Refusal numbering follows the program's R1–R13
linear convention (Charter §8 grouping: Scope R1–R3, Behavior R4–R10,
Posture R11–R13).

M1 scope (per PR-11 directive §4.3): consent runtime computation
(shipped under M0 retroactive scope; operational in M1); PR-8 Tenant
Console Foundation; PR-9 Consent Visibility Panels (recruiter-facing
reads); PR-10 Talent core entity + TalentTenantOverlay (data model).
M1 adds no ingestion, no examination, no submittal, no engagement
surfaces.

### Refusal R1 — *Will not function as a job marketplace or job board.*
- At risk in M1? **No**
- Enforcement mechanism: **API absence**. M1 ships no `/v1/jobs/*` endpoints, no listing/search/feed endpoints. The Talent core entity (PR-10) is a tenant-agnostic data model with no public endpoint surface in M1.
- Substrate evidence: `grep -rEn "^\s*/v1/jobs" openapi/` returns no matches; `openapi/ats.yaml`, `openapi/portal.yaml`, `openapi/ingestion.yaml` remain `paths: {}` stubs.
- Re-evaluated in M3 when match-list endpoints (`GET /v1/jobs/{job_id}/matches`) land in `openapi/ats.yaml`.

### Refusal R2 — *Will not act as a sourcing engine as its primary function.*
- At risk in M1? **No**
- Enforcement mechanism: **API absence**. M1 has no free-form Talent search, no bulk export, no `/v1/talents/*` endpoints. The Talent and TalentTenantOverlay models exist only as Prisma entities in `libs/talent`; no HTTP surface.
- Substrate evidence: `grep -rEn "^\s*/v1/talents" openapi/` returns no matches. PR-10 directive §5 explicitly scopes-out HTTP endpoints: *"No API endpoints — PR-10 adds no HTTP surface."*
- Re-evaluated in M3/M4 when the Constrained Talent Access group lands in `openapi/ats.yaml`.

### Refusal R3 — *Will not provide candidate-facing job discovery or feeds.*
- At risk in M1? **No**
- Enforcement mechanism: **API absence**. M1 has no Portal endpoints. `openapi/portal.yaml` is `paths: {}`. The Tenant Console (PR-8/PR-9) is recruiter-facing, not candidate-facing.
- Substrate evidence: `cat openapi/portal.yaml` shows only the PR-1 scaffold with `paths: {}`. PR-8 directive scopes the Tenant Console to recruiter login + consent visibility (PR-9), no candidate surface.
- Re-evaluated in M6 (Talent Portal).

### Refusal R4 — *Will not infer consent from behavior.*
- At risk in M1? **Yes** — `libs/consent` ships the runtime consent computation operational in M1.
- Enforcement mechanism: **Code path constraint**. `libs/consent/src/lib/consent.repository.ts` reads exclusively from the `TalentConsentEvent` append-only ledger; no behavioral inference path exists. `resolveConsentState` (line 396) and `resolveAllScopes` (the state endpoint) both reduce over explicit ledger events with `where: { tenant_id, talent_id }`, never over analytics/session data.
- Substrate evidence: `libs/consent/src/tests/consent.refusal-r4.spec.ts` (the R4 static guardrail) enforces the boundary; `grep -rEn "behavior|infer|implicit" libs/consent/src/lib/` returns zero matches against consent-resolution code. The new Group 2 v2.7 multi-tenant honest-visibility test (PR-11, `libs/consent/src/tests/consent.integration.spec.ts` describe `Group 2 v2.7 counterintuitive case — multi-tenant honest visibility`) is a tripwire for the per-tenant scoping that R4 depends on.

### Refusal R5 — *Will not widen consent through aggregation.*
- At risk in M1? **Yes** — `libs/consent` computes per-tenant per-scope consent state in M1.
- Enforcement mechanism: **Source-aware most-restrictive resolver (Decision D)**. `libs/consent/src/lib/consent.repository.ts` `resolveConsentState` derives per-source state then takes the most-restrictive across sources; resolves per `(tenant_id, talent_id, scope)` triple with `tenant_id` JWT-derived from `authContext` (`libs/consent/src/lib/consent.service.ts:33/58/90/112/140/174`); cross-tenant queries are structurally impossible at the service boundary.
- Substrate evidence: Pact test `pact/consumers/ats-thin/src/consent.consumer.test.ts:729-806` ("mixed states — granted + revoked + no_grant") asserts per-scope states are preserved without aggregation. The new Group 2 v2.7 multi-tenant honest-visibility test (PR-11) is the explicit tripwire for the doc/03-refusal-layer.md:132 case ("Talent grants in Tenant B but Tenant A remains restricted") — runs against the real resolver and asserts both `resolveAllScopes` and `resolveConsentState` honor the tenant where-clause. The existing intra-tenant counterintuitive case `resolver: Counterintuitive Example — Indeed-source revoke + signup grant → contacting denied` at `consent.integration.spec.ts:348` covers the source-aware most-restrictive enforcement within a single tenant.

### Refusal R6 — *Will not act on stale consent for high-impact actions.*
- At risk in M1? **Yes** — `libs/consent` ships the stale-consent logic operational in M1.
- Enforcement mechanism: **Runtime check at consent resolver**. `libs/consent/src/lib/consent.repository.ts:134` declares `STALENESS_WINDOW_MONTHS = 12`; the staleness gate at line 548 returns `result: denied` with `reason_code: 'stale_consent'` for stale contacting-scope requests. Per-tenant scoping (Group 2 v2.7) means a stale grant in Tenant B cannot mask a non-grant in Tenant A.
- Substrate evidence: `libs/consent/src/tests/consent.refusal-r6.spec.ts` (the R6 spec); Pact test `pact/consumers/ats-thin/src/consent.consumer.test.ts:429-477` ("returns 200 denied with reason=stale_consent for an old contacting grant"). The new Group 2 v2.7 test confirms the staleness window operates per-tenant.

### Refusal R7 — *Will not perform automated LinkedIn scraping.*
- At risk in M1? **No** — M1 has no ingestion endpoints or adapters.
- Enforcement mechanism: **API absence + repo-wide CI vocabulary gate**. No `/v1/ingestion/*` endpoints; `openapi/ingestion.yaml` remains `paths: {}`. `scripts/verify-vocabulary.sh` Tier 1 R7 gate scans the entire repo and rejects unallowlisted occurrences of the literal R7 token.
- Substrate evidence: `npm run verify:vocabulary` green on main run `25958707073`; R7 allowlist sealed at `scripts/verify-vocabulary.sh:33-43`.
- Re-evaluated in M2 when Indeed + GitHub + Astre Import + Candidate-Direct adapter endpoints land.

### Refusal R8 — *Will not allow recruiter judgment to override system classification.*
- At risk in M1? **No** — M1 has no examination, no override endpoints.
- Enforcement mechanism: **API absence + future schema-layer constraint**. No `/v1/examinations/*/overrides` endpoint; `openapi/ats.yaml` is `paths: {}`. `ci/scripts/verify-ats-refusal.ts` enforces `override_*` prefix exclusion on Portal-facing schemas and the `examination_mutated: const: false` invariant on any override response schema.
- Substrate evidence: `npm run ats:refusal-check` green on main run `25958707073`.
- Re-evaluated in M3 (Examination) + M4 (Overrides endpoint group).

### Refusal R9 — *Will not permit submission of Stretch-tier candidates.*
- At risk in M1? **No** — M1 has no submittal, no entrustability classification.
- Enforcement mechanism: **API absence + future error-code-based block**. No `/v1/submittals/*` endpoints exist. Future enforcement at submittal-create + submittal-confirm via the `SUBMITTAL_STRETCH_BLOCKED` error code (Phase 5 registry).
- Substrate evidence: `grep -rEn "SUBMITTAL_STRETCH_BLOCKED" libs/ apps/ openapi/` returns no matches — the code path doesn't exist yet because the endpoint doesn't exist.
- Re-evaluated in M4 (Entrustability + Evidence Package).

### Refusal R10 — *Will not expose internal reasoning or evaluation outputs.*
- At risk in M1? **Yes** — Tenant Console (PR-8/PR-9) is a recruiter UI surface where evaluation-output drift could accumulate; PR-10's Talent core data model carried one optional spec field that brushed R10 (deferred).
- Enforcement mechanism: **Three layers**. (1) `scripts/verify-vocabulary.sh` Tier 2 scans `apps/**` and `libs/**` for the locked anti-terms (`evaluation`, the R10 surface tokens) and rejects matches. (2) `ci/scripts/verify-portal-refusal.ts` enforces forbidden-field exclusion + `additionalProperties: false` on Portal schemas (the CI machinery is pre-staged for M6 Portal endpoints). (3) PR-10 deferral: the Talent Record Spec §2.2 optional overlay field `relationship_strength_score` was the one R10-adjacent surface in M1's data model; PO ruling 2026-05-16 deferred it as F8 to be built M3+ under a field rename that drops the R10 token, with a Talent Record Spec amendment, the vocabulary rule kept absolute (no `TIER2_EXCLUDES` carve-out for a product field).
- Substrate evidence: `npm run verify:vocabulary` green on main run `25958707073`; `grep -rn "relationship_strength" libs/ apps/` returns no matches (F8 deferral honored); `npm run portal:refusal-check` green on main run. Tenant Console PR-9 ships consent-visibility panels displaying consent state only — no evaluation surfaces.

### Refusal R11 — *Will not optimize engagement metrics over consent integrity.*
- At risk in M1? **No** — M1 has no engagement endpoints, no outreach surfaces.
- Enforcement mechanism: **API absence**. No `/v1/engagements/*`, no message-send endpoints. `libs/engagement` is an empty PR-1 scaffold. Future enforcement via mandatory consent-check pattern at every engagement transition + message-send time.
- Substrate evidence: `grep -rEn "^\s*/v1/engagements" openapi/` returns no matches; `libs/engagement/src/lib/engagement.module.ts` is the empty module scaffold.
- Re-evaluated in M5 (Engagement + Submittal Flow).

### Refusal R12 — *Will not replace recruiter judgment with system autonomy.*
- At risk in M1? **No** — M1 has no submittal-confirm path, no automatic submission. The Tenant Console (PR-8/PR-9) is recruiter-facing UI without autonomous-action paths.
- Enforcement mechanism: **API absence + future schema-layer attestation constraints**. No `/v1/submittals/{submittal_id}/confirm` endpoint exists. Future enforcement at the `RecruiterAttestations` schema with attestation fields declared `const: true` per API Contracts v1.0 Phase 2.
- Substrate evidence: `grep -rEn "submission_risk_acknowledged" openapi/ libs/ apps/` returns no matches.
- Re-evaluated in M4 + M5 (Submittal pipeline).

### Refusal R13 — *Will not compromise consent integrity for engagement velocity.*
- At risk in M1? **Yes** — `libs/consent` ships the runtime consent computation operational in M1. The consent-grant transaction is the load-bearing piece for R13: any partial write (ledger event, audit row, outbox row, idempotency row) must roll back atomically.
- Enforcement mechanism: **Transactional rollback + locked action vocabulary**. `libs/consent/src/lib/consent.repository.ts` wraps the grant/revoke transaction so failure of any write rolls back atomically (per ADR-0006 Implementation Precedent O). The consent ledger's action vocabulary is closed: `granted | revoked | expired` only; no values like `granted_pending_engagement` that would dilute integrity.
- Substrate evidence: `libs/consent/src/tests/consent.refusal-r13.spec.ts` (transactional rollback spec); `libs/consent/src/tests/consent.refusal-action-locked.spec.ts` (action vocabulary spec). The new Group 2 v2.7 test (PR-11) extends R13 protection by making per-tenant scoping a loud-failing tripwire — preventing engagement-velocity pressure from rationalizing a cross-tenant consent shortcut.

### Refusal layer summary

| Group | Refusals | At-risk in M1 | Not-at-risk in M1 |
|---|---|---|---|
| Scope (R1–R3) | 3 | 0 | R1, R2, R3 |
| Behavior (R4–R10) | 7 | R4, R5, R6, R10 | R7, R8, R9 |
| Posture (R11–R13) | 3 | R13 | R11, R12 |
| **Total** | **13** | **5** | **8** |

All 5 at-risk refusals (R4, R5, R6, R10, R13) have substrate-anchored
enforcement mechanisms and substrate-anchored evidence (spec tests,
code paths with file:line, Pact tests, the new Group 2 v2.7 tripwire).
All 8 not-at-risk refusals have explicit rationale (API absence) plus
forward enforcement plans (CI scripts pre-staged, target milestone
named).

## Outstanding Items

Items carried forward from M0 plus items added during the M1 cycle.
Each has an explicit milestone hook.

- **F1 — `tsconfig.base.json` TS 6.0 `baseUrl` cleanup.** Carried from M0. Target: M7 (hardening).
- **F2 — `openapi/common.yaml` exception allowlist for refusal-check scripts.** Carried from M0. Target: M7 (full-coverage refusal enforcement).
- **F3 — Pact verifier request-filter for per-interaction cookie injection.** Carried from M0. Target: M7.
- **F4 — `libs/auth-storage` `RefreshTokenService` test-seed helpers** for nominal-path refresh-token Pact interactions. Carried from M0. Pairs with F3. Target: M7.
- **F5 — Pact `followRedirects: false` config** for `GET /auth/{consumer}/login` 302 nominal verification. Carried from M0. Target: M7.
- **F7 — Extend the Pact provider verifier to cover the aramo-core consent endpoints against tenant-console-consumer's interactions.** Registered in PR-9 commit `bd15ac2`. PO decision 2026-05-16: pinned to early M2; not pulled into PR-11. Target: M2.
- **F8 — relationship_strength_score (deferred Talent Record Spec §2.2 overlay field).** Registered in PR-10 commit `e559dec`. PO ruling 2026-05-16: build M3+ under "Option A" — field rename dropping the R10 token, with a Talent Record Spec amendment, the vocabulary rule kept absolute (no `TIER2_EXCLUDES` carve-out for a product field). Target: M3+.
- **Authentication production hardening.** Migrate `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` from environment variables to AWS Secrets Manager with quarterly key rotation cadence per Architecture v2.1 §12.2 "Signing keys posture". Carried from M0. Target: **M7 Track A** ("must complete before production launch. Not deferrable past M7.").
- **Full-coverage refusal enforcement.** Five of the 12 deployment-gate refusal/drift scripts currently exit 0 trivially against `paths: {}` stubs for ATS / Portal / Ingestion. Enforcement coverage grows as M2–M6 populate those schemas. Target: ongoing through M2–M6, full coverage by M7.

## Sign-off

I, the Engineering Lead/Architect (orchestration session, executing
Gate 5 of PR-11 per the PR-11 Directive v1.0), sign off on the refusal
layer integrity for M1 per Plan v1.2 §6 DoD criterion #7.

All 13 Charter v1.0 refusal commitments have been evaluated against the
M1 milestone's scope. The 5 at-risk refusals (R4, R5, R6, R10, R13)
have substrate-verified enforcement mechanisms with specific code-path,
spec-test, Pact-test, and CI-script evidence cited above. The 8
not-at-risk refusals each carry explicit rationale (API absence) plus
a forward-enforcement plan (CI script pre-staged, target milestone
named). The new Group 2 v2.7 multi-tenant honest-visibility test
(`libs/consent/src/tests/consent.integration.spec.ts` describe
`Group 2 v2.7 counterintuitive case — multi-tenant honest visibility`)
is a permanent tripwire for the R4/R5/R6 honest-visibility posture
named in Plan v1.2 §3 M1 exit criterion 3.

The refusal layer is intact at M1 closure.

— Engineering Lead/Architect (orchestration session)
— 2026-05-16

## PO Ratification

I, the Product Owner, ratify M1 closure per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). The
DoD status table reflects substrate truth; the refusal layer integrity
section is complete and substrate-anchored.

[Signature block — to be filled in by PO at M1 closure]
[Date]
