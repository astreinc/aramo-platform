# Risks Specific to the Aramo Team Model

This document names the failure modes that are most likely in a program built primarily by Claude Code under Lead Engineer review. Each risk is paired with mitigations Claude Code instances should be aware of.

These risks are not theoretical. They are patterns observed in programs that use AI-assisted development at scale. Naming them explicitly is what prevents them.

---

## Risk Categories

1. **Drift risks** — implementation diverges from locked specs
2. **Refusal layer risks** — Charter commitments erode silently
3. **Coordination risks** — parallel Claude Code work streams produce inconsistency
4. **Context risks** — information loss across PRs
5. **Velocity risks** — speed at the cost of quality

---

## Drift Risks

### D1 — Specification interpretation drift

**The risk:** Locked specs occasionally contain ambiguity. A Claude Code instance asked to implement the ambiguous section will pick an interpretation. Without explicit escalation, that interpretation becomes de facto truth.

**Mitigations:**
- Rule 7 in `02-claude-code-discipline.md`: when uncertain, refuse and escalate
- Lead Engineer review specifically checks "did the implementation make a unilateral interpretation?"
- Ambiguities discovered should be resolved in the spec (via change control), not in code

**Example:** "Group 2 v2.4 says examination is immutable, but doesn't specify what happens to the original snapshot when examination is recomputed." Two interpretations possible (preserve all snapshots vs preserve only most recent). Don't pick one. Escalate.

### D2 — OpenAPI-implementation drift

**The risk:** OpenAPI says one thing, implementation does another. Tests pass because tests were written from the implementation, not the OpenAPI.

**Mitigations:**
- Rule 2: OpenAPI updated FIRST, implementation matches
- Pact consumer test written from OpenAPI, not from implementation
- `compare-spec-to-openapi.ts` CI script compares locked spec vs OpenAPI
- Lead review verifies: did OpenAPI change in this PR? If endpoint changed, OpenAPI must change too.

**Anti-pattern:** "I'll update the OpenAPI later." There is no later. Update first.

### D3 — Vocabulary drift

**The risk:** Claude Code instances use familiar terminology ("candidate" instead of "Talent"). Subtle vocabulary drift accumulates and the codebase becomes confusing.

**Mitigations:**
- Rule 5: explicit vocabulary table in `02-claude-code-discipline.md`
- Lead review checks every new file for vocabulary discipline
- Linter rules (where feasible) flag forbidden terms in identifiers and comments

**Why this matters:** Aramo's vocabulary is locked across 15+ documents. Drift creates confusion across the codebase that compounds invisibly.

### D4 — Pattern drift

**The risk:** Each Claude Code instance picks a slightly different pattern for similar problems. Eight instances produce eight variations of how to handle errors, idempotency, audit logging.

**Mitigations:**
- `05-conventions.md` enumerates the canonical patterns
- Every PR prompt references which patterns it must follow
- Lead Engineers do explicit cross-PR consistency review
- Refactor opportunities: when drift is discovered, sharpen the convention doc and refactor outliers

---

## Refusal Layer Risks

### RL1 — "Helpful" feature requests that violate refusals

**The risk:** Users (recruiters, hiring managers, candidates) will ask for features that seem helpful but violate Charter refusals. Examples:
- "Show recruiters the score so they understand ranking"
- "Let candidates see why they weren't chosen"
- "Add LinkedIn ingestion for our enterprise tier"

A Claude Code instance asked to implement these will succeed at producing technically-correct code.

**Mitigations:**
- `03-refusal-layer.md` enumerates all refusals with anti-patterns
- Rule 4: refusal-touching PRs require escalation before generation
- Lead Engineer review specifically checks refusal preservation
- CI scripts (`verify-portal-refusal.ts`, `verify-ats-refusal.ts`) catch obvious violations

**The deeper issue:** Claude Code instances are trained to be helpful. The Aramo program's refusal layer is what makes it distinctive. There's structural tension between AI helpfulness and program discipline. The mitigation is explicit awareness, not "Claude Code will figure it out."

