# Lead Engineer Review Checklist

This document is for Lead Engineers reviewing PRs produced primarily by Claude Code instances. It enumerates what each review must verify, organized by PR type and review depth.

The checklist is operationally precise. A PR cannot merge until the relevant checklist items are explicitly verified.

---

## Review Depth Tiers

Not every PR needs the same depth of review. Triage as follows:

### Tier 1 — Lightweight (5-10 minutes)

**PR types:**
- Utility function additions (no schema or contract impact)
- Logging improvements
- Documentation-only changes
- Test additions for existing functionality
- Dependency upgrades (non-major)
- Generated code (e.g., regenerated TypeScript clients from OpenAPI)

**Verify:**
- [ ] No locked spec is violated
- [ ] No vocabulary drift in identifiers or comments
- [ ] Tests pass
- [ ] No unintended changes to schema files

### Tier 2 — Standard (20-40 minutes)

**PR types:**
- New endpoint implementation (non-refusal-relevant)
- Service-layer business logic
- Database schema additions (non-load-bearing entities)
- Internal module refactoring
- Integration test additions

**Verify:**
- [ ] All Tier 1 checks
- [ ] OpenAPI updated FIRST; implementation matches OpenAPI exactly
- [ ] Pact consumer test exists and passes
- [ ] Idempotency on writes (Idempotency-Key header validation)
- [ ] Consent check on protected actions
- [ ] Error responses use locked envelope from `common.yaml`
- [ ] Audit event emitted for consequential operations
- [ ] Patterns match `05-conventions.md`
- [ ] No pattern divergence from existing similar implementations

### Tier 3 — Deep (60+ minutes)

**PR types:**
- Refusal-relevant code (any from list below)
- Schema modifications (especially shared schemas in `common.yaml`)
- Module boundary changes
- New ingestion adapter
- Architectural decisions (require ADR)

**Verify:**
- [ ] All Tier 2 checks
- [ ] Refusal layer integrity (see "Refusal-Layer Specific Checks" below)
- [ ] Architect review (if module boundary or `common.yaml` change)
- [ ] ADR written and linked from PR (if non-obvious decision)
- [ ] Cross-PR consistency review (does this match the patterns in similar recent PRs?)
- [ ] CI scripts run locally and pass

---

## Refusal-Layer Specific Checks

When a PR touches any of the following surfaces, it is **automatically Tier 3** and requires explicit refusal verification:

### Trigger surfaces

- Any change to a Portal response schema
- Any change to `ExaminationOverride` mechanism
- Any change to `SubmittalConfirm` flow
- Any change to a closed enum (SourceType, AdapterType, ConsentScope, EvidenceEntityType, ExaminationTier, AstreImportSourceChannel)
- Any change to `additionalProperties: false` on any schema
- Any change to `const: true` or `const: false` constraints
- Any change to attestation requirements
- Any change to LinkedIn-related code paths (even apparently unrelated)
- Any change to `verify-portal-refusal.ts`, `verify-ats-refusal.ts`, or other refusal CI scripts

### Refusal verification checks

For each of the 13 Charter refusals (R1-R13 in `03-refusal-layer.md`), verify the PR does not violate it:

#### Scope Refusals

- [ ] **R1:** Does the PR add a job marketplace, listing, or board feature? If yes → REJECT
- [ ] **R2:** Does the PR add a free-form Talent search or bulk export? If yes → REJECT
- [ ] **R3:** Does the PR add candidate-facing job recommendations or feeds? If yes → REJECT

#### Behavior Refusals

- [ ] **R4:** Does the PR infer consent from any source other than the consent ledger? If yes → REJECT
- [ ] **R5:** Does consent computation use union (ANY) instead of intersection (ALL)? If yes → REJECT
- [ ] **R6:** Does the PR allow stale consent to authorize high-impact actions? If yes → REJECT
- [ ] **R7:** Does the PR add LinkedIn anywhere? Adapter, source type, ingestion path? If yes → ESCALATE TO ARCHITECT (Charter-level approval required)
- [ ] **R8:** Does the PR mutate `TalentJobExamination.tier` after creation? Even indirectly? If yes → REJECT
- [ ] **R9:** Does the PR allow Stretch-tier submittal through any code path? If yes → REJECT
- [ ] **R10:** Does the PR add any of the 13 forbidden fields to a Portal response? If yes → REJECT

#### Posture Refusals

- [ ] **R11:** Does the PR include any "fast path" or "high priority" bypass of consent? If yes → REJECT
- [ ] **R12:** Does the PR introduce automated submittal? Cron jobs? Auto-confirm? If yes → REJECT
- [ ] **R13:** Does the consent check timeout behavior fail open (return allowed)? If yes → REJECT

### Schema-level refusal checks

- [ ] If schema change touches `additionalProperties`, is `false` preserved?
- [ ] If schema change touches a `const` constraint, is the const preserved?
- [ ] If enum is touched, is the closed list preserved? Are no new values added?
- [ ] If Portal schema is touched, do all 13 forbidden fields remain absent?
- [ ] Does CI `verify-portal-refusal.ts` pass?
- [ ] Does CI `verify-ats-refusal.ts` pass?

### Pact verification for refusal-relevant changes

If the PR touches a refusal-relevant code path, a corresponding Pact test must exist or be added that verifies the refusal at runtime.

Reference Pact tests in `pact/consumers/`:
- `ats-thin/src/submittals.consumer.test.ts` (Stretch blocking)
- `ats-thin/src/overrides.consumer.test.ts` (`examination_mutated: false`)
- `portal/src/engagements.consumer.test.ts` (forbidden fields)
- `ingestion-adapters/indeed/src/linkedin-rejection.consumer.test.ts` (LinkedIn refusal)

