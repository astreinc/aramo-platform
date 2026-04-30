# ADR-0005: Consent Revoke Contract & Audit Semantics

**Status:** Accepted

**Date:** 2026-04-30

---

## Context

PR-3 (`feat: PR-3 consent revoke endpoint + canonical revoke contract`, source commit `cd0543f`, merged as `4a4dc92`) implemented `POST /v1/consent/revoke` and defined the canonical consent revoke contract for the program. API Contracts Phase 1 §6 enumerated the endpoint with idempotency required but did not specify the request/response body shape; the formal Phase 5 registry enumerates error codes but does not extend to per-endpoint payload structure. PR-3 committed the program to specific request and response schemas, the audit payload structure (per Group 2 §2.7's Revocation Audit Structure), the linkage semantic between a revocation and its prior grant, deferral conventions for fields tied to functionality not yet implemented (engagement halt, propagation completion), and a refinement to the PR-2 "no state computation" rule that allows single-event lookups for referential linkage.

ADR-0005 lifts these decisions into `doc/adr/` as program doctrine. PR-4 (consent check) and PR-5 (consent state) both depend on the rule refinement for their boundary against cross-event derivation; the audit payload shape is inherited by every future revocation-recording PR; and the runtime action-lock guard becomes the program's defense-in-depth pattern for any endpoint that hardcodes a server-set discriminator. Per `doc/04-risks.md` CX2, this ADR is the rationale-recovery anchor before the precedent quietly drifts; per D4, it locks the pattern before parallel PRs invent variants. The retroactive-ADR pattern (ADR-0001 captured PR-1, ADR-0003 captured PR-2, ADR-0004 captured PR-2.2, ADR-0005 captures PR-3) is the program's idiom for documenting precedent after a precedent-setting PR merges.

---

## Decision

The canonical consent revoke contract has six coupled decisions. PR-3 implements all six; future PRs reference this ADR.

### Decision A — `revoked_event_id` server-derived via single-event lookup

**What.** Inside the same transaction that writes the revocation event, `recordConsentEvent` performs a single indexed query against `TalentConsentEvent`:

```ts
const priorGrant = await tx.talentConsentEvent.findFirst({
  where: {
    tenant_id: input.tenant_id,
    talent_id: input.talent_id,
    scope: input.scope,
    action: 'granted',
  },
  orderBy: { occurred_at: 'desc' },
  select: { id: true },
});
```

The result populates `revoked_event_id` in the audit `event_payload`, the outbox `event_payload`, and the response body.

**Why.** §2.7's Revocation Audit Structure includes `revoked_event_id` as a referential-linkage field. Server derivation is appropriate because (a) clients should not need prior knowledge of grant event IDs to perform a revocation; (b) recorder-supplied IDs would create a trust boundary where the recorder could falsify linkage (e.g., point a revocation at an unrelated grant event); (c) the lookup is a single indexed query against the existing `(tenant_id, talent_id, occurred_at)` index, not cross-event derivation, and is therefore permitted under Decision E's refined rule.

**Constraint.** The lookup is strictly bounded — exactly four `where` filters (tenant + talent + scope + `action='granted'`), exactly one ordering (`occurred_at DESC`), exactly one `select` field (`id`). Adding fields to the select, relaxing any filter, or replacing `findFirst` with `findMany` expands the operation into state-derivation territory and is a Decision E violation. The R4 static-source guardrail (`consent.refusal-r4.spec.ts`) enforces this mechanically.

**Failure mode.** If no matching prior grant exists, `revoked_event_id` is `null` (see Decision D).

### Decision B — `in_flight_operations_halted: []`

**What.** The audit `event_payload` for every revocation event includes `in_flight_operations_halted: []` (empty array) in PR-3.

**Why.** §2.7 declares this field as part of the canonical audit structure. Honoring the field structurally — empty array, not omitted, not `null` — means future engagement-halt workers can append entries without requiring an audit-payload migration. The schema contract is established now; semantic content lands when the worker exists. Three alternatives were considered: omit the field (forces migration when worker lands), set to `null` (semantically wrong — `null` implies "halt status unknown" while `[]` correctly implies "halt list is empty"), or carry a placeholder entry (would seed bad data downstream consumers might act on).

**Reversal trigger.** When a future PR introduces an engagement-halt worker, that worker populates this array with real entries describing each halted operation. No ADR amendment needed; the field is already permitted to hold non-empty values per the §2.7 contract.

### Decision C — `propagation_completed_at: null`

**What.** The audit `event_payload` for every revocation event includes `propagation_completed_at: null` in PR-3.

**Why.** §2.7 declares this field as part of the canonical audit structure. The outbox emission inside the revocation transaction is *not* propagation completion — propagation completion implies downstream consumers have processed the outbox event (acknowledged, applied, or otherwise closed the loop), which PR-3 does not implement (no outbox publisher exists yet). Two alternatives were rejected: setting the field to `recorded_at` (a small lie — it conflates ledger insertion with downstream completion) and omitting the field (forces audit-payload migration when propagation completion lands). Explicit `null` is the honest representation.

**Reversal trigger.** When a future PR implements propagation completion (an outbox publisher with acknowledgement, or a downstream worker that closes the loop on revocation propagation), that PR populates this field with the completion timestamp. No ADR amendment needed.

### Decision D — Revoke without prior grant is allowed

**What.** A revocation event may be recorded even when no matching prior grant exists for `(tenant_id, talent_id, scope)`. In that case, `revoked_event_id` is `null` in the response, audit payload, and outbox payload. The revocation event itself is still written to `TalentConsentEvent`; the audit row is still created; the outbox event is still emitted.

**Why.** Revocation is an assertion of intent, not a state-mutation predicated on prior state. The system may legitimately not have historical grant data: consent recorded via an external system before Aramo onboarding, legacy data migrations where grant events were never replayed, consumers asserting revocation as a prophylactic action against unknown prior state. Rejecting revocation on absent-grant grounds would either (a) force consumers to query before acting (creating a new state-derivation surface that itself violates Decision E), or (b) deny legitimate intent assertions and silently accept the prior-state ambiguity as "no revocation needed."

**Constraint.** The downstream signal is `revoked_event_id: null`, not the absence of a revocation. Consumers see "this revocation has no prior linkage" rather than "no revocation occurred." The distinction is load-bearing for any future cross-event derivation (PR-4+) that needs to interpret revocation history.

### Decision E — Refined "no state computation" rule

**What.** The PR-2 prompt's "no state computation" rule is refined for PR-3 and onward to:

> **No cross-event consent state derivation** (e.g., resolving current consent across multiple events or sources, computing staleness, intersecting scopes across tenants). **Single-event lookups for referential linkage are allowed.**

**Why.** The original rule was meant to block PR-4's cross-event derivation surface (the most-restrictive intersection across sources, staleness computation, scope dependency resolution). The single-event lookup in Decision A doesn't fit that pattern — it's one indexed query for referential linkage, not derivation across multiple events. The refined rule preserves the original intent (PR-4's check endpoint is still bound by the cross-event derivation rule) while permitting Decision A's lookup explicitly. Without the refinement, PR-3 had to either reject the §2.7 audit-shape compliance or violate the rule silently; both are worse than refining the rule with explicit grammatical scope.

