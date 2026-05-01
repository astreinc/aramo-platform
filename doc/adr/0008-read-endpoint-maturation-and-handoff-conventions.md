# ADR-0008: Read-Endpoint Maturation, Directive-Tier Discipline, and Artifact Handoff Conventions

**Status:** Accepted

**Date:** 2026-05-01

**Supersedes:** none

**Extends:** ADR-0006 (Implementation Precedent O — promotion to twice-validated standing practice; see §3); ADR-0007 (cursor opacity follows the same forward-compatibility philosophy as §6's nullable convention; §7 retroactive-ADR methodology extended to directive tier; §8 Precedent P promoted to load-bearing gate)

**Related PRs:** PR-6 (`feature/pr-6-consent-history`, merged at `56cb652`; source commit `bbac751`), PR-6.1 (this ADR)

**Related ADRs:** ADR-0001 through ADR-0007

---

## 1. Context

PR-6 introduced the second consent read endpoint, `GET /consent/history/{talent_id}`, building on the conventions ADR-0007 codified for the first (`GET /consent/state/{talent_id}`). Three things happened during the PR-5 → PR-5.1 → PR-6 arc that warrant codification:

First, the read-endpoint conventions ADR-0007 documented were **inherited cleanly** by PR-6 — every Decision A through H of ADR-0007 §3 transferred to history without re-derivation. This is the first evidence that the conventions are durable across endpoints, not artifacts of one PR's specifics.

Second, the **verify-before-drafting** constraint codified in ADR-0007 §7 (originally an ADR-tier discipline) was applied for the first time at directive tier. PR-6's directive went through a review-amendment-reverification cycle before execution authorization, surfacing four substantive corrections that would otherwise have triggered halt conditions during implementation. The discipline scaled from ADR documents to directive documents.

Third, **three consecutive PRs landed first-push-green** (PR-5: 17 checks; PR-5.1: 17 checks; PR-6: 17 checks), validating Precedent P (local `nx build` pre-push sweep) as a load-bearing gate rather than a provisional best-practice that survived one PR cycle.

This ADR codifies eight items from that arc. None are new design decisions; all document codified reality from work already merged. ADR-0007 §7's "no speculative design" constraint applies.

---

## 2. Scope

**In scope.** Eight capture items from the PR-5 → PR-5.1 → PR-6 arc:

1. Precedent O promoted to twice-validated standing practice
2. Cursor opacity convention as program-wide standard
3. Verify-before-authoring extended from ADR tier to directive tier
4. Enumerated query-parameter validation for read endpoints
5. Path A-equivalent artifact handoff for commit messages and PR bodies
6. Naming hygiene constraint on Path A/B/C label reuse
7. Precedent P promoted to load-bearing pre-commit gate
8. Path taxonomy clarification (Path A direct, Path C-default, Path C-verified, Path A-equivalent)

**Out of scope.**

- New read endpoints beyond history (e.g., decision-log read, audit-trail read)
- Multi-valued query-parameter conventions (PR-6 deliberately deferred multi-scope filtering; that decision stands)
- Retrofitting prior ADRs (ADR-0001 through ADR-0006) with the conventions codified here
- Backfilling PR-3 through PR-5.1 directives to the on-disk convention established in PR-6 (forward-only per the cutover decision recorded in conversation)
- ADR-0005 Decision E semantics (intentionally not cited in PR-6's directive after pre-verification showed it does not contain the resolver-vs-write-region distinction; the distinction belongs to ADR-0006 Implementation Precedent O)

---

## 3. Decisions

### Decision A — Precedent O promoted to twice-validated standing practice

**Statement.** Implementation Precedent O — established by ADR-0006 (R4 region-marker mechanism + allow-list) and restated by ADR-0007 §8 (no-guardrail-update-needed consequence) — is now twice-validated and is standing practice. Future resolver-region methods using only allow-list operations inherit this precedent without further ADR action.

**Rationale.** PR-5's `resolveAllScopes` was the first test of the precedent's design intent. PR-6's `resolveHistory` was the second. Both passed the R4 guardrail unchanged. Two consecutive validations across distinct read endpoints — one returning per-scope state, one returning historical events with cursor pagination — is sufficient evidence that the precedent's portability holds.

**Implementation surface.**

- `libs/consent/src/lib/consent.repository.ts` — `resolveAllScopes` (PR-5), `resolveHistory` (PR-6), both in resolver region
- `libs/consent/src/tests/consent.refusal-r4.spec.ts` — `ALLOWED_RESOLVER_OPERATIONS` set, unchanged across PR-5 and PR-6
- R4 guardrail status: pass-unchanged in both PR-5 and PR-6 implementation reports

**Constraint.** A method added to the resolver region that uses any operation outside `ALLOWED_RESOLVER_OPERATIONS` requires an explicit guardrail update and a new ADR. This precedent does not authorize silent expansion of the allow-list.

### Decision B — Cursor opacity convention as program-wide standard

**Statement.** Cursors in paginated read endpoints are opaque to the API client. Internal cursor structure (encoded fields, encoding scheme, field naming inside the encoded payload) is not part of the API contract and may evolve without API versioning. Clients pass cursors back unchanged; clients never inspect cursor internals.

**Rationale.** Originated in PR-6 with `history-cursor.ts` encoding `(created_at, event_id)` as a base64 payload with internal short-key field names (`{c, e}`). The opaque contract lets the encoding evolve — to compound cursors, signed cursors, or different field representations — without breaking clients. This is the same forward-compatibility principle that motivated ADR-0007 Decision A's wrapped response shape and ADR-0007 §6's nullable union convention.

**Implementation surface.**

- `libs/consent/src/lib/util/history-cursor.ts` — `encodeCursor` / `decodeCursor`, base64 over short-key JSON
- OpenAPI schema: `next_cursor` typed as `string | null` with no further internal structure documented
- `libs/consent/src/tests/history-cursor.spec.ts` — round-trip test guards encoding correctness

**Constraint.** Tests asserting internal cursor structure are prohibited at the API contract layer; they are permitted only inside the cursor utility module's own unit tests. A test in `consent.controller.spec.ts` or `consent.integration.spec.ts` that decodes and inspects cursor contents is a violation.

### Decision C — Verify-before-authoring extended to directive tier

**Statement.** ADR-0007 §7's verify-before-drafting constraint is extended to apply at the directive tier as well as the ADR tier. Before a directive is authorized for execution, every claim about field names, file paths, source-of-truth values, and behavior must be verified by reading the corresponding source on the merge commit at which the directive will execute.

**Rationale.** PR-5.1 codified the constraint at ADR tier after the four-values-versus-seven-values arithmetic error in ADR-0007's draft. PR-6's directive went through the same discipline one tier up: a review pass surfaced four substantive mismatches (`event_id` vs `id` column name, `created_at` vs `occurred_at` semantic plus index coverage, error code list framing, `util/` directory sanctioning) and four ambiguities. Each was fixed via amendment before execution authorization. The result was zero halt conditions during implementation. The discipline scales.

**Implementation surface.**

- PR-6 directive: `doc/prompts/pr-6-consent-history.md`, on disk at the canonical machine
- PR-6 directive review report (in PR-6 conversation history): four mismatches, four ambiguities, all amended before execution
- PR-6 implementation report: zero halt conditions, zero ambiguities encountered

**Methodology.** The directive-tier discipline follows the same shape as the ADR-tier discipline:

1. Lead authors directive (or amends prior draft)
2. Repo-access agent performs review pass against `origin/main` source
3. Mismatches and ambiguities surfaced for Lead disposition
4. Lead authorizes amendments (or rejects them with rationale)
5. Repo-access agent applies amendments, re-verifies clean
6. Lead authorizes execution

The cycle terminates only when re-verification returns zero mismatches and zero ambiguities. Authorization-without-clean-reverification is a discipline violation.

### Decision D — Enumerated query-parameter validation

**Statement.** Read endpoints validate enumerated query parameters against their canonical enum and return HTTP 400 `VALIDATION_ERROR` on unknown values. Silent empty-result responses for unknown enum values are prohibited.

**Rationale.** Surfaced during PR-6 implementation as an "implementation choice within locked boundaries." The directive specified `?scope=<single value>` as single-valued but did not require the value be validated against `CONSENT_SCOPES`. The implementation added the validation; the report surfaced the choice for transparency. The validation is the better behavior on three grounds: it gives clients an explicit signal rather than empty results, it prevents a silent-failure bug class, and it matches the existing program convention for body-field enum validation.

**Implementation surface.**

- `libs/consent/src/lib/consent.controller.ts` — `parseScopeFilter` checks against `CONSENT_SCOPES`
- `libs/consent/src/tests/consent.controller.spec.ts` — explicit test case for unknown scope value returning 400

**Constraint.** This convention applies to all enumerated query parameters on read endpoints, not just `?scope=`. Future read endpoints adding enum-typed query parameters inherit this rule without further ADR action.

### Decision E — Path A-equivalent artifact handoff

**Statement.**

> Commit messages and PR bodies may be produced through an agent-assisted flow only when the final bytes are written to disk, verified, and consumed via file path (`git commit -F`, `gh pr create --body-file`). This preserves byte-fidelity while avoiding chat-paste ambiguity.

**Rationale.** The Path A discipline established for the PR-6 directive (Lead writes bytes directly to disk via heredoc) is too restrictive for higher-volume artifacts like commit messages and PR bodies, which are produced for every PR. Path A-equivalent relaxes the "Lead types every byte" constraint while preserving the load-bearing properties: bytes reach disk before consumption, verification (`xxd` byte-check) confirms no corruption, and consumption is via file path (`-F` / `--body-file`) rather than command-line argument or stdin. The relaxation is bounded — Path A-equivalent applies only to commit messages and PR bodies, not directives.

**Implementation surface.**

- PR-5.1, PR-6 commit message authoring used `cat > /tmp/...` heredocs (Path A direct)
- PR-6 commit message authoring also valid via Write tool to `/tmp/pr-6-commit-msg.txt` followed by `xxd` verification (Path A-equivalent)
- Both produce equivalent byte-fidelity guarantees when post-write verification is performed

**Constraint.** Path A-equivalent is **not** authorized for directive artifacts. Directives use Path A direct (Lead-authored heredocs) or Path C-verified (agent-authored bytes followed by verify-against-`main` and Lead-amendment cycle, per the PR-6 precedent). Path C-default (agent-authored without verification cycle) remains rejected for directives.

### Decision F — Naming hygiene constraint

**Statement.**

> Avoid reusing Path A/B/C labels across different artifact classes unless explicitly scoped.

**Rationale.** "Path C" was used in PR-6 directive-authoring conversation to mean "agent-authored bytes for directive artifacts," and Path C-default (without verification cycle) was rejected; Path C-verified (with verify-against-`main` + Lead-amendment cycle) was accepted and used to author the PR-6 directive itself. Subsequent reports used "Path C extended" to describe agent-assisted commit-message authoring, which is a distinct practice with distinct properties (Path A-equivalent, see Decision E). The label collisions risk confusing future contributors reading session archives — they may conflate Path C-default's rejection with Path C-verified's acceptance, or conflate Path C-verified with Path A-equivalent, when in fact each is a bounded and distinct practice.

**Implementation surface.**

- This ADR (Decision H taxonomy table distinguishing Path C-default from Path C-verified; Decision E constraint clarifying which paths apply to directives)
- Future PR reports and ADRs use the explicit labels rather than "Path X extended" forms

**Constraint.** When a Path label is used in any future report, ADR, or directive, the artifact class it applies to must be named explicitly (e.g., "Path A for directives," "Path A-equivalent for commit messages"). Bare "Path C" or "Path A" without artifact-class scoping is ambiguous and should be avoided.

### Decision G — Precedent P promoted to load-bearing pre-commit gate

**Statement.**

> Three consecutive first-push-green PRs (PR-5, PR-5.1, PR-6) validate the local pre-push verification sweep as a load-bearing gate.

**Rationale.** Precedent P (local `nx run-many --target=build --all --skip-nx-cache` plus the full §8 verification suite before push) was introduced after PR-4's build-vs-test gap as a remediation. ADR-0007 §8 confirmed it as standing practice after PR-5 ran the sweep cleanly. Two more PRs (PR-5.1, PR-6) have now landed first-push-green, with the build-vs-test gap not recurring on any of them. The sweep is no longer provisional; it is the program's pre-commit gate, on par with the CI checks themselves.

**Implementation surface.**

- PR-5 implementation report: 17 CI checks green on first push
- PR-5.1 implementation report: 17 CI checks green on first push
- PR-6 implementation report: 17 CI checks green on first push
- All three reports cite Precedent P explicitly

**Constraint.** Skipping the local sweep before push is a discipline violation. A PR that lands fix-up commits because the sweep was skipped is a signal that the gate weakened, not that it failed.

### Decision H — Path taxonomy clarification

**Statement.** The Path A / B / C taxonomy applies to two distinct artifact classes with the following bindings:

| Artifact class | Path label | Definition |
|---|---|---|
| Directives | Path A | Lead-authored bytes written directly to disk via heredoc on the canonical machine |
| Directives | Path B | Lead-pasted bytes relayed through chat to the canonical machine |
| Directives | Path C (default) | Agent-authored bytes — rejected as standing practice |
| Directives | Path C (verified) | Agent-authored bytes accepted when followed by verify-against-`main` + Lead-amendment cycle (PR-6 precedent) |
| Commit messages, PR bodies | Path A direct | Lead-authored bytes via heredoc (as PR-5.1 used) |
| Commit messages, PR bodies | Path A-equivalent | Agent-assisted bytes written to disk, verified via `xxd`, consumed via `-F` / `--body-file` |

**Rationale.** Codifying the taxonomy explicitly is the structural fix for the naming collision Decision F's hygiene rule prevents going forward. The table above is the program's authoritative reference.

**Implementation surface.** This ADR is the implementation surface; future reports and ADRs cite this table when path labels are used.

**Constraint.** Adding a new artifact class to the taxonomy (e.g., "ADR drafts" or "test fixtures") requires an explicit ADR amendment. Reusing existing path labels for unspecified artifact classes is the violation Decision F prohibits.

---

## 4. Surgical extensions to prior ADRs

This ADR extends three prior ADRs without rewriting them. The extensions are scoped and non-disruptive, following the surgical-extension pattern ADR-0007 §5 established for read-endpoint status priority.

### Extension to ADR-0006 (Implementation Precedent O)

ADR-0006 introduced Precedent O as a design intent. Two consecutive validations (PR-5 `resolveAllScopes`, PR-6 `resolveHistory`) promote it to twice-validated standing practice per Decision A. Future resolver-region methods inherit the precedent without further ADR action. ADR-0006's text is unchanged; this ADR's Decision A is the promotion.

### Extension to ADR-0007 §7 (verify-before-drafting)

ADR-0007 §7 codified verify-before-drafting at the ADR tier. Decision C extends it to the directive tier. The discipline shape is identical (review → mismatches/ambiguities → amendments → re-verify clean → execute); only the artifact class changes. ADR-0007 §7's text is unchanged; this ADR's Decision C is the extension.

### Extension to ADR-0007 §8 (Precedent P)

ADR-0007 §8 confirmed Precedent P as standing practice after PR-5. Decision G promotes it to load-bearing pre-commit gate after three consecutive first-push-green PRs. ADR-0007 §8's text is unchanged; this ADR's Decision G is the promotion.

---

## 5. Forward-only on-disk directive convention

PR-6 established the convention that PR directives live as Lead-authored files under `doc/prompts/`. The forward-only application of this convention is recorded here as a methodological note, not a Decision (no codification of new policy; documentation of an existing cutover):

- PR-7 onward: directives live on disk under `doc/prompts/<name>.md`
- PR-3 through PR-5.1: directives lived in chat context only; not backfilled
- The discontinuity is acceptable: pre-cutover PRs predate the verify-before-authoring discipline; post-cutover PRs apply it

Note: `doc/prompts/` is gitignored (per `.gitignore` line 32). Directive files live on the canonical machine's working copy; they are not in version control. The on-disk-but-not-tracked status is intentional and predates ADR-0008.

This note exists to prevent future contributors from interpreting the absence of `doc/prompts/pr-3-*.md` etc. as an oversight.

---

## 6. Precedents confirmed

These were established in prior PRs and validated by the PR-5 → PR-5.1 → PR-6 arc. They are listed as confirmed standing practice, not new decisions.

### Precedent O — Resolver-region operations, no guardrail update needed

Twice-validated. Standing practice. See Decision A.

### Precedent P — Local `nx build` pre-push sweep

Three-times-validated. Load-bearing pre-commit gate. See Decision G.

### Precedent Q (new in this ADR) — Verify-before-authoring across artifact tiers

The verify-before-drafting discipline (originally ADR-0007 §7) and verify-before-authoring discipline (Decision C of this ADR) share a common shape: review against source-of-truth, surface mismatches and ambiguities, amend, re-verify, authorize. This shape is now demonstrated at two artifact tiers (ADR documents, directive documents). Future artifact classes that adopt the same discipline (e.g., test plans, deployment runbooks) inherit the shape without further ADR action; the discipline is artifact-class-agnostic.

---

## 7. Consequences

**Positive.**

- The read-endpoint conventions ADR-0007 codified are now demonstrated to be portable across distinct endpoints; PR-7 onward inherits them without re-derivation
- Verify-before-authoring at directive tier produced a halt-free, ambiguity-free PR-6 execution; the same discipline is available for PR-7 onward
- The Path taxonomy is now explicit; future reports and ADRs have a canonical reference for path labels
- Three first-push-green PRs in a row indicates the program's pre-commit gates are working; remediation cycles for skipped checks are now anomalies, not norms

**Costs / risks.**

- The Path taxonomy table in Decision H is now load-bearing; adding artifact classes requires explicit ADR amendment, which is the intended cost
- The verify-before-authoring discipline at directive tier adds a verification round-trip before every implementation PR; the round-trip is the explicit price for first-push-green execution
- The forward-only directive convention creates a permanent discontinuity between pre-cutover and post-cutover PRs; future contributors auditing the PR-3 → PR-5.1 directives will need to read chat archives, which is acceptable but worth documenting (see §5)

**Forward pointers.**

- ADR-0009 (when authored) will likely capture PR-7's contributions if PR-7 surfaces new conventions; if PR-7 is execution-only with full inheritance, no ADR may be needed
- Decision F's naming hygiene rule will be tested the first time a new path label is proposed; the test is whether the proposer scopes the label to an artifact class explicitly

---

## 8. References

- ADR-0001 through ADR-0007 (program ADR series)
- PR-5 implementation report (commit `fa5dc22`, merged `b7776e7`)
- PR-5.1 implementation report (commit `dae6992`, merged `eedfd75`)
- PR-6 implementation report (merged at `56cb652`; source commit `bbac751`)
- PR-6 directive: `doc/prompts/pr-6-consent-history.md`
- PR-6 directive review report (in conversation history): four mismatches, four ambiguities, all amended pre-execution
- Validating tests: `consent.refusal-r4.spec.ts` (R4 guardrail), `history-cursor.spec.ts` (cursor opacity), `consent.controller.spec.ts` (enumerated query-param validation)
