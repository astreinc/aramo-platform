*Aramo M1 Closure Record — DRAFT (pending PO ratification)*

**ARAMO**

*Talent Intelligence and Entrustment Platform*

**M1 Closure Record**

*Closure of Milestone M1 — Consent + Talent Core Operational*

**VERSION 1.0 — DRAFT (pending PO ratification)**

Classification: Internal — Aramo Program

May 16, 2026

> **Note on status.** This file is the markdown working draft produced
> by Gate 5 of PR-11. Post-merge, the orchestration session converts
> this to `.docx`; the Business Analyst files it at the canonical
> OneDrive location as `Aramo-M1-Closure-Record-v1_0-LOCKED.docx`. The
> Product Owner ratifies via the §9 block at the bottom; the closure
> formally takes effect upon PO signature.

# Document Control

## Purpose

This document is the filed substrate artifact for the M1 milestone
closure. It consolidates: (a) the M1 scope and what shipped, (b) the
post-PR-11 §6 DoD status, (c) the per-refusal layer integrity record
(by reference to `doc/milestone-signoffs/M1-refusal-signoff.md`), (d)
cross-cutting achievements of the M1 cycle, (e) outstanding follow-ups
carried forward, (f) going-forward commitments codified during M1
execution, and (g) standing items for PO ratification.

It exists because Plan v1.2 §6 DoD criterion #7 requires explicit
Lead-Engineer sign-off on refusal preservation, and criterion #6
requires CI to block invalid deployments via a deployment gate. This
closure record + the M1 refusal sign-off together constitute the
substrate trail those criteria call for.

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

- Plan v1.2 §3 M1 (Track A + Track B deliverables, exit criteria) +
  §6 DoD (7 criteria)
- M1 Closure Readiness Audit (orchestration session, May 16, 2026) —
  identified the two M1 readiness gaps that PR-11 closes