---

## Cross-PR Consistency Review

This is a Lead Engineer responsibility unique to the Claude Code team model. Individual PRs may pass review but produce inconsistency in aggregate.

### Weekly cross-PR review

Once per week, scan recently merged PRs for:

- [ ] **Pattern divergence:** Are similar problems solved similarly across modules?
- [ ] **Vocabulary drift:** Are the locked terms used consistently?
- [ ] **Error envelope discipline:** Do all errors return the locked envelope?
- [ ] **Idempotency discipline:** Do all writes require Idempotency-Key?
- [ ] **Audit discipline:** Do all consequential operations emit events?

When divergence is found:

1. Refactor outliers to match the canonical pattern
2. Update `05-conventions.md` with the canonical pattern explicit
3. Update prompt templates to reference the pattern
4. Note the incident in Architect review

### Per-PR consistency check

For each substantive PR, ask:

- [ ] Does this PR follow patterns established in similar recent PRs?
- [ ] If this PR establishes a new pattern, is the pattern documented in `05-conventions.md`?
- [ ] Could a future Claude Code instance reading this PR reproduce the pattern?

---

## OpenAPI Discipline Checks

Every PR that touches an endpoint:

- [ ] OpenAPI updated FIRST (verify by checking PR commits — was OpenAPI commit before implementation commit?)
- [ ] OpenAPI validates: `swagger-cli validate openapi/<file>.yaml`
- [ ] OpenAPI lints clean: `redocly lint openapi/<file>.yaml`
- [ ] Endpoint matches OpenAPI exactly (request schema, response schema, error responses, status codes)
- [ ] `additionalProperties: false` on all object schemas
- [ ] `operationId` present and follows naming convention (`camelCase`)
- [ ] `tags` present and matches the API group
- [ ] Description present (not just summary) on consequential endpoints

---

## Pact Test Discipline Checks

Every PR that touches an endpoint:

- [ ] Pact consumer test exists in correct location (`pact/consumers/{consumer}/src/{domain}.consumer.test.ts`)
- [ ] Test exercises happy path
- [ ] Test exercises at least one error path (validation, consent, conflict)
- [ ] If refusal-relevant, refusal verification test exists
- [ ] Provider state is named in `state-handlers.ts` (or TODO with explicit reason)
- [ ] Test passes locally before merge

---

## Database Discipline Checks

For PRs that touch Prisma schema:

- [ ] `tenant_id` present on all tenant-scoped tables
- [ ] `created_at` and `updated_at` present (except event tables)
- [ ] Schema-per-module: model declares correct `@@schema(...)`
- [ ] Cross-schema references are UUID-only, no FK constraints
- [ ] Indexes appropriate for query patterns
- [ ] Migration file generated and reviewed
- [ ] Migration is forward-compatible with running services
- [ ] No data deletion in migration without explicit Architect approval

---

## CI Gate Verification

Before marking a PR approved:

- [ ] `openapi:validate` passes
- [ ] `openapi:lint` passes
- [ ] `openapi:drift-check` passes
- [ ] `portal:refusal-check` passes
- [ ] `ats:refusal-check` passes
- [ ] `version:sync-check` passes
- [ ] `error-codes:check` passes
- [ ] `pact:consumer` passes
- [ ] `pact:provider` passes (or noted reason if state handler not yet implemented)
- [ ] `tests:unit` passes
- [ ] `tests:integration` passes
- [ ] `lint:nx-boundaries` passes
- [ ] No CI checks bypassed without `contract-update-approved` label

---

## Stop-the-Line Criteria

If any of these conditions occur, **stop merging PRs and convene Architect + Leads:**

- A refusal layer violation made it past initial review
- A merged PR breaks a CI gate that was passing pre-merge
- A schema-level constraint (`const`, `additionalProperties`) was relaxed
- A closed enum was extended without explicit Architect approval
- A LinkedIn-related code path appears anywhere
- Cross-PR review reveals systemic pattern divergence

Stop-the-line means: no new merges until the issue is understood and remediation is agreed.

---

## When to Escalate to Architect

Lead Engineers handle most PRs. Escalate to Architect when:

- A refusal layer change is genuinely needed (extremely rare; requires Charter-level review)
- A change to `common.yaml` shared schemas
- A new module is being added
- Module boundary changes
- Non-trivial migration with potential data loss
- A pattern divergence is intentional and the convention should change
- Repeated drift incidents from the same Claude Code prompt template

---

## When to Escalate to PO

PO involvement when:

- A user-facing behavior is being added that may affect product positioning
- A refusal seems to conflict with a real user need
- A new Portal endpoint or feature is being added
- An attestation language change is proposed

---

## Bandwidth Realities

A Lead Engineer cannot review every PR with full Tier 3 depth. Realistic capacity:

- 4-8 Tier 1 PRs per day
- 2-4 Tier 2 PRs per day
- 1-2 Tier 3 PRs per day

If PR queue exceeds capacity, options in order of preference:

1. Triage queue: handle Tier 1 quickly to clear; focus deep review on Tier 3
2. Distribute load across Lead Engineers
3. Slow Claude Code production rate temporarily
4. Pause new PR generation until queue clears

**Never:** Approve at lower depth than the PR warrants.

---

## Documentation of Review

Each PR must include a review summary in the PR description after approval:

```
## Lead Review Summary

Reviewer: [Lead Engineer name]
Tier: [1 | 2 | 3]
Refusal-relevant: [yes | no]
Pattern consistency: [matches | divergent — justified | divergent — refactor needed]
ADR linked: [yes | no | n/a]

Notes: ...
```

This creates an audit trail for review depth and helps Architect spot patterns over time.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
