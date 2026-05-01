# ADR-0006: Consent Check Contract & Resolver Path Conventions

**Status:** Accepted

**Date:** 2026-05-01

---

## Context

PR-4 (`feat: PR-4 consent check endpoint + resolver path + policy engine`, source commit `bf56f9f`, fix-up `7c4ed9c`, merged as `9c987ca`) implemented `POST /v1/consent/check` and introduced the **resolver-path operation class** as a distinct category alongside the write path established by PR-2 and PR-3. API Contracts Phase 1 §6 enumerated the endpoint and Group 2 §2.7 specified the consent semantics; PR-4 committed the program to specific contract decisions (response shape, request shape, operation→scope mapping, multi-source derivation, dependency validation, staleness, channel constraints, decision logging, HTTP semantics, partial-consent posture, right-to-be-forgotten handling, R4 enforcement), three implementation precedents that surfaced during execution (deferred-throw, channel-permission metadata convention, R4 region-marker enforcement), and one process precedent that surfaced during the commit cycle (local pre-commit sweep must include `nx build`).

ADR-0006 lifts these decisions into `doc/adr/` as program doctrine before PR-5 (consent state read) and PR-6 (consent history read) ship and inherit them. PR-5 reuses the `resolveConsentState` seam; ADR-0006 establishes the conventions that govern every subsequent consent-resolver call site. The 16 items captured here are the largest precedent surface yet documented in a single ADR, reflecting that PR-4 is the program's first **policy engine**: it combines enforcement-point operation→scope mapping, scope dependency validation, source-aware multi-event derivation, temporal logic (12-month staleness for contacting), channel constraint validation, and decision logging — all in one transactional operation. Per `doc/04-risks.md` CX2, this ADR is the rationale-recovery anchor before the precedent quietly drifts; per D4, it locks the pattern before parallel resolver-path PRs invent variants. The retroactive-ADR pattern (ADR-0001 captured PR-1, ADR-0003 captured PR-2, ADR-0004 captured PR-2.2, ADR-0005 captured PR-3, ADR-0006 captures PR-4) is the program's idiom for documenting precedent after a precedent-setting PR merges.

---

## Decision

The canonical consent check contract and resolver-path conventions consist of sixteen items grouped into three sections: twelve Lead-locked contract decisions (A–L), three implementation precedents that surfaced during PR-4 execution (M, N, O), and one process precedent that surfaced during the PR-4 commit cycle (P). PR-4 implements all sixteen; future PRs reference this ADR.

### Contract Decisions

#### Decision A — Response shape: canonical `ConsentDecision`

**What.** `POST /v1/consent/check` returns the spec-locked `ConsentDecision` schema from API Contracts Phase 1 §1 lines 469-489. Fields: `result` (allowed | denied | error), `scope`, `denied_scopes`, `reason_code`, `display_message`, `log_message`, `decision_id`, `computed_at`. No `is_stale` boolean. For HTTP 4xx responses (e.g., 422 INVALID_SCOPE_COMBINATION), the `ConsentDecision` is embedded inside `error.details.consent_decision` per the Phase 1 §1 canonical envelope embedding pattern (lines 338-381).

**Why.** The spec is the authority; the response shape was defined before PR-4 in Phase 1 §1. PR-4's contribution is the implementation that returns this shape, not a new response model. The 4xx envelope embedding preserves the structured-error contract and avoids special-case parsing on the consumer side.

#### Decision B — Request shape: `talent_id` + `operation` + conditional `channel`

**What.** `ConsentCheckRequest` carries `talent_id`, `operation`, and `channel`. `channel` is required only when the derived scope is `contacting`; absent or rejected for other operations. `tenant_id` is NOT a request body field — per Phase 1 §1 line 246-248, tenant context is resolved from the JWT.

**Why.** The resolver answers enforcement-driven questions ("can this operation proceed for this talent?"), not abstract scope questions. `operation` is the natural input; the resolver derives `scope` from it via Decision C. `channel` is a sub-dimension of contacting scope per the ContactChannel enum (Phase 1 §1 lines 402-404, landed in PR-3.2), which is why it is request-required only when contacting.

