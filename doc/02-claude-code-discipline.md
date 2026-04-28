# Claude Code Execution Discipline

This document defines how Claude Code instances work in the Aramo program. It is mandatory reading for every PR.

The Aramo program produces software primarily through Claude Code instances reviewed by Lead Engineers. The discipline below is what makes this team model viable. Without it, parallel work streams drift, refusals erode silently, and the codebase becomes incoherent.

---

## Core Discipline Rules

### Rule 1 — No code without prompt context

Every Claude Code session that produces code must begin with explicit reading of:

- The PR's locked specs (Charter / Group 2 / Architecture / API Contracts sections)
- Relevant `doc/*.md` files (this folder)
- Any pattern PRs the current PR must follow

If the prompt does not specify these, **stop and ask the Lead Engineer.** Do not infer context.

### Rule 2 — No API without OpenAPI first

For any PR that adds, changes, or removes an endpoint:

1. Update the relevant `openapi/*.yaml` file FIRST
2. Validate with `swagger-cli validate openapi/<file>.yaml`
3. Then implement the endpoint to match
4. Add Pact consumer test
5. Verify with `pact:consumer` run

**Anti-pattern:** Implementing the endpoint, then back-filling OpenAPI to match. This produces code that drifts from the contract.

### Rule 3 — No schema without `additionalProperties: false`

Every object schema in any OpenAPI file must include `additionalProperties: false`.

This is not a Portal-only rule. It applies universally. The Portal-specific refusal layer adds *forbidden field enumeration*; the universal rule prevents accidental field accumulation.

**Verify with:** `verify-portal-refusal.ts` (Portal) and equivalent checks (other files)

### Rule 4 — No refusal layer modification without escalation

If a PR touches any of these surfaces, **stop and request Lead/Architect review before generating code:**

- Adding fields to Portal response schemas
- Modifying `examination_mutated`, `linkedin_automation_allowed`, or any `const: true/false` schema constraint
- Adding or modifying values in closed enums (SourceType, AdapterType, ConsentScope, EvidenceEntityType, ExaminationTier, AstreImportSourceChannel, ConsentDecisionResult)
- Removing the three RecruiterAttestations or changing their `const: true` constraints
- Changing the SubmittalConfirmRequest validation rules
- Modifying Override response handling

These are **load-bearing refusals** specified in `03-refusal-layer.md`. They are not engineering decisions; they are program commitments.

### Rule 5 — Vocabulary discipline

Use Aramo-locked vocabulary exclusively:

| Use | Not |
|---|---|
| Talent | Candidate |
| `talent_id` | `candidate_id` |
| Engagement | Outreach (when referring to entity) |
| Examination | Evaluation |
| Submittal | Submission |
| Tenant | Customer / Account / Org |
| Entrustable / Worth Considering / Stretch | High / Medium / Low |
| Recruiter | User (when referring to recruiter specifically) |

**Anti-pattern:** Using "candidate" because it's familiar. Other systems use "candidate." Aramo uses "Talent."

### Rule 6 — Pattern consistency across PRs

When implementing new code, **first check existing similar implementations** and follow their patterns. Common patterns to preserve:

- Module structure (consent module shape is the reference for other modules)
- Error handling (use `ErrorResponse` from common.yaml; throw structured errors, not strings)
- Idempotency (use `Idempotency-Key` header; check before write; return original response on replay)
- Transaction boundaries (write to DB + outbox in same transaction)
- Audit logging (every consequential operation emits a `TalentEvent` or equivalent)

**If you don't see an existing pattern, check `doc/05-conventions.md`.** If still unclear, **stop and ask.**

### Rule 7 — When uncertain, refuse

If you encounter ambiguity that would require interpretation of locked specs, **stop and ask the Lead Engineer.** Do not:

- Guess at intent
- "Make it work" by inferring
- Add a TODO and continue
- Pick the easier interpretation

The Aramo program's discipline depends on this. A Claude Code instance that interprets ambiguity produces drift. A Claude Code instance that asks produces escalation, which produces clarification, which produces a sharpened spec.

---

## What "Drift" Means

Drift is when implementation diverges from locked specs in ways that compound over time. It happens through small, individually-reasonable decisions that aggregate into incoherence.

**Examples of drift:**

- Adding a `score` field to a response schema "because it would be useful" (violates Charter refusal)
- Using `candidate_id` instead of `talent_id` "because it's clearer" (violates vocabulary)
- Implementing a new endpoint without updating OpenAPI "because it's just a small change" (violates contract-first)
- Adding `additionalProperties: true` to a schema "because the model has dynamic fields" (violates universal rule)
- Returning raw scoring weights "because debugging requires it" (violates the no-raw-scores refusal)

**Drift is the failure mode the program is designed to prevent.** The CI gates, Lead reviews, and `doc/` folder all exist to catch drift before it compounds.

---

## How to Communicate Uncertainty

When you encounter something the locked specs don't cover, communicate it explicitly in the PR description, not by making a unilateral decision.

**Template:**

```
## Uncertainty Found

While implementing X, I encountered ambiguity in [spec section reference].

The spec says: [exact quote].

Two reasonable interpretations:
1. [Interpretation A]
2. [Interpretation B]

I implemented [A | B] because [reason]. Lead Engineer should verify this matches intent.
```

This makes the assumption visible in the PR review. Lead Engineer can correct if wrong.

**Anti-pattern:** Adding a TODO comment in code that gets buried.

---

## Discipline Around Tests

Every PR must include:

- **Unit tests** for new logic (Vitest)
- **Integration tests** for new endpoints (Vitest + Testcontainers)
- **Pact consumer test** for new endpoint behavior (consumer-side contract)
- **Refusal verification test** if the PR touches refusal-relevant code

The refusal verification test is non-negotiable for refusal-relevant PRs. Examples:

- PR adds a Portal field → test verifies forbidden fields still absent
- PR modifies override → test verifies `examination_mutated: false` returned
- PR changes ingestion → test verifies LinkedIn rejection still triggers PROHIBITED_LINKEDIN_AUTOMATION

If the PR touches refusal surfaces and no refusal test exists, **the PR is incomplete.**

---

## What Claude Code Cannot Do

These are explicitly outside Claude Code's authority. Stop and request human action:

- Approve a deviation from locked specs (Lead/Architect only)
- Add a new value to a closed enum (Architect only, after change-control review)
- Modify the refusal layer (PO + Architect + BA approval required per Charter)
- Skip a CI check that's failing (Lead Engineer must resolve, not bypass)
- Merge a PR (Lead Engineer responsibility)
- Decide deployment readiness (CI gates determine this; Lead Engineer reviews)

If a prompt asks Claude Code to do any of these, **stop and refuse, explaining why.**

---

## What Lead Engineers Do With Claude Code Output

Lead Engineers verify the disciplines above hold. Specifically:

- **Per-PR review:** correctness, completeness, refusal preservation, OpenAPI alignment, test coverage
- **Cross-PR review:** pattern consistency, vocabulary consistency, no duplicated logic
- **Refusal layer audit:** does this PR touch a refusal surface? If so, is the refusal still enforced?

Claude Code produces; Lead Engineers verify discipline. This is the team model.

If a Claude Code PR is rejected for discipline violation, the prompt that produced it is at fault. Update the prompt template (`07-prompt-template.md`) to prevent recurrence.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