### RL2 — Schema-level refusals being silently relaxed

**The risk:** A schema has `additionalProperties: false` or `const: true`. A Claude Code instance refactoring it doesn't know these are load-bearing and removes them as "boilerplate."

**Mitigations:**
- `03-refusal-layer.md` lists every `const` constraint and what it enforces
- CI checks (`verify-portal-refusal.ts` etc.) fail builds on relaxation
- Lead review checks schema diffs for `additionalProperties` removal

**Specific schemas to never relax:**
- `RecruiterAttestations.*: const: true` (three attestations)
- `ExaminationOverrideResponse.examination_mutated: const: false`
- `SourcePolicyResponse.linkedin_automation_allowed: const: false`
- `PortalRtbfConfirmRequest.confirmation_text: const: "DELETE MY DATA"`
- All `additionalProperties: false` on every object schema

### RL3 — Forbidden field accumulation in Portal

**The risk:** Each Portal PR adds one "harmless" field to a Portal response. Each looks reasonable in isolation. Cumulatively, the Portal projection drifts toward exposing examination data.

**Mitigations:**
- `verify-portal-refusal.ts` checks every Portal schema against the 13 forbidden fields list on every CI run
- `additionalProperties: false` prevents accidental field accumulation (any added field is explicit)
- Lead review specifically asks: does this PR add a field to a Portal response? If yes, why?

### RL4 — Override mechanism creep

**The risk:** Override functionality is asked to do more over time. "Can the override also notify the candidate?" "Can the override actually update the engagement state?" Each addition seems reasonable.

**Mitigations:**
- `examination_mutated: const: false` is non-negotiable
- Override is recording-only, never mutating
- Lead review on any override-touching PR verifies this

---

## Coordination Risks

### C1 — Concurrent Claude Code instances making divergent decisions

**The risk:** Two PRs in flight simultaneously implement similar functionality differently because the Claude Code instances had no way to know about each other's work.

**Mitigations:**
- `doc/05-conventions.md` enumerates patterns to prevent independent reinvention
- PR prompts reference pattern PRs the new PR must follow
- Lead Engineers maintain awareness of in-flight PRs and flag conflicts during review
- Cross-PR review (Lead Engineer responsibility) catches divergence

### C2 — Pattern divergence across modules

**The risk:** Consent module uses pattern X for error handling. Matching module uses pattern Y. Both are reasonable; together they're inconsistent.

**Mitigations:**
- First PR for each pattern (error handling, idempotency, audit logging) becomes the reference
- Reference is documented in `05-conventions.md`
- Subsequent PRs read the convention doc; Lead reviews enforce it

### C3 — Schema conflict at integration time

**The risk:** Two PRs add fields to the same shared schema (e.g., a common type in `common.yaml`). Both pass individual review; merging causes conflicts.

**Mitigations:**
- `common.yaml` is owned by Architect; PRs that touch it require Architect review
- Schema changes are sequenced, not parallelized
- The `compare-spec-to-openapi.ts` drift script catches schema conflicts at CI

---

## Context Risks

### CX1 — Claude Code instance loses context across PRs

**The risk:** A Claude Code instance starting PR-47 has no memory of PR-23's decisions. If PR-47 depends on PR-23's pattern, that dependency must be communicated explicitly.

**Mitigations:**
- This `doc/` folder IS the long-term memory
- PR prompts reference relevant doc files
- Pattern PRs are documented in `05-conventions.md` so subsequent PRs can follow them
- Decision logs (forthcoming) will track rationale for non-obvious decisions

### CX2 — Architectural rationale is forgotten

**The risk:** Six months in, a Claude Code instance asked to refactor doesn't know why a particular structure exists. It "simplifies" something that was load-bearing.

**Mitigations:**
- Charter, Architecture, and API Contracts documents preserve rationale
- ADRs (Architecture Decision Records) document non-obvious decisions
- Refactoring PRs require Architect review; Architect verifies rationale is preserved

**Specific patterns to never refactor without Architect approval:**
- The hybrid architecture (modular monolith + extracted services)
- The outbox pattern for async events
- Schema-per-module data architecture
- The consent ledger immutability
- The TalentJobExamination immutability
- The Indeed three-step economic model