#### Decision C — Operation→scope mapping

**What.** A 7-row constant table maps operations to required scopes:

| Operation     | Required Scope            |
|---------------|---------------------------|
| `ingestion`   | `profile_storage`         |
| `matching`    | `matching`                |
| `examination` | `matching`                |
| `engagement`  | `contacting`              |
| `packaging`   | `contacting`              |
| `submittal`   | `contacting`              |
| `cross_tenant`| `cross_tenant_visibility` |

**Why.** Mapping derived from Group 2 §2.7 Enforcement Points table (lines 2372-2386). Implemented as a constant lookup, not runtime derivation, so adding operations is an explicit Architect-reviewed change per Rule 4.

**`resume_processing` excluded.** §2.7 maps `resume_processing` to ingestion-time parsing, not /consent/check time. The operation→scope mapping omits it because no /consent/check operation reaches resume_processing scope.

#### Decision D — Source-aware most-restrictive intersection

**What.** Resolver derivation algorithm:

1. Partition `TalentConsentEvent` rows for `(talent_id, tenant_id, scope)` by `captured_method` (the ConsentCapturedMethod enum: `self_signup`, `recruiter_capture`, `upload_flow`, `import`).
2. Within each partition, take the latest event by `occurred_at`.
3. Across partitions, apply most-restrictive: any source's latest event being `revoked` or `expired` produces a denied result.

**Why.** Group 2 §2.7 Multi-Source Conflict Resolution (lines 2411-2422) mandates "the most restrictive applicable consent governs all actions." The Counterintuitive Example (Indeed source restricts contacting + talent-direct self-signup grants full → contacting remains restricted) is the canonical case the resolver must produce correctly.

**NOT global latest-wins.** Multiple grants from different sources can coexist; a single revocation from any source produces denied. The latest-per-partition step happens within source, then most-restrictive applies across sources.

#### Decision E — Scope dependency validation

**What.** Pre-check before evaluating consent state for the requested scope:

- `contacting` requires `matching` requires `profile_storage`
- `cross_tenant_visibility` requires all lower scopes
- `resume_processing` is independent

Failure returns HTTP 422 with `code: "INVALID_SCOPE_COMBINATION"` (the error code added to the `ErrorCode` enum in PR-3.2) and `error.details.consent_decision` populated with the failing scope(s) in `denied_scopes` and `reason_code: "scope_dependency_unmet"`.

**Why.** Group 2 §2.7 Scope Dependencies (lines 2352-2360) requires dependency validation at update time and at runtime check time. Validation runs before Decision D's most-restrictive computation because dependency violations are deterministic from request shape alone; running the more expensive multi-source partition first would waste work for an inevitable 422.

#### Decision F — Staleness: 12-month rule, contacting only

**What.** After Decision D produces an allowed state for `contacting` scope, find the latest `granted` event for contacting across all sources for `(talent_id, tenant_id)`. If `now - occurred_at > 12 months`, return denied with:

- `reason_code: "stale_consent"`
- `display_message: "Consent has expired. Refresh required."` (per §2.7 line 2535)
- `denied_scopes: ["contacting"]`

**Why.** Group 2 §2.7 Stale Consent (lines 2424-2447): "Consent becomes stale for contacting after 12 months without engagement." Spec mandates the 12-month window and the contacting-only scope.

**Engagement-reset semantic deferred.** §2.7 lines 2437-2442 specify that talent response, talent-initiated interaction, and explicit re-consent reset the 12-month clock. PR-4 cannot implement this because engagement entities don't exist yet. The simple 12-months-since-latest-grant check is what ships. A future PR adding engagement-reset must update both the resolver logic and this ADR (likely as a small amendment or superseding ADR).

**Other scopes.** Staleness does NOT apply to `profile_storage`, `resume_processing`, `matching`, or `cross_tenant_visibility`. The resolver returns the most-restrictive computation result without a staleness check for those scopes.

#### Decision G — Channel constraint for contacting