- PR-11 Directive v1.0 (this PR's authoring directive)
- `doc/milestone-signoffs/M1-refusal-signoff.md` (the §6 DoD #7
  sign-off, produced by PR-11)
- Post-PR-11-merge main HEAD (substrate state at which M1 closes)

## Relationship to other artifacts

- Aramo Charter v1.0 — LOCKED (unchanged by M1 closure)
- Aramo Architecture v2.0/v2.2 — LOCKED (M1 is consistent with §1.1 deployable list as amended under R-DRIFT-1)
- Aramo Phase 1 Delivery Plan v1.2 — LOCKED (M1 is the second milestone closing under v1.2)
- Aramo API Contracts v1.0 — Phases 1-6 LOCKED (M1 operates the Phase 1 consent surface implemented in M0)
- Aramo Talent Record Specification v1.0 — LOCKED (PR-10 implements §2.2 Talent + TalentTenantOverlay; F8 carries the deferred §2.2 overlay field)
- Aramo M0 Closure Record v1.0 — LOCKED (M0 is the predecessor closure; §6.7 transparency commitment is invoked in §7 of this record)

## Approver

| Role | Responsibility | Signature | Date |
|---|---|---|---|
| Product Owner | Sole ratifying authority for milestone closure per operating-rule recalibration | [to be filled in by PO] | [to be filled in by PO] |

# 1. Subject of Closure

## 1.1 What M1 is

M1 is the second milestone of the Aramo Phase 1 Delivery Plan. Per
Plan v1.2 §3 M1, the scope is:

**Track A — Platform Build:**
- Talent core entity + TalentTenantOverlay
- Consent ledger (TalentConsentEvent, append-only)
- Consent resolver (runtime computation from ledger)
- Consent API endpoints: `/consent/check`, `/consent/grant`, `/consent/revoke`, `/consent/state`, `/consent/history`
- Stale consent logic (12-month threshold per Group 2 v2.7)

**Track B — Contract Enforcement:**
- Pact tests for all five consent endpoints
- `verify-error-codes.ts` script integrated and enforcing UPPER_SNAKE_CASE
- Provider verification enabled in CI
- Consent denial responses verified to embed `ConsentDecision` in standard error envelope

**Exit Criteria (Plan v1.2 §3 M1):**
1. Consent enforced at runtime; stale consent blocks contacting
2. Pact tests must pass for all consent flows
3. Multi-tenant honest visibility verified (counterintuitive case from Group 2 v2.7)

## 1.2 What shipped in M1

The M1 deliverable surface was produced across four PRs:

### Consent runtime (M0 retroactive scope, operational in M1)
The consent ledger, resolver, and the six consent endpoints
(`/consent/grant`, `/consent/revoke`, `/consent/check`,
`/consent/state/{talent_id}`, `/consent/history/{talent_id}`,
`/consent/decision-log/{talent_id}`) were built in the M0 execution
window (PR-2 through PR-7). They operate the M1 consent runtime; the
M0 sign-off recorded R4/R5/R6 enforcement against them. M1 inherits
the operational consent module.

### PR-8 — Tenant Console Foundation (merge 076edfb, 2026-05-16)
Recruiter-facing React frontend under `apps/tenant-console`. Login
flow + auth integration. Foundation for PR-9 visibility panels.

### PR-9 — Consent Visibility Panels (merge 00ca5e8, 2026-05-16)
Recruiter-facing consent state / history / decision-log display
panels. Consumes the consent API. Pact consumer tests under
`pact/consumers/tenant-console-consumer`. Follow-up F7 registered for
provider-side verification of these interactions (pinned to early M2).
The panels display consent state only; R10 posture in the M1 paths is
recorded in the M1 refusal sign-off.

### PR-10 — Talent core entity + TalentTenantOverlay (merge c8a6bad, 2026-05-16)
Talent + TalentTenantOverlay as Prisma models in `libs/talent`.
Tenant-agnostic core (no `tenant_id` on Talent); per-tenant relationship
record in TalentTenantOverlay with `@@unique([talent_id, tenant_id])`
+ `@@index([tenant_id])`. PO ruling 2026-05-16 deferred the optional
Talent Record Spec §2.2 overlay field that brushed Charter R10 — tracked
as F8 for M3+ under Option A (field rename dropping the R10 token).
Fix-up commit 94375a8 wired `libs/talent/prisma/schema.prisma` into the
program-wide `prisma:generate` script — see §7.1 below.

### PR-11 — M1 Closure PR (this PR)
Three closure deliverables: (a) `doc/milestone-signoffs/M1-refusal-signoff.md`,
(b) the named Group 2 v2.7 multi-tenant honest-visibility test in
`libs/consent/src/tests/consent.integration.spec.ts`, (c) this closure
record draft. No product code changes.

## 1.3 Substrate baseline at M1 closure

Pre-PR-11 main HEAD: `c8a6badc3286a2db2ef8cf564765bc71bf65d1bd` (PR-10
merge). Main CI run `25958707073` — 18/18 jobs green. Post-PR-11-merge
HEAD will be the substrate state at which M1 closes.

# 2. M1 §6 DoD Status (7/7 PASS post-PR-11)

| Criterion | Status | Evidence |
|---|---|---|
| #1 APIs implemented per OpenAPI specification | PASS | Consent endpoint surface complete in `openapi/common.yaml` mapped to `libs/consent/src/lib/consent.controller.ts`. Talent core data model in `libs/talent/prisma/schema.prisma` (PR-10). |
| #2 OpenAPI valid (swagger-cli + redocly lint) | PASS | `openapi:validate` + `openapi:lint` green on main run `25958707073`. |
| #3 Pact consumer tests exist for every endpoint added | PASS | `pact/consumers/ats-thin/src/consent.consumer.test.ts` (46 interactions) + `pact/consumers/tenant-console-consumer/src/consent.consumer.test.ts` (recruiter-side reads). `pact:consumer` green on main. |
| #4 Provider verification passes against Aramo Core test environment | PASS | `pact:provider` green on main run `25958707073` (ats-thin interactions verified end-to-end). F7 registered for tenant-console-consumer coverage; pinned to early M2 (see §5 / §7.2). |
| #5 Refusal scripts pass | PASS | All refusal/drift gates exit 0 on main run `25958707073`. |
| #6 CI blocks invalid deployments | PASS | `.github/workflows/ci.yml` `deployment-gate` aggregator green on main. The PR-10 cycle (commit `e559dec` → fix-up `94375a8`) operationally demonstrated the aggregator catching a substantive failure pre-merge. §9.1 branch-protection wiring remains a standing item for PO ratification (§7.3). |
| #7 Refusal layer integrity verified explicitly | PASS | `doc/milestone-signoffs/M1-refusal-signoff.md` produced by PR-11. All 13 Charter refusals enumerated; 5 at-risk (R4, R5, R6, R10, R13) substrate-anchored; 8 not-at-risk with rationale + forward-pointer. |

**M1 exit criteria (Plan v1.2 §3 M1) — 3/3 MET post-PR-11:**

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Consent enforced at runtime; stale consent blocks contacting | MET | `libs/consent/src/lib/consent.repository.ts:136` `STALENESS_WINDOW_MONTHS = 12`; staleness gate at line 548 returns `result: denied`, `reason_code: 'stale_consent'`. R6 spec at `libs/consent/src/tests/consent.refusal-r6.spec.ts`. |
| 2 | Pact tests pass for all consent flows | MET | `pact:consumer` (34 interactions across 3 consumers) + `pact:provider` green on main run `25958707073`. |
| 3 | Multi-tenant honest visibility verified (counterintuitive case from Group 2 v2.7) | MET | Mechanical enforcement: `resolveConsentState` and `resolveAllScopes` both query with `where: { tenant_id, talent_id }` where `tenant_id` is JWT-derived from `authContext` (never body-supplied). Named tripwire: `libs/consent/src/tests/consent.integration.spec.ts` describe block `Group 2 v2.7 counterintuitive case — multi-tenant honest visibility` exercises both the state path (`resolveAllScopes`) and the check path (`resolveConsentState`), seeded with full grants in Tenant B + zero events in Tenant A for the same `talent_id`, asserting Tenant A returns `no_grant` / `consent_state_unknown` and Tenant B returns `granted` / `allowed`. Test PASSES — Charter R5 honest-visibility intact. |

# 3. Refusal Layer Integrity

Per Plan v1.2 §6 DoD criterion #7, the refusal-layer integrity record
for M1 is at `doc/milestone-signoffs/M1-refusal-signoff.md`. Summary:

| Group | Refusals | At-risk in M1 | Not-at-risk in M1 |
|---|---|---|---|
| Scope (R1–R3) | 3 | 0 | R1, R2, R3 |
| Behavior (R4–R10) | 7 | R4, R5, R6, R10 | R7, R8, R9 |
| Posture (R11–R13) | 3 | R13 | R11, R12 |
| **Total** | **13** | **5** | **8** |

The 5 at-risk refusals carry substrate-anchored enforcement and
evidence — spec tests, code paths with file:line, Pact tests, and the
new Group 2 v2.7 tripwire. The 8 not-at-risk refusals carry explicit
rationale (API absence) and forward-pointers to the milestone where
enforcement activates. Full text in the sign-off document.

# 4. Cross-Cutting M1 Achievements

## 4.1 Multi-tenant honest visibility — named tripwire installed
Plan v1.2 §3 M1 exit criterion 3 names "the counterintuitive case from
Group 2 v2.7" as the verification target. M1 closure converts this
from PARTIAL (mechanical enforcement only) to MET (mechanical + named
tripwire). The test in `libs/consent/src/tests/consent.integration.spec.ts`
is a permanent loud-failing safeguard against future regression in
the tenant-scoping discipline R4/R5/R6 depend on.

## 4.2 Tenant Console foundation operational
M1 ships the first recruiter-facing UI surface (`apps/tenant-console`).
PR-8 established the foundation; PR-9 added the consent-visibility
panels. The Tenant Console is recruiter-facing only (R3 not at risk),
and the visibility panels display consent state only; the R10 posture
in M1 paths is recorded in the M1 refusal sign-off.

## 4.3 Talent core data model — tenant-agnostic by construction
PR-10's separation of Talent (tenant-agnostic identity) from
TalentTenantOverlay (per-tenant relationship record) is the
multi-tenant honesty mechanism at the data layer. Verified four ways
(schema-spec, repository write-time assertion, service DTO shape,
migration CREATE TABLE inspection). The architecture choice carries
forward to M2 ingestion, M3 matching, M4 entrustability without
structural rework.

## 4.4 F7 / F8 follow-up discipline
Both M1 follow-ups (F7 Pact provider coverage of the
tenant-console-consumer interactions; F8 the deferred Talent Record
Spec §2.2 overlay field — Option A rename + build) were registered in
the originating PR's commit message and re-stated in the M1 sign-off
and this closure record. No silent deferrals. The exact identifier of
the F8 field is recorded in the M1 refusal sign-off under R10 (the
Policy-1-allowlisted path that legitimately carries Charter-adjacent
vocabulary).

# 5. Outstanding Follow-Ups

Carried into post-M1 milestones with explicit hooks:

- **F1** — `tsconfig.base.json` TS 6.0 `baseUrl` cleanup. **Target: M7.** Carried from M0.
- **F2** — `openapi/common.yaml` exception allowlist for refusal-check scripts. **Target: M7.** Carried from M0.
- **F3** — Pact verifier request-filter for per-interaction cookie injection. **Target: M7.** Carried from M0.
- **F4** — `libs/auth-storage` `RefreshTokenService` test-seed helpers (pairs with F3). **Target: M7.** Carried from M0.
- **F5** — Pact `followRedirects: false` config for `GET /auth/{consumer}/login` 302 nominal verification. **Target: M7.** Carried from M0.
- **F7** — Extend the Pact provider verifier to cover the aramo-core consent endpoints against tenant-console-consumer's interactions. Registered in PR-9 (commit `bd15ac2`). **Target: early M2** per PO decision 2026-05-16 (PR-11 directive §3 authority block). Standing item for PO ratification at §7.2.
- **F8** — Relationship-strength field deferred from Talent Record Spec §2.2. Registered in PR-10 (commit `e559dec`). **Target: M3+** under "Option A" — field rename that drops the R10 token, with a Talent Record Spec amendment; the vocabulary rule kept absolute (no `TIER2_EXCLUDES` carve-out for a product field).
- **Authentication production hardening (AUTH-HARD)** — Migrate `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` from environment variables to AWS Secrets Manager with quarterly key rotation cadence. **Target: M7 Track A** ("must complete before production launch. Not deferrable past M7."). Carried from M0.
- **Full-coverage refusal enforcement.** Five of the 12 deployment-gate refusal/drift scripts currently exit 0 trivially against `paths: {}` stubs. **Target: ongoing through M2–M6, full coverage by M7.** Carried from M0.

# 6. Going-Forward Commitments

Codified during the M1 cycle, additive to M0's §6.1–§6.7. M0's commitments
remain in force.

## 6.8 New Prisma schema → dual-wire `prisma:validate` AND `prisma:generate` (eighth pre-draft protocol item)

When a directive introduces a new Prisma schema (e.g. PR-10's
`libs/talent/prisma/schema.prisma`), the pre-draft substrate check
must verify the schema is added to BOTH the `prisma:validate` script
AND the `prisma:generate` script in `package.json`. The PR-10 cycle
demonstrated the failure mode: `prisma:validate` was wired (schema
syntax validated in CI), but `prisma:generate` was not (the generated
client never produced in CI), so the build and `test:unit` jobs
failed module resolution against the talent client on the first push.
The fix-up commit `94375a8` resolved it precedent-grounded (mirroring
identity/consent/auth-storage entries), but the omission would have
been caught one step earlier by the protocol addition. This is the
eighth item of M0's §6.7 seven-item pre-draft protocol.

# 7. Standing Items for PO Ratification

Three items routed to the PO at M1 ratification (mirroring the M0
ratification routing of standing items):

## 7.1 The sixth drafting defect + M0 §6.7 transparency commitment

The PR-10 cycle's `prisma:generate` omission is the sixth drafting
defect of similar class — an orchestration-session-authored directive
or commit plan that passed Gate verification but had a pre-draft
substrate gap. The five M0-cycle defects (M0R-1 / M0R-2 / M0R-3
amendments) plus this sixth (PR-10) trigger the M0 Closure Record
§6.7 transparency commitment: *"If a sixth defect of similar class
surfaces despite this protocol, the orchestration session commits to
transparency with PO about orchestration-session fit for the work."*

This item surfaces the sixth-defect occurrence to the PO and records
the orchestration session's recommendation: add the eighth protocol
item (done, §6.8 above), keep current cadence, treat the seven-item
(now eight-item) protocol + Gate 5/6 strengthened acceptance + CI
defense-in-depth as the working control. The cadence is the real
cost; the discipline catches the defects; no defect to date has
reached production. PO decides whether that disposition is sufficient
or whether a further structural change is warranted.

## 7.2 F7 disposition

PO decision 2026-05-16: F7 (Pact provider verification of the
tenant-console-consumer's interactions against aramo-core's consent
endpoints) stays a registered follow-up pinned to early M2 and is
NOT pulled into PR-11. The M1 Closure PR stays tight; M1 §6 DoD
criterion #4 as written passes on the current provider surface.

This item asks the PO to confirm the F7 disposition at M1
ratification — i.e., that pinning F7 to early M2 is accepted as the
disposition for the M1 closure record.

## 7.3 §9.1 branch protection

M0 Closure §9.1 ("configure `deployment-gate` as required status
check") remained Lead-deferred through M1. The PR-10 cycle made the
gap concrete (no longer hypothetical): commit `e559dec` pushed with
3 substantive CI failures; nothing in GitHub branch protection would
have stopped a hasty merge had it been attempted. The fix-up
`94375a8` landed green before any merge attempt, so no damage; but
the gap is now demonstrated, not theoretical.

This item asks the PO to decide whether §9.1 stays deferred or gets
configured. The decision is PO-territory because branch protection
intersects merge cadence + admin permission scope.

# 8. Closing

M1 — Consent + Talent Core Operational — formally closes upon PO
ratification of this Closure Record.

The 7 of 7 §6 DoD criteria PASS. The 3 of 3 M1 exit criteria are MET.
The 13 Charter refusals are substrate-verified for integrity in M1
scope. The new Group 2 v2.7 tripwire installs a permanent loud-failing
safeguard for the multi-tenant honest-visibility posture R4/R5/R6
depend on.

Upon PR-11 merge, this Closure Record is filed at canonical, the PO
ratifies, and M1 closes. M2 (Ingestion — Generic + Indeed Search Only)
becomes the next substantive milestone in the Phase 1 Delivery Plan
v1.2 §3 sequence.

# 9. PO Ratification

I, the Product Owner, ratify M1 closure per the operating-rule
recalibration of 2026-05-15 (milestone-closure-is-PO-territory). The
7-of-7 §6 DoD status table reflects substrate truth; the 3-of-3 M1
exit criteria are MET with substrate-anchored evidence (the new Group 2
v2.7 tripwire converts criterion 3 from PARTIAL to MET); the refusal
layer integrity record at `doc/milestone-signoffs/M1-refusal-signoff.md`
is complete; the outstanding follow-ups are explicitly named with
milestone hooks; the three standing items in §7 carry the PO
decisions needed at M1 ratification.

M1 is closed.

— Product Owner
— [Date of ratification]

*End of M1 Closure Record v1.0*

*Drafted under engineering Lead/Architect authority; ratified by
Product Owner per operating-rule recalibration of 2026-05-15.*
