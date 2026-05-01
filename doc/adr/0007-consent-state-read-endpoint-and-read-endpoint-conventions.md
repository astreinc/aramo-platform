# ADR-0007: Consent State Read Endpoint and Read-Endpoint Conventions

**Status:** Accepted

**Date:** 2026-05-01

**Supersedes:** none

**Extends:** ADR-0006 (Decision D — surgical extension; see §5)

**Related PRs:** PR-5 (`feature/pr-5-consent-state`, merged at `b7776e7`; source commit `fa5dc22`), PR-5.1 (this ADR)

**Related ADRs:** ADR-0001 through ADR-0006

---

## 1. Context

PR-5 introduced the first **read endpoint** in the consent module: `GET /v1/consent/state/{talent_id}`. Up to PR-4, consent endpoints were write-or-check shaped (grant, revoke, check), and ADRs 0001–0006 covered that surface adequately. PR-5 forced a set of decisions that the prior ADRs did not anticipate:

- A read endpoint must return all five scopes deterministically, even when no decisions exist
- Status semantics that ADR-0006 Decision D collapsed (revoked vs. expired both → "denied") must be **distinguished** in a state response
- Staleness, decision-logging, and RTBF detection — all relevant to write/check endpoints — must be explicitly **excluded** from read-endpoint behavior to preserve the enforcement-vs-informational boundary
- Forward-compatibility placeholders (`is_anonymized`) need a documented pattern so future contributors don't treat them as bugs or remove them

These were resolved as eight Lead-locked decisions (A–H) during PR-5 implementation. Two additional implementation precedents surfaced during execution. This ADR codifies all of them, surgically extends ADR-0006 Decision D for the read-endpoint case, and names the retroactive-ADR methodology that produced the last six ADRs.

This ADR documents **codified reality**, not speculative design. Every decision below is implemented in code on `main` as of `fa5dc22` (PR-5 source commit; merged at `b7776e7`) and exercised by tests.

---

## 2. Scope

**In scope.** Decisions A–H from PR-5; status-priority extension to ADR-0006 Decision D for read-endpoint state derivation; OpenAPI 3.1 nullable convention; retroactive-ADR methodology definition; confirmation of Precedents O and P from ADR-0006.

**Out of scope (explicit non-goals).**

- Staleness exposure on the state endpoint — the existing PR-4 staleness logic is reserved for the check endpoint and is not surfaced in state responses
- Decision-log writes from read endpoints — read endpoints never append to `ConsentAuditEvent`
- Idempotency-Key handling on read endpoints — read endpoints are naturally idempotent and do not participate in the Idempotency-Key contract
- RTBF detection — `is_anonymized` is a forward-compatible schema field on `TalentConsentStateResponse` hardcoded to `false` in PR-5; detection logic is deferred to the talent module
- Fifth value in `ConsentScopeStatus` — the enum is closed at four values (`granted | revoked | expired | no_grant`) and any expansion requires a new ADR

---

## 3. Decisions (A–H)

These are the spine of this ADR. Each decision states the rule, its rationale, and its implementation surface.

### Decision A — Wrapped response shape: `TalentConsentStateResponse`

**Statement.** The state endpoint returns a wrapped object containing a `scopes` array, not a bare array. The wrapper enables future addition of envelope-level fields (pagination metadata, server timestamps, audit references) without a breaking change. The wrapper is also the home of root-level metadata fields: `talent_id`, `tenant_id`, `is_anonymized` (Decision F), and `computed_at`.

**Rationale.** Bare-array responses are a known forward-compatibility trap. Every prior consent response in the program is wrapped; PR-5 maintains that consistency.

**Implementation surface.**
- `libs/consent/src/lib/dto/talent-consent-state-response.dto.ts`
- `openapi/common.yaml` → `TalentConsentStateResponse` schema
- Pact consumer interactions in `pact/consumers/ats-thin/src/consent.consumer.test.ts` validate the wrapped shape

### Decision B — Single-tenant scoping derived from JWT