### CX3 — Lead Engineer turnover

**The risk:** A Lead Engineer leaves. New Lead inherits the program without the context of why decisions were made.

**Mitigations:**
- This `doc/` folder is part of the onboarding for new Lead Engineers
- Decision logs track rationale
- Architect serves as continuity across Lead Engineer changes

---

## Velocity Risks

### V1 — Lead Engineer review bottleneck

**The risk:** 8 Claude Code instances produce code faster than 3-4 Lead Engineers can review carefully. Either reviews become superficial (drift accumulates) or PRs queue (program stalls).

**Mitigations:**
- `06-lead-review-checklist.md` triages PR types into review-depth tiers
- Lightweight PRs (utility functions, generated boilerplate) get fast review
- Substantive PRs (new endpoints, schema changes, refusal-relevant code) get deep review
- Architectural PRs get Architect-level review

### V2 — "Good enough for now" tech debt

**The risk:** A PR is approved with a known issue ("we'll fix the tests later"). The fix never happens.

**Mitigations:**
- `08-definition-of-done.md` (forthcoming) is non-negotiable
- "Later" is not a valid commitment; either the work is done or the PR is incomplete
- Tech debt items go on the explicit deferred-work list, not into PR comments

### V3 — Skipping CI checks under pressure

**The risk:** A CI check fails for a non-obvious reason. Pressure to ship overrides the discipline. The check is bypassed or disabled "temporarily."

**Mitigations:**
- CI checks are not bypassable except by explicit override label (`contract-update-approved`)
- Override label allows merge but never deployment (Phase 6 lock)
- Failed CI checks are investigated, not bypassed

---

## Risks Specific to Concurrent Multi-Instance Execution

### MI1 — Eight Claude Code instances asking subtly different questions

**The risk:** Each instance reads the same locked spec but asks different questions of it. They produce eight variations of the same conceptual code.

**Mitigations:**
- Consolidated convention docs prevent independent invention
- First PR for each pattern is the reference
- Refactor outliers when discovered

### MI2 — Race conditions in shared resource modification

**The risk:** Two Claude Code instances simultaneously modify `common.yaml` or `package.json` or a shared module. Their PRs both pass individual CI but fail to merge cleanly.

**Mitigations:**
- Shared resources have Architect-level ownership; modifications are serialized
- Lead Engineers coordinate when shared resources are in flight
- Merge conflicts at CI are taken seriously (signal of coordination failure)

### MI3 — "Aggregate Pattern Decay"

**The risk:** Individual PRs each look fine. Aggregate codebase quality decays because no instance is responsible for the whole.

**Mitigations:**
- Cross-PR review is a named Lead Engineer responsibility
- Architect does periodic codebase audits (quarterly)
- Refusal layer CI checks run on every build to catch aggregate drift in refusal preservation

---

## When to Update This File

Add new risks when:

- A drift incident occurs (PR almost merged with a refusal violation)
- A pattern divergence is discovered after the fact
- Lead Engineer review catches a category of issue that recurs
- A refusal needs additional code-level guidance

Each new risk should follow the format: name, description of the failure mode, mitigations.

Do not update this file when:

- A specific PR has a unique problem (handle in PR comments)
- Documenting an experiment

---

## Risk Severity (For Triage)

When evaluating whether a PR has a problem, use this severity:

**Critical (block merge):**
- Refusal layer violation (any of R1-R13)
- Schema relaxation (`const`, `additionalProperties`)
- Bypass of CI checks
- LinkedIn-related code path

**High (require fix):**
- Vocabulary drift in user-facing API surface
- OpenAPI-implementation mismatch
- Missing Pact test on new endpoint

**Medium (sharpen and merge):**
- Pattern divergence from existing module
- Verbose or unclear code
- Missing ADR for non-obvious decision

**Low (note for follow-up):**
- Style inconsistency
- Suboptimal naming (when not in API surface)
- Test coverage below target but above threshold

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