**Permitted operations under the refined rule:**
- `findFirst` against the consent ledger for single-event referential lookups (Decision A's pattern)
- `findUnique` for identity lookups (e.g., the idempotency check from PR-2)

**Forbidden operations under the refined rule:**
- `findMany` returning multiple consent events (cross-event scanning territory)
- `aggregate`, `groupBy`, `count` against consent events (multi-event computation)
- Any read that would require evaluating state across multiple events to produce its result (e.g., "is the most-restrictive consent across all tenants `revoked`?")

**Enforcement.** The static-source guardrail in `consent.refusal-r4.spec.ts` allow-lists Decision A's `findFirst` and the idempotency `findUnique` with explicit citation, and explicitly forbids `findMany` / `aggregate` / `groupBy` / `count` operations on the ledger. Any PR that adds one of the forbidden operations fails this test and the reviewer must determine whether the change is a legitimate refactor or a Decision E violation.

### Decision F — Repository-layer runtime action-lock guard

**What.** `recordConsentEvent` includes a runtime guard at the top of the method body, before the transaction opens:

```ts
if (input.action !== 'granted' && input.action !== 'revoked') {
  throw new AramoError(
    'INTERNAL_ERROR',
    `recordConsentEvent received an unsupported action: ${String(input.action)}`,
    500,
    { requestId: input.requestId, details: { received_action: String(input.action) } },
  );
}
```

**Why.** Defense-in-depth alongside three upstream layers: OpenAPI schema validation (`additionalProperties: false`, no writable `action` field on the request schemas), the class-validator pipe (`forbidNonWhitelisted: true` rejects unknown properties at the controller boundary), and the service layer's hardcoded action literals (`grant()` passes `'granted'`; `revoke()` passes `'revoked'`). Matches the program's R8 / R9 idiom where Charter refusals are enforced at multiple layers, not relying on type safety alone. The PR-3 refactor (`recordGrantEvent` → `recordConsentEvent` parameterized by action) shifted the action-lock from "repository hardcodes the literal" to "service hardcodes via the literal it passes in"; without this guard, a future caller bypassing the service (e.g., a worker calling the repository directly with `action: 'expired'` for the staleness path) would write whatever action it supplied.

**Why `INTERNAL_ERROR` (500), not `VALIDATION_ERROR` (400).** If the runtime guard fires, every upstream defense (OpenAPI, class-validator, service hardcoding) has been bypassed. That is a server-side invariant violation, not a client validation failure. `INTERNAL_ERROR` (the registry's catch-all 5xx code per ADR-0003 Decision 8) is the honest classification — the client may have done nothing wrong; the server cannot complete the request because its own contract was violated.

**Test coverage.** `consent.refusal-action-locked.spec.ts` uses an `as any` cast to bypass TypeScript's narrowing and verifies the guard fires with the correct error code, status, and `received_action` detail. The test deliberately uses `'expired'` as the hostile value — a value valid in the §2.2 entity enum but not in PR-3's permitted set — which exercises the realistic future-confusion scenario where a staleness worker accidentally calls the wrong repository method.

---

## Consequences

### Positive

- **PR-4+ inherit a canonical revoke contract.** No re-derivation of audit shape, linkage semantic, deferral conventions, or rule scope. Future revocation-recording paths reference Decisions A–D directly.
- **§2.7 audit shape compliance is locked at the payload structure level.** Decisions B and C honor the spec's field set structurally, so downstream workers (engagement halt, propagation completion) can populate fields without an audit-data migration.
- **The Decision E refinement preserves the original intent** (block cross-event derivation in PR-4) while permitting the narrow lookup that referential linkage requires. The R4 static-source guardrail provides mechanical enforcement in addition to reviewer judgment.
- **Decision F restores the R8/R9 belt-and-suspenders pattern** that the PR-3 refactor could otherwise have eroded into "type-system-only" enforcement. The guard adds 5 lines of runtime cost (one comparison) to protect against a class of attack the refactor opened.
- **Decision D prevents a new state-derivation surface.** Requiring prior-grant verification before allowing revocation would either re-introduce cross-event derivation in `recordConsentEvent` (Decision E violation) or force consumers to query before acting (a new state-derivation surface in the consumer).

### Negative

- **The audit payload shape is now committed to specific fields** (Decisions B, C). Future workers populating these fields must conform; the shape can grow with new optional fields but cannot shrink existing ones (`in_flight_operations_halted`, `propagation_completed_at`) without an audit-data migration. The cost is acceptable because the shape matches §2.7's canonical structure.
- **Decision E's grammatical window is narrow.** "Single-event lookups for referential linkage are allowed" leaves room for a future PR to claim "but my lookup is only narrowly cross-event…" Tier 3 review on every refusal-relevant PR must enforce the refined rule strictly. The R4 guardrail catches the common case (forbidden operation names) but not every cross-event read pattern in principle. Reviewer discipline remains load-bearing.
- **Decision F's runtime guard is implementation surface that must remain in place.** Removing it would silently relax the R8/R9 enforcement to "type system + upstream layers only." A future refactor that simplifies `recordConsentEvent` by removing the guard would fail no test (the test uses `as any` to construct a state that "shouldn't happen") but would weaken the contract. The comment in the source explicitly cites the R8/R9 idiom to make removal a visible decision rather than a casual cleanup.
- **Decision D allows a class of revocation events that have no prior linkage.** Downstream consumers must handle `revoked_event_id: null` correctly. PR-4's check endpoint and PR-5/6's read endpoints will need to distinguish "revocation with linkage" from "revocation without linkage" in their state computation.

### Neutral

- This ADR captures six decisions in one Decision section with sub-decisions A–F, matching the consolidation pattern from ADR-0001 (4 decisions for PR-1) and ADR-0003 (8 decisions for PR-2). One ADR per precedent-setting PR, regardless of how many discrete decisions that PR commits.
- The Reversal Trigger pattern from ADR-0002 is intentionally not used as a separate top-level section. Decisions B and C have inline reversal triggers (when worker / propagation lands) because they have specific external events that flip individual fields; the surrounding contract structure is durable. Decision A could acquire a reversal trigger if Prisma ever introduces a referential-linkage primitive that subsumes the explicit lookup, but that's speculative.
- This is the fifth retroactive ADR in the program (ADR-0001 PR-1, ADR-0003 PR-2 infra, ADR-0004 PR-2.2 Pact, ADR-0005 PR-3 contract). The program's idiom is now firmly established: substantive product PR ships first, the ADR follows in a small Tier 3 follow-up that documents the surfaced precedents, and future PRs reference the ADR by number rather than re-deriving from PR descriptions.
- Decision F's `INTERNAL_ERROR` classification is consistent with ADR-0003 Decision 8 (per-job CI invocation precedent) and the broader program-wide convention that 5xx codes signal server-side invariant violations rather than client errors. ADR-0005 does not introduce new error-classification policy; it applies the existing one.

---

## References

- PR-3 commits: `cd0543f` (`feat: PR-3 consent revoke endpoint + canonical revoke contract`), merged as `4a4dc92`
- PR-2 commits: `fb2c61c`, `1b9a95a`, merged as `35b7d52` — established the consent module structure ADR-0005 extends
- Group 2 §2.7 — Revocation Audit Structure (the canonical structure ADR-0005 documents the program's compliance with)
- API Contracts v1.0 Phase 1 §6 — Consent API endpoint enumeration (`/v1/consent/revoke` declared; body shape defined in PR-3)
- API Contracts v1.0 Phase 5 — error envelope and 36-code registry (ADR-0005 Decision F uses `INTERNAL_ERROR` per the catch-all 5xx convention)
- Charter §8 — Refusals R4 (no consent inference from behavior), R6 (no acting on stale consent), R11/R13 (consent integrity over engagement velocity), R8/R9 (multi-layer enforcement idiom referenced by Decision F)
- `doc/04-risks.md` CX2 (architectural rationale forgotten — the failure mode this ADR mitigates), D4 (pattern drift — the failure mode this ADR locks against)
- `doc/06-lead-review-checklist.md` Tier 3 — ADR linkage requirement for precedent-setting PRs
- `doc/adr/README.md` — ADR conventions; this ADR follows the Michael Nygard short-form template established by ADR-0001
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — pattern PR for ADR format and the retroactive-precedent idiom; consolidation pattern (multiple decisions in one ADR)
- ADR-0002 (`doc/adr/0002-bootstrap-branch-protection-relaxations.md`) — pattern PR for the Reversal Trigger section (used inline in Decisions B and C, not as a standalone section)
- ADR-0003 (`doc/adr/0003-infrastructure-conventions-prisma7-build-ci.md`) — most recent retroactive infrastructure ADR; Decision 8 (`INTERNAL_ERROR` per-job CI invocation) is the precedent Decision F's error classification builds on
- ADR-0004 (`doc/adr/0004-pact-contract-test-convention.md`) — most recent retroactive convention ADR; pattern match for ADR-0005's structure
- PR-3 source artifacts: `openapi/common.yaml` (Decisions A, B, C, D), `libs/consent/src/lib/consent.repository.ts` (Decisions A, F), `libs/consent/src/tests/consent.refusal-r4.spec.ts` (Decision E enforcement), `libs/consent/src/tests/consent.refusal-action-locked.spec.ts` (Decision F test coverage)