**Statement.** The read endpoint accepts only `talent_id` as a path parameter. The `tenant_id` is derived from the authenticated request context (`authContext.tenant_id`) and never accepted from the URL, query string, or body.

**Rationale.** Accepting tenant from the request surface is a tenant-confusion risk. Deriving from JWT eliminates the class of bugs entirely and matches PR-2/PR-3/PR-4 conventions.

**Implementation surface.**
- `libs/consent/src/lib/consent.controller.ts` → `getTalentConsentState` handler
- `libs/consent/src/lib/consent.service.ts` → `getState()` passes `authContext.tenant_id` directly to the resolver
- `consent.service.spec.ts` "uses tenant_id from JWT, not from any other source" verifies tenant origin is JWT, never request

### Decision C — `TalentConsentScopeState` as the universal per-scope DTO

**Statement.** Per-scope state is represented by `TalentConsentScopeState`, containing only fields that are universally meaningful across consumers: scope identifier (`scope`), derived status (`status`), and decision timestamps (`granted_at`, `revoked_at`, `expires_at`). The DTO contains exactly five fields. Display concerns (`display_label`) and derived staleness flags (`is_stale`) are **not** present on this DTO. The right-to-be-forgotten signal `is_anonymized` lives on the response wrapper (`TalentConsentStateResponse`), not on the per-scope DTO — anonymization is a talent-level state, not a scope-level state.

**Rationale.** Display labels are a Portal concern and belong in a Portal-specific projection (`PortalConsentScopeState`, future). Staleness is enforcement metadata and belongs to the check endpoint (Decision E). Anonymization is a property of the talent identity, not of any individual scope; placing it on the per-scope DTO would replicate the same value across five entries. Mixing these concerns at the universal layer creates pressure to expose internal logic and inflates the wire shape.

**Implementation surface.**
- `libs/consent/src/lib/dto/talent-consent-scope-state.dto.ts`
- `openapi/common.yaml` → `TalentConsentScopeState` schema
- TypeScript interface enforced at compile time across the consent service boundary

### Decision D — Always exactly five scopes

**Statement.** The state endpoint always returns exactly five scope entries, one per `CONSENT_SCOPES` constant, regardless of whether decisions exist for any given scope. Missing decisions surface as `status: "no_grant"`.

**Rationale.** Deterministic shape simplifies client logic. Clients never need to defensively check for missing scopes or merge against a separate scope inventory. This is the same pattern as the check endpoint's behavior of returning a definite answer per scope.

**Implementation surface.**
- `libs/consent/src/lib/consent.repository.ts` → `resolveAllScopes` uses `CONSENT_SCOPES.map(...)` as the iteration spine
- Unit test "always returns exactly 5 entries" in `consent.repository.spec.ts`
- Integration test verifies five entries against an empty database

### Decision E — No staleness exposure on state response

**Statement.** The state response does not compute, expose, or hint at staleness. A 13-month-old grant returns `status: "granted"` on the state endpoint with no staleness indicator, while the check endpoint continues to return `stale_consent` per PR-4 logic.

**Rationale.** Staleness is enforcement metadata. Surfacing it on a read endpoint invites clients to make enforcement decisions client-side and bypass the check endpoint, which is the only place enforcement logic should live. The boundary between informational (read) and enforcement (check) is load-bearing.

**Implementation surface.**
- `libs/consent/src/lib/consent.repository.ts` → `deriveScopeStateForReadEndpoint` helper does not call any staleness logic; `isStale` from PR-4 is reserved for `resolveConsentState` only
- Existing PR-4 staleness tests (check endpoint) pass unchanged
- Integration test confirms a 13-month-old grant returns `granted` from the state endpoint while the same ledger state would return `stale_consent` from the check endpoint

### Decision F — `is_anonymized` always `false` in PR-5 (schema-now-detection-later)

**Statement.** The `is_anonymized` field is present on `TalentConsentStateResponse` (the response wrapper, **not** the per-scope DTO) and hardcoded to `false` in PR-5. RTBF detection logic is deferred to the talent module, which owns the anonymization state machine.