**What.** Class-validator conditionally requires `channel` when operation maps to contacting scope; absent or rejected for other operations. Channel-specific consent is checked via intersection across latest-per-source grants (per Precedent N's metadata convention). Channel not permitted → denied with `reason_code: "channel_not_consented"`. Missing required channel → 400 `VALIDATION_ERROR` with `details.missing_field: "channel"`.

**Why.** Group 2 §2.7 contacting scope semantics (lines 2336-2344) permit initiating engagement via consented channels and prohibit contacting via unconsented channels. Phase 1 §6 Processing Rules step 5 mandates: "Apply channel constraints when scope is contacting."

**`channel` references PR-3.2's `ContactChannel`.** The OpenAPI schema is referenced via `$ref`, not redefined. PR-3.2 landed the `ContactChannel` schema with the 6 locked values (`email | phone | sms | indeed | portal | other`); PR-4's `ConsentCheckRequest` uses `$ref: '#/components/schemas/ContactChannel'`.

#### Decision H — Decision logging via ConsentAuditEvent reuse

**What.** Every /consent/check call generates a UUID v7 `decision_id`, returns it in the `ConsentDecision` response, and persists a `ConsentAuditEvent` row with `event_type: "consent.check.decision"` inside the same transaction as the resolver computation. The audit `event_payload` carries the full ConsentDecision shape plus operation, channel (when applicable), and tenant_id context.

**Why.** Phase 1 §6 Processing Rules step 7 requires "Log consent decision with decision_id." Reuse of `ConsentAuditEvent` (rather than introducing a new `ConsentDecisionLog` model) is locked here. The existing audit infrastructure (audit schema, `event_type` as a string discriminator, `event_payload` as Json) is sufficient — no new Prisma model in PR-4.

**Audit row written for every result.** `allowed`, `denied`, and `error` all generate audit rows. No "denial-only" optimization. Every check is auditable, satisfying §2.7's Load-Bearing Principles intent of not relying on engagement signals to derive consent integrity.

#### Decision I — HTTP semantics

**What.** Response code mapping:

| HTTP code | Used for                                           |
|-----------|----------------------------------------------------|
| 200       | `result: "allowed"`, `"denied"`, or `"error"`      |
| 400       | Request body validation (e.g., missing channel)    |
| 401       | Auth missing or invalid                            |
| 403       | Caller-blocked (tenant access denial)              |
| 422       | INVALID_SCOPE_COMBINATION (dependency unmet)       |
| 500       | System error (unexpected resolver failure)         |

**Why.** §2.7 HTTP Mapping (lines 2559-2567) plus Phase 1 §1 envelope patterns. 403 is NOT used for consent denial; consent denial is HTTP 200 with `result: "denied"`. This preserves the "consent decision is data, not error" semantic and matches the Phase 1 §6 Consent Failure Mode Locked stance: Aramo fails safe, never open — a system error returns 500 INTERNAL_ERROR, never `result: "allowed"` as a fallback.

**200 for `result: "error"`.** §2.7's HTTP Mapping table only enumerates 200 for allowed/denied; the error result's HTTP code is not explicitly specified. PR-4 returns 200 for `result: "error"` with `consent_state_unknown` because the body is still a well-formed `ConsentDecision`. This is a Lead-resolved ambiguity, consistent with returning the canonical response shape rather than a structured error envelope.

#### Decision J — Partial consent model: not flattened

**What.** Resolver answers the specific operation→scope question asked. Does NOT return a flattened `can_*` representation of all scopes (e.g., `can_store_profile`, `can_match`, `can_contact`).

**Why.** Group 2 §2.7 Partial Consent Model (lines 2388-2409) describes the conceptual framework for partial consent; Phase 1 §1's `ConsentDecision` schema is the wire-shape that governs the response. Returning a flattened representation would either leak consent semantics or require a new schema Phase 1 didn't lock. The locked Phase 1 schema wins.

**Implication for callers.** ATS, Portal, and Ingestion are responsible for issuing multiple /consent/check calls if they need to know multiple operations' consent states. This keeps the response shape stable, avoids leaking partial-consent decisions into the resolver, and preserves a single per-call decision_id as the auditable unit.

#### Decision K — Right-to-be-forgotten handling

**What.** Resolver operates on anonymized `talent_id`. It does not check whether the talent identity exists; it queries the ledger by the provided `talent_id` regardless. Empty ledger (no events for the requested key) returns HTTP 200 with `result: "error"`, `reason_code: "consent_state_unknown"`. No 404, no exception.

**Why.** Group 2 §2.7 Right to be Forgotten (lines 2503-2511) commits to ledger retention with anonymized `talent_id`. The resolver must continue to function for queries against anonymized IDs. Empty ledger is an explicit "unknown" result, not a default-deny silent behavior — the audit row distinguishes "we evaluated and found no consent state" from "we never checked."

#### Decision L — No inference rule (R4 enforcement)

**What.** Resolver reads ONLY from `TalentConsentEvent`. No code path in `resolveConsentState` reads from engagement tables, response data, behavioral signals, or any non-ledger source.

**Why.** Charter R4 forbids consent inference from behavior. ADR-0005 Decision E (PR-3.1) was originally worded to forbid cross-event derivation in write paths. ADR-0006's resolver conventions extend Decision E for resolver paths under strict constraints — the resolver may do cross-event reads (Decision D's source-aware partition) but only against the ledger. The R4 guardrail (Precedent O below) mechanically enforces this boundary via region-marker enforcement.

