# Claude Code Prompt Template

This document is the **mandatory template** for writing Claude Code prompts that produce code in the Aramo program.

A prompt that doesn't follow this template will produce drift. A Claude Code instance reading a prompt that doesn't establish context will infer instead of asking, and inference is the failure mode this program is designed to prevent.

---

## The Five-Section Template

Every prompt has exactly five sections in this order:

```
## Context
## Locked Specs
## Refusal Commitments
## Acceptance Criteria
## References
```

Each section has explicit content requirements below.

---

## Section 1 — Context

**Purpose:** Tell Claude Code what this PR is, why it exists, and how it fits into the larger program.

**Required content:**

1. **One-sentence objective:** what this PR accomplishes
2. **Workstream and milestone:** which WS (per Phase 1 Delivery Plan) and which milestone
3. **Pattern PRs to follow:** PR numbers of similar prior implementations to mirror
4. **In-flight PRs to coordinate:** if any current PRs touch related code

**Example:**

```markdown
## Context

Implement the consent grant endpoint (`POST /v1/consent/grant`) that records a 
TalentConsentEvent and recomputes current consent state.

Workstream: WS2 — Talent + Consent Core
Milestone: M1 — Consent + Talent Core Operational

Pattern PRs to follow:
- PR-4 (consent check endpoint) — established the consent module structure
- PR-3 (TalentConsentEvent Prisma schema) — established the event ledger pattern

In-flight PRs:
- None at time of writing

This PR is the second consent endpoint implementation; the third (revoke) and
fourth/fifth (state, history) will follow this same pattern.
```

**Anti-pattern:**

```markdown
## Context

Add a consent grant endpoint.
```

This gives Claude Code no anchoring; it will infer pattern, scope, and structure.

---

## Section 2 — Locked Specs

**Purpose:** Reference the exact locked spec sections this PR derives from. Claude Code reads these sections to ground the implementation.

**Required content:**

1. **Charter sections** (if this PR touches refusal layer or program identity)
2. **Group 2 sections** (entity definitions, threshold rules, state machines)
3. **Architecture sections** (module boundaries, persistence patterns, infrastructure)
4. **API Contracts phase + section** (endpoint specification, schema definition)
5. **Specific OpenAPI schemas** referenced

**Example:**

```markdown
## Locked Specs

This PR implements the spec defined in:

- **API Contracts Phase 1 Section 6.3** — POST /v1/consent/grant endpoint
- **Group 2 Section 2.2** — TalentConsentEvent entity definition (immutable ledger)
- **Group 2 Section 2.7** — Consent semantics and the staleness stance
- **Architecture Section 10** — Consent enforcement architecture

OpenAPI schemas (in `openapi/common.yaml`):
- `ConsentWriteRequest` — request body
- `ConsentWriteResponse` — success response (201)
- `ConsentScopeState` — included in subsequent state queries

The endpoint must match these schemas exactly.
```

**Anti-pattern:**

```markdown
## Locked Specs

Per the spec, consent grant should record an event and update state.
```

This is paraphrasing, not referencing. Paraphrase loses precision over time.

---

## Section 3 — Refusal Commitments

**Purpose:** Make Claude Code aware of which Charter refusals this PR's code path could violate. This section is where the program's discipline becomes visible at the prompt level.

**Required content:**

1. **Identify refusal-relevant surfaces** this PR touches (if any)
2. **Enumerate specific refusals** (R1-R13 from `03-refusal-layer.md`) at risk
3. **Specify the structural enforcement** Claude Code must preserve

**Example for a refusal-relevant PR:**

```markdown
## Refusal Commitments

This PR touches the consent module. Refusals at risk:

- **R4 (no consent inference):** the implementation must compute consent from 
  the TalentConsentEvent ledger only. Do NOT infer from candidate behavior, 
  engagement state, or any other source.
  
- **R13 (consent integrity over engagement velocity):** if Consent Service 
  becomes unavailable, the response must be denied, not allowed-by-default.

Structural enforcement to preserve:
- `ConsentWriteRequest` and `ConsentWriteResponse` schemas use `additionalProperties: false`
- `ConsentDecisionResult` enum is closed: `allowed | denied | error`
- Append-only ledger: never UPDATE TalentConsentEvent, only INSERT new events

Do NOT:
- Infer consent from candidate behavior
- Skip consent check on "high priority" or "urgent" requests
- Add fields to ConsentScopeState beyond what the schema specifies
```

**Example for a non-refusal-relevant PR:**

```markdown
## Refusal Commitments

This PR adds utility logging functions in `libs/common/`. No refusal layer 
surfaces are touched.

Standard discipline still applies:
- No vocabulary drift (use `talent_id`, not `candidate_id`)
- No PII in logs (no resume content, no full contact details)
- No bypass of locked patterns
```