**Rationale.** Establishing the schema field now lets the detection logic ship later without a breaking API change. Removing the field and re-adding it would force every consumer to re-handle the shape twice. This is the **schema-now-detection-later** pattern (see §7). Placing the field on the wrapper rather than per-scope reflects that anonymization is a talent-level state — a single talent is or is not anonymized — not a scope-level state.

**Implementation surface.**
- `libs/consent/src/lib/consent.repository.ts` → `resolveAllScopes` writes `is_anonymized: false` literal in the wrapper return value, with a comment block citing the deferral
- Two unit tests verify the field is always `false` regardless of decision history
- PR-5 description and this ADR make the limitation explicit

### Decision G — Batch resolver method `resolveAllScopes`

**Statement.** Read-endpoint state derivation lives in a new repository method `resolveAllScopes`, sibling to the existing `resolveConsentState`. The two methods share the resolver region but serve distinct callers (check endpoint vs. read endpoint) and apply distinct semantics (Decision E).

**Rationale.** A single fused method would entangle staleness logic with the read path and re-introduce the boundary violation Decision E prevents. Two methods with shared region-local helpers keep the boundary clean while avoiding code duplication.

**Implementation surface.** Resolver region of `libs/consent/src/lib/consent.repository.ts`: public method `resolveAllScopes`, plus region-local helpers (currently `deriveScopeStateForReadEndpoint` and `findLatestForAction`; expected to grow as additional read endpoints land). 16 unit tests in `consent.repository.spec.ts` cover the resolver; 3 integration tests cover end-to-end behavior including the Counterintuitive Example. The R4 guardrail's region-marker mechanism (Precedent O) is the durable classification anchor; helper names will rot as the region grows but the region itself is stable.

### Decision H — Read endpoints do not write decision-log entries

**Statement.** The state endpoint does not write to `ConsentAuditEvent` or any audit/decision-log table. Read operations are observed via standard request logging, not via the consent decision log.

**Rationale.** The decision log records consent **decisions** — grants, revocations, and other state-changing actions. Reads are not decisions. Writing read events to the decision log dilutes its semantic value and inflates storage. Standard request logs are the correct place for read observability.

**Implementation surface.**
- `libs/consent/src/lib/consent.repository.ts` → `resolveAllScopes` body contains no `tx.consentAuditEvent.create` call
- Explicit unit test "does NOT call tx.consentAuditEvent.create"
- Integration test verifies `consentAuditEvent` row count is unchanged across the read call

---

## 4. ConsentScopeStatus — closed enum

`ConsentScopeStatus` is the **eighth closed enum in the program** and is distinct from `ConsentDecisionAction`. The two serve different layers:

- `ConsentDecisionAction` — what a user did (grant, revoke, etc.); used in the decision log and write paths
- `ConsentScopeStatus` — the derived current state of a scope from the read endpoint's perspective

The four values are: `granted`, `revoked`, `expired`, `no_grant`. The enum is closed at four values; adding a fifth is a new-ADR action, not a quiet expansion. The `no_grant` value is unique to read-endpoint derivation — there is no `TalentConsentEvent` with `action: "no_grant"` — which is why `ConsentScopeStatus` is a separate enum from `ConsentDecisionAction` rather than a superset of it.

**Implementation surface.** `libs/common/src/lib/types/consent-scope-status.ts`, exported via barrel.

**Program closed-enum count after PR-5: 8.** `ConsentScope`, `ConsentDecisionAction`, `ConsentCapturedMethod`, `ContactChannel` (PR-3.2), `ErrorCode` (7 values), `ConsumerType`, `ConsentCheckOperation` (PR-4), `ConsentScopeStatus` (PR-5).

---

## 5. Surgical extension to ADR-0006 Decision D

ADR-0006 Decision D treats `revoked` and `expired` as equivalent "denied" outcomes for the **check endpoint**. This was correct for enforcement: a revoked grant and an expired grant both fail the check, and the caller does not need to distinguish them to make an allow/deny decision.