### Implementation Precedents

#### Precedent M — Deferred-throw pattern for transactional audit + 4xx

**What.** Decision H requires every check to persist an audit row, including for the 422 INVALID_SCOPE_COMBINATION case. Throwing inside a Prisma transaction rolls back all writes including the audit row. PR-4 resolved this with a discriminated-union `ResolverTxResult { decision, deferredThrow?: AramoError }`. The 422 path persists the audit row inside the transaction, returns the deferredThrow, and the outer method throws AFTER the transaction commits. Audit durability and structured error propagation are both preserved.

**Why captured as a precedent.** This pattern is precedent-setting. Future PRs that need audit-with-error semantics (e.g., PR-5's potential read-with-failure cases, or any future endpoint where a 4xx classification must coexist with durable audit logging) follow the same shape: persist audit inside the transaction, defer the throw to outside the transaction. Doing the audit write outside the transaction would lose the atomicity guarantee R13 requires.

#### Precedent N — Channel-permission metadata convention

**What.** `TalentConsentEvent.metadata` may carry `{ permitted_channels: ContactChannel[] }` on grant events. Absence of the field means "all channels permitted by default" for that grant. The resolver computes intersection across latest-per-source grants to produce the effective permitted-channels set; a requested channel not in the intersection produces denied with `reason_code: "channel_not_consented"`.

**Why captured as a precedent.** The spec doesn't lock the shape of channel-level consent in metadata. PR-4 locked this convention. Future PRs that write grant events with channel-level consent must conform; future readers can rely on the absence-means-permitted semantic.

**Migration concern.** Grant events written before PR-4 (in PR-2) didn't include this metadata field. Per the absence-means-permitted convention, those grants are treated as "all channels permitted." This is the correct fallback for pre-PR-4 grants (no retroactive restriction can be inferred from absence), but it does mean PR-2-era grants cannot express channel restrictions retroactively. A future PR introducing channel-level revocation or re-consent must address how to retrofit pre-PR-4 grants if that becomes necessary; the absence-means-permitted convention does not pre-empt that decision.

#### Precedent O — R4 region-marker enforcement mechanism

**What.** The R4 guardrail (in `libs/consent/src/tests/consent.refusal-r4.spec.ts`) uses string-based region splitting, not AST parsing. Two markers in `libs/consent/src/lib/consent.repository.ts`:

- `async resolveConsentState(` separates the **write region** (everything before) from the **resolver region** (everything after).
- `// Resolver-path helpers` is a boundary check that confirms the helpers comment exists.

Write region preserves Decision E's original wording: `findUnique` / `findFirst` / `create` allowed; `findMany` / `aggregate` / `groupBy` / `count` forbidden. Resolver region allows specific operations: `tx.idempotencyKey.findUnique` / `.create`, `tx.talentConsentEvent.findMany`, `tx.consentAuditEvent.create`. File-level invariants forbid non-ledger reads anywhere and ledger mutations anywhere. Four synthetic-violation tests verify the guardrail catches injected violations in each category.

**Why captured as a precedent.** This is the mechanical enforcement model for ADR-0005 Decision E plus ADR-0006's resolver-path extension. Future PRs adding cross-event reads must do so inside the resolver region; the guardrail will reject them in the write region.

**Conservative over-inclusion.** Code added between `resolveConsentState` and the helpers comment inherits resolver-path classification. This is the deliberate conservative default: when in doubt, the more restrictive classification applies. **New write methods MUST be placed before `async resolveConsentState(` to receive write-region enforcement.** This is a real refactoring constraint — moving the resolver method or reordering methods requires understanding the marker-based classification.

### Process Precedent

#### Precedent P — Local pre-commit sweep must include `nx build`

**What.** PR-4's first push (commit `bf56f9f`) failed CI on the `build` check with a TypeScript narrowing error in `consent.repository.ts` that did not surface during local `nx test` runs. Vitest uses on-the-fly transpilation (esbuild) that bypasses strict `tsc`; `nx build` runs the actual TypeScript compiler with the strict library tsconfig (`tsconfig.lib.json`). The PR-4 v2 prompt's local CI gate sweep specification was imprecise — it specified `nx run-many --target=test --all` but not `nx run-many --target=build --all`.

**Resolution.** PR-4 fix-up commit (`7c4ed9c`) snapshotted the narrowed value to a local `const` before the spread, restoring TypeScript's narrowing analysis. Six-line diff, no semantic change.

**Why captured as a precedent.** Future commit-instruction drafts for any PR must explicitly include `nx run-many --target=build --all` (with `--skip-nx-cache` when verifying fresh-state) alongside `--target=test --all`. They are testing different things: vitest validates runtime behavior under transpiled JavaScript; tsc validates compile-time behavior under the strict library tsconfig. Both are required for a confident pre-commit verification.

**Implication for tooling.** Worth considering whether to add a CI gate or local script (e.g., `npm run verify:full` or similar) that runs the full sweep deterministically. Not a PR-4.1 deliverable; a potential follow-up if the gap surfaces again on future PRs.

---

## Consequences

### Positive

- PR-5 (consent state read) and PR-6 (consent history) inherit the resolver-path conventions in writing, with no re-derivation needed. The `resolveConsentState` seam is established; future read endpoints can call it or follow the same pattern.
- The resolver path is now a documented operation class, distinct from write paths. ADR-0005 Decision E remains in force for write paths; ADR-0006's resolver conventions are explicit about the extension and the boundary between the two categories.
- The R4 guardrail's two-category enforcement (write region + resolver region) is mechanically locked. Future PRs that add cross-event reads must do so inside the resolver region; future write methods must be placed before the resolver method to receive write-region enforcement.
- The deferred-throw pattern (Precedent M) generalizes: future audit-with-error cases follow the same shape, preserving R13 atomicity while honoring the audit-on-every-call contract.
- The build-vs-test process precedent (Precedent P) prevents the same gap from recurring on PR-5 and beyond. Commit-instruction drafts now include `nx build` explicitly.

### Negative

- The 16-item precedent surface is the largest yet locked in a single ADR. Future PR-4-class policy engines (if any) may surface comparable or larger surfaces; the program's retroactive-ADR cost grows with the policy-engine count. Mitigation: ADR-0006 itself is the largest expected; future policy engines are likely smaller because they will inherit (rather than re-establish) the resolver-path conventions.
- Decision F's engagement-reset semantic is deferred. Until engagement entities exist, the simple 12-months-since-latest-grant check is what ships. A future PR adding engagement-reset must update both the resolver logic and this ADR (likely as a small amendment or superseding ADR).
- Precedent N (channel-permission metadata convention) means grant events written before PR-4 cannot express channel restrictions retroactively. PR-2-era grants are treated as "all channels permitted" by the absence-means-permitted semantic. This is the correct fallback for the empty case but is a real historical gap; a future PR introducing channel-level revocation or re-consent will need to address how to retrofit pre-PR-4 grants if that becomes necessary.
- Precedent O's conservative over-inclusion (code between `resolveConsentState` and helpers inherits resolver-path classification) means future write methods MUST be placed before `async resolveConsentState(`. This is a real refactoring constraint; reorganizing the file requires understanding the marker-based classification or updating the markers explicitly.
- Precedent P's process gap (local sweep didn't include build) was caught in PR-4's CI cycle but only surfaced post-push. Future PRs must update the local sweep specification before pushing. The Lead's commit-instruction drafts must reflect this.