**The honest "no refusal touched" pattern is good.** It demonstrates Claude Code considered the question and verified no refusal applies.

**Anti-pattern:**

Skipping this section entirely. Even when no refusal applies, the section must exist saying so.

---

## Section 4 — Acceptance Criteria

**Purpose:** Define exactly what "done" means for this PR. Claude Code uses this to know when to stop, and Lead Engineer uses this to verify completeness.

**Required content:**

1. **Code deliverables:** files created/modified
2. **Test deliverables:** unit, integration, Pact tests required
3. **OpenAPI deliverables:** schema or path additions/changes
4. **CI checks that must pass:** specific gates from `06-lead-review-checklist.md`
5. **Documentation deliverables:** any `doc/*.md` updates required

**Example:**

```markdown
## Acceptance Criteria

### Code
- [ ] `libs/consent/src/lib/consent.controller.ts` — add `grantConsent` handler
- [ ] `libs/consent/src/lib/consent.service.ts` — add `grant()` method
- [ ] `libs/consent/src/lib/consent.repository.ts` — add `createGrantEvent()` method
- [ ] `libs/consent/src/lib/dto/consent-write-request.dto.ts` — request DTO
- [ ] `libs/consent/src/lib/dto/consent-write-response.dto.ts` — response DTO

### Tests
- [ ] Unit tests for `grant()` method covering: valid grant, invalid scope combination, 
      idempotent retry with same body, idempotent retry with different body (409)
- [ ] Integration test for endpoint covering: successful grant, validation error, 
      consent state conflict
- [ ] Pact consumer test in `pact/consumers/portal/src/consent.consumer.test.ts` 
      covering successful grant and validation error paths

### OpenAPI
- [ ] `openapi/common.yaml` already specifies this endpoint (no changes needed)
- [ ] Verify implementation matches OpenAPI exactly via Pact test

### CI Checks
- [ ] `openapi:validate` passes
- [ ] `openapi:drift-check` passes (no endpoint drift)
- [ ] `pact:consumer` passes
- [ ] `pact:provider` passes (state handler `valid Talent and tenant exist` 
      must be implemented before this can fully pass)
- [ ] `tests:unit` passes (>= 80% coverage on new code)
- [ ] `tests:integration` passes
- [ ] `lint:nx-boundaries` passes

### Documentation
- [ ] No `doc/*.md` updates required (consent grant pattern is already documented 
      via PR-4)
```

**Anti-pattern:**

```markdown
## Acceptance Criteria

- Implement the endpoint
- Add tests
- CI passes
```

Vague acceptance criteria produce vague implementations.

---

## Section 5 — References

**Purpose:** Concrete file paths and resource pointers Claude Code can read to ground its work.

**Required content:**

1. **`doc/*.md` files** Claude Code must read first
2. **OpenAPI files** the implementation touches
3. **Pattern PR file paths** to read for reference
4. **Locked spec excerpts** if needed (rare; usually section references in Section 2 are enough)

**Example:**

```markdown
## References

### Doc Files (Read First)
- `doc/00-README.md` — protocol
- `doc/01-locked-baselines.md` — baseline references
- `doc/02-claude-code-discipline.md` — execution discipline
- `doc/03-refusal-layer.md` — refusal commitments (sections R4, R13)
- `doc/05-conventions.md` — module pattern, error handling, idempotency, audit

### OpenAPI
- `openapi/common.yaml` (sections: paths./consent/grant, schemas.ConsentWriteRequest, 
  schemas.ConsentWriteResponse, schemas.ConsentScopeState)

### Pattern PRs (Read for Reference)
- PR-4: `libs/consent/src/lib/consent.controller.ts` (consent check pattern)
- PR-3: `libs/consent/prisma/schema.prisma` (TalentConsentEvent definition)

### Lead Review Checklist
- `doc/06-lead-review-checklist.md` (Tier 2 checks; this is a non-refusal-relevant 
  endpoint addition)
```

---

## Worked Example — Full Prompt

Here is a complete example following the template:

```markdown
# PR: Implement consent revocation endpoint

## Context

Implement the consent revocation endpoint (`POST /v1/consent/revoke`) that records 
a TalentConsentEvent with action=revoked and triggers downstream invalidation 
(in-flight outreach halt, cache invalidation, outbox event).

Workstream: WS2 — Talent + Consent Core
Milestone: M1 — Consent + Talent Core Operational

Pattern PRs to follow:
- PR-4 (consent check endpoint) — module structure
- PR-5 (consent grant endpoint) — write event pattern, idempotency, response shape

In-flight PRs:
- None at time of writing

## Locked Specs

This PR implements:

- **API Contracts Phase 1 Section 6.4** — POST /v1/consent/revoke endpoint
- **Group 2 Section 2.7** — Revocation propagation model
- **Architecture Section 10.5** — Consent cache invalidation
- **Architecture Section 7.6** — Outbox pattern for cross-service events

OpenAPI schemas (in `openapi/common.yaml`):
- `ConsentWriteRequest` — same shape as grant; action=revoked
- `ConsentWriteResponse` — success response with current_state computation

## Refusal Commitments

This PR touches the consent module. Refusals at risk:

- **R6 (no acting on stale consent):** revocation triggers immediate cache 
  invalidation. Do NOT batch invalidations or defer them.
- **R13 (consent integrity over velocity):** if outbox write fails, the entire 
  transaction must roll back. Do NOT proceed with partial state.

Structural enforcement to preserve:
- Append-only ledger: revocation creates a new TalentConsentEvent with action=revoked, 
  does NOT modify the original grant event.
- In-flight outreach halt: the response includes `in_flight_operations_halted` array; 
  the implementation must actually identify and halt these operations.

Do NOT:
- Mark prior consent events as "deleted" or "invalid"
- Skip the outbox event emission
- Defer cache invalidation

## Acceptance Criteria

### Code
- [ ] `libs/consent/src/lib/consent.controller.ts` — add `revokeConsent` handler
- [ ] `libs/consent/src/lib/consent.service.ts` — add `revoke()` method that:
  - Writes TalentConsentEvent with action=revoked (within transaction)
  - Identifies in-flight engagement operations matching scope
  - Writes outbox event (within same transaction)
  - Returns ConsentWriteResponse with halted operations and updated state
- [ ] `libs/consent/src/lib/consent.repository.ts` — add `createRevokeEvent()` method

### Tests
- [ ] Unit tests covering: successful revoke, revoke with no prior grant (no-op), 
      idempotent retry, transaction rollback on outbox failure
- [ ] Integration test covering successful revoke and verifying:
  - New event in TalentConsentEvent table
  - Outbox event written
  - In-flight operations halted (if any seeded)
- [ ] Pact consumer test in `pact/consumers/portal/src/consent.consumer.test.ts`

### OpenAPI
- [ ] No changes to `openapi/common.yaml` (endpoint already specified)
- [ ] Implementation must match exactly

### CI Checks
- All checks from PR-5 (consent grant), plus:
- [ ] Outbox publisher integration test confirms event emission

### Documentation
- [ ] No `doc/*.md` updates required

## References

### Doc Files (Read First)
- `doc/00-README.md`
- `doc/01-locked-baselines.md`
- `doc/02-claude-code-discipline.md`
- `doc/03-refusal-layer.md` (R6, R13)
- `doc/05-conventions.md` (outbox pattern, transaction boundaries)

### OpenAPI
- `openapi/common.yaml` (`/consent/revoke`, ConsentWriteRequest, ConsentWriteResponse)

### Pattern PRs
- PR-5: consent grant implementation (modules, services, repos, DTOs)
- PR-4: consent check (consent service interface)

### Lead Review Checklist
- `doc/06-lead-review-checklist.md` (Tier 2; refusal-touching due to R6, R13)
```

---

## What This Template Prevents

- **Drift via interpretation:** Claude Code can't infer locked spec because the spec is referenced explicitly
- **Refusal violations:** every prompt explicitly acknowledges or disclaims refusal relevance
- **Pattern divergence:** every prompt cites pattern PRs to mirror
- **Test omission:** acceptance criteria explicitly enumerate test requirements
- **Documentation forgetting:** every prompt declares doc impact (even if "no updates required")

## What This Template Costs

- **Lead Engineer time** to write each prompt (typically 15-30 minutes for substantive PRs)
- **Front-loaded thinking:** decisions get made at prompt-writing time, not during code review

This cost is real but lower than the cost of drift. A 15-minute prompt produces a 30-minute review and clean code. A 5-minute prompt produces a 90-minute review and rework.

---

## When to Deviate

The template is mandatory for development PRs that produce code. It can be relaxed for:

- **Spike PRs** clearly marked as exploratory (must be reverted or productionized)
- **Documentation-only PRs** (only Sections 1, 4, 5 required)
- **Configuration-only PRs** (template can be abbreviated)

For all other PRs, follow the template strictly.

---

## Template Self-Update

When patterns emerge that should be enforced via the prompt template:

1. Update this file
2. Update one or two recent prompts to demonstrate the new requirement
3. Communicate the change to all prompt authors

The template is a living document. It sharpens with use.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