The **read endpoint** must distinguish them so clients can render accurate state ("you revoked this on date X" vs. "this expired on date Y"). PR-5 introduces the following priority for state derivation:

```
revoked > expired > granted > no_grant
```

Read top-to-bottom: when a scope has multiple events that could resolve to different statuses across captured-method partitions, the higher-priority status wins.

**Rationale for the ordering.**

- `revoked` over `expired`: revocation is an explicit user action and represents the most recent user intent. Time-driven expiry is a system action. User intent wins when both are present in different sources.
- `expired` over `granted`: an expired grant is no longer in force. The grant existed but has lapsed.
- `granted` over `no_grant`: any decision is more informative than no decision.

**Constraint — what this extension does not change.**

- Check endpoint semantics are **unchanged**. The check endpoint continues to treat revoked and expired as equivalent denial outcomes per ADR-0006 Decision D core contract. `computeMostRestrictiveStateForScope` (the check-endpoint helper) returns `'denied'` for both.
- This priority applies **only** to read-endpoint state derivation in `deriveScopeStateForReadEndpoint`.
- Future contributors must not "helpfully" unify the two code paths. The distinction is intentional and load-bearing; it is the structural manifestation of the enforcement-vs-informational boundary that Decisions E, G, and H also defend.

**Implementation surface.** `libs/consent/src/lib/consent.repository.ts` → `deriveScopeStateForReadEndpoint`. Unit tests cover all priority pairings, including the explicit "revoked takes priority over expired when both present in different sources" case.

---

## 6. OpenAPI 3.1 nullable convention (program-wide standard)

**Standard.** Nullable fields in `openapi/common.yaml` and all program OpenAPI specs use OpenAPI 3.1 union types. The legacy OpenAPI 3.0 `nullable: true` keyword is **not** used.

**Canonical form.**

```yaml
oneOf:
  - type: string
    format: date-time
  - type: 'null'
```

The equivalent `type: ['string', 'null']` shorthand is also acceptable where it does not interfere with `format` or other type-specific keywords; the `oneOf` form is preferred for fields with `format` because it keeps the format scoped to the non-null branch.

**Lineage.** Originated in PR-3 (`ConsentRevokeResponse.revoked_event_id`). Reinforced by PR-5 across multiple `TalentConsentScopeState` timestamp fields (`granted_at`, `revoked_at`, `expires_at`). The `openapi:lint` gate (Redocly) enforces this on new schemas — PR-5's first draft used `nullable: true` and was caught by the gate before push.

**Constraint.** No legacy `nullable: true` schemas currently exist in this program (verified by grep across `openapi/*.yaml` during PR-5.1 drafting). Migrating any future legacy use to the canonical form is in-scope for whichever PR introduces them; new schemas must use the canonical form from the start.

---

## 7. Retroactive-ADR methodology

The last six ADRs (0002–0007) have followed a consistent loop. This section names it so future contributors recognize and apply it deliberately.

**Trigger.** A PR has converged: implementation is complete, all gates are green, the PR is merged. Decisions made during implementation that were not pre-codified in an ADR are now load-bearing in code.

**Inputs.**
- The merged PR's implementation report (decision-by-decision map)
- The validating test suite (unit, integration, contract, guardrail)
- Any precedents that surfaced during execution (whether explicitly named at the time or not)

**Output.** A new ADR that:
- States each decision with rationale and a pointer to its implementation surface
- Cites the validating tests
- Names confirmed precedents in a dedicated section
- Calls out explicit non-goals to prevent drift
- Surgically extends prior ADRs where needed, without rewriting them

**Constraint — no speculative design.** Retroactive ADRs document codified reality. They do not introduce new decisions, propose future work beyond clearly-marked deferrals, or include design alternatives that were not actually considered during the PR. Speculative design belongs in a forward-looking ADR (RFC-style), which is a separate document type.