### Neutral

- This ADR captures sixteen items in a single Decision section with three subsections (Contract Decisions, Implementation Precedents, Process Precedent). The consolidation matches the ADR-0001 (4 decisions) / ADR-0003 (8 decisions) / ADR-0005 (6 decisions) idiom of "one ADR per precedent-setting PR, regardless of how many discrete decisions that PR commits."
- The Reversal Trigger pattern from ADR-0002 is intentionally not used as a separate section. Decision F has an inline deferral note (engagement-reset semantic deferred until engagement entities exist) but no discrete reversal event; Precedent P has an implicit reversal trigger (build-vs-test gap fixed if the local sweep specification is updated, but that's process improvement, not a discrete event tied to a future PR).
- This is the sixth retroactive ADR. The program's idiom is now firmly established (ADR-0001 PR-1, ADR-0003 PR-2, ADR-0004 PR-2.2, ADR-0005 PR-3, ADR-0006 PR-4). Future PRs with substantive precedents follow the same pattern: write the PR, surface precedents in the PR description and commit message, lift them into a retroactive ADR after merge.

---

## References

### PR-4 commit chain

- Source commit: `bf56f9f` — `feat: PR-4 consent check endpoint + resolver path + policy engine`
- Fix-up commit: `7c4ed9c` — `fix: PR-4 snapshot intersection to local const before filter spread`
- Merge commit: `9c987ca` — Merge pull request #14

### Spec authority

- API Contracts v1.0 Phase 1 §1 — `ConsentDecision` schema (lines 469-489); `ContactChannel` enum (lines 402-404); error envelope embedding pattern (lines 338-381); `tenant_id` from JWT (lines 246-248)
- API Contracts v1.0 Phase 1 §6 — Consent API endpoints; Processing Rules (lines 504-518); Idempotency: Optional for /consent/check; Consent Failure Mode (Locked) (lines 520-524)
- Group 2 Consolidated Baseline §2.7 — Multi-Source Conflict Resolution (lines 2411-2422); Counterintuitive Example (lines 2416-2422); Stale Consent (lines 2424-2447); Scope Dependencies (lines 2352-2360); Enforcement Points (lines 2372-2386); HTTP Mapping (lines 2559-2567); Right to be Forgotten (lines 2503-2511); Partial Consent Model (lines 2388-2409); contacting scope semantics (lines 2336-2344)
- Charter v1.0 §8 — Refusals R4 (no consent inference from behavior), R6 (no acting on stale consent), R11 (no fast-path bypass), R13 (consent integrity over engagement velocity)

### Inherited ADRs

- ADR-0001 — Locked tooling and PR-1 precedents
- ADR-0002 — Bootstrap-phase branch protection relaxations (Reversal Trigger pattern)
- ADR-0003 — Infrastructure conventions (Prisma 7 + build/CI patterns); Decision 8 (INTERNAL_ERROR catch-all classification)
- ADR-0004 — Pact contract test convention
- ADR-0005 — Consent revoke contract & audit semantics; **Decision E** (the rule ADR-0006 extends, not loosens, via the resolver-path category); Decision F (action-lock pattern, applies to write paths)

### PR-4 working artifacts (for re-grounding the Decision sections)

- `openapi/common.yaml` — `/consent/check` path; `ConsentCheckOperation`, `ConsentCheckRequest`, `ConsentDecision` schemas
- `libs/consent/src/lib/consent.repository.ts` — `resolveConsentState` method with the resolver-region marker; four module-private helpers
- `libs/consent/src/tests/consent.refusal-r4.spec.ts` — R4 two-category guardrail with four synthetic-violation tests
- `libs/consent/src/lib/dto/consent-check-operation.ts` — `ConsentCheckOperation` closed enum (the 7th in the program)