**Constraint — verify before drafting.** Retroactive ADRs are written against the merged code, not against memory of what was implemented. Every claim about field names, value counts, file paths, or behavior must be verified by reading the corresponding source file at the merge commit. PR-5.1 surfaced and codified this constraint within the same ADR.

**Cadence.** Retroactive ADRs are typically authored in the next PR following the implementation PR, though historical exceptions exist (e.g., PR-2 → ADR-0003).

**Frontmatter convention.** ADR-0007 introduces frontmatter fields for Supersedes, Extends, Related PRs, and Related ADRs. This convention is adopted program-wide going forward. No retrofitting of ADR-0001 through ADR-0006 required.

This methodology is now standing practice. Whether to split it into its own meta-ADR is a Lead decision; for now it lives here.

---

## 8. Precedents confirmed

These were established by prior PRs and validated by PR-5. They are listed here as confirmed standing practice, not new decisions.

### Precedent O — Resolver-region operations, no guardrail update needed

**Confirmed.** New methods added to the resolver region of `consent.repository.ts` that use only operations from the established allow-list (`tx.idempotencyKey.findUnique` / `.create`, `tx.talentConsentEvent.findMany`, `tx.consentAuditEvent.create`) do not require an update to the R4 refusal guardrail spec. PR-5's `resolveAllScopes` is the first method added under this assumption; the existing R4 guardrail (`consent.refusal-r4.spec.ts`) passed unchanged across all 12 of its tests. The precedent's design intent — that the region marker plus a stable allow-list is the durable enforcement surface — holds.

### Precedent P — Local `nx build` sweep before push

**Confirmed.** The pre-commit local sweep includes `nx run-many --target=build --all --skip-nx-cache` per the precedent set after PR-4's build-vs-test gap. PR-5 ran the sweep, caught nothing requiring fix-up, and pushed with all 16 CI checks green on the first push. This is now standing practice and applies to every implementation PR going forward.

---

## 9. Consequences

**Positive.**
- Read-endpoint conventions are documented before a second read endpoint exists, so the second one inherits the pattern rather than re-deriving it
- The check-vs-read boundary is explicit and defended by Decisions E, G, and H plus the §5 surgical extension
- The retroactive-ADR loop is named, so its discipline is teachable; the verify-before-drafting constraint added in §7 captures a discipline that surfaced during PR-5.1 itself
- ADR-0006 Decision D is preserved; the extension is surgical and scoped (not a rewrite of the prior decision)

**Costs / risks.**
- The closed enum and the eight-decision spine constrain future evolution; expansion requires deliberate ADR work, which is the intended cost
- The `is_anonymized` placeholder will need a follow-up ADR when the talent module ships RTBF detection (forward pointer noted)
- Future contributors may be tempted to unify `resolveAllScopes` and `resolveConsentState`; the constraint in §5 must be enforced in review

**Forward pointers.**
- RTBF detection landing in the talent module will produce an ADR amending Decision F (anonymization detection wired; `is_anonymized` may become non-deterministic)
- A future Portal-specific projection (`PortalConsentScopeState`) will reference Decision C as the universal-vs-projection precedent
- PR-6 (consent history read) is the next read endpoint; it inherits Decisions B, E, H and the resolver-region conventions, and may surface a third read-endpoint precedent worth a future ADR

---

## 10. References

- ADR-0001 through ADR-0006 (program ADR series)
- PR-5 implementation surface: `libs/consent/`, `libs/common/`, `openapi/common.yaml`, `pact/consumers/ats-thin/`
- PR-5 source commit: `fa5dc22`; merge commit: `b7776e7`
- Validating tests: `consent.repository.spec.ts`, `consent.service.spec.ts`, `consent.controller.spec.ts`, `consent.integration.spec.ts`, `pact/consumers/ats-thin/src/consent.consumer.test.ts`
- Spec authority: API Contracts v1.0 Phase 1 §6 (state endpoint table, line 500); Group 2 §2.7 (consent semantics inherited via ADR-0006 Decision D); Group 2 §2.8 (Talent Portal Minimum, multi-tenant honesty informing Decision B)
