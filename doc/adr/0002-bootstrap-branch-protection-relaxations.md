# ADR-0002: Bootstrap-Phase Branch Protection Relaxations

**Status:** Accepted

**Date:** 2026-04-28

---

## Context

During M0 bootstrap, the Aramo program operates with a single human (`@purush2800`) acting in three roles simultaneously: Lead Engineer, Architect, and Product Owner. The branch protection ruleset on `main` (ruleset ID `15682786`, established in PR-1.2 and refined under PR-1.3) was configured to enforce the Tier 3 review discipline that `doc/06-lead-review-checklist.md` describes. Two parameters of that ruleset's `pull_request` rule, however, **structurally cannot be enforced** when only one human is participating: (a) `require_last_push_approval` requires the approver to be a different human from the last pusher, and (b) GitHub structurally prevents PR authors from approving their own pull requests through the review UI regardless of ruleset configuration. Both behaviors exist for sound reasons in normal multi-author teams; both become merge-blocking when the team is one human.

PR-1.3 (`doc/00-README.md` ADR reference, merged as commit `6fec115`) was the first PR to exercise the strict ruleset and is what surfaced the structural conflict — it sat indefinitely in `BLOCKED` state because the sole CODEOWNER could not record an approval. Four alternatives were considered before settling on the relaxation: (1) relax the two parameters as documented here; (2) introduce a bot account to act as a second approver, which the program rejected because bot-author approvals leak responsibility and create a worse audit trail than self-approval; (3) add the Lead to `bypass_actors`, which would defeat the entire ruleset rather than surgically address the two blockers; (4) recruit an external human to record approvals, which is operationally impractical during M0 and conflates approval with review. Option 1 is the least bad: it preserves every other discipline parameter and names a precise reversal trigger, making the relaxations time-boxed rather than permanent.

---

## Decision

### Decision 1 — Disable `require_last_push_approval`

The `require_last_push_approval` parameter on ruleset `15682786`'s `pull_request` rule is set to `false`.

**Rationale.** This parameter exists to prevent a malicious or sloppy last-minute push from bypassing review — the threat model is "Reviewer A approved at commit X; Author B pushed commit Y after; CI passed; merged without re-review." That threat requires two distinct humans (one approving, one pushing). With a single human acting as both, the parameter cannot block a meaningful threat — there is no second person who could push between approval and merge. Setting it to `true` only makes self-approval impossible without preventing any actual abuse pattern.

**Reversal trigger.** A separate human Lead Engineer joins the program with write access to `astreinc/aramo-platform`. At that point the threat model becomes meaningful again and the parameter must be restored to `true`.

### Decision 2 — Set `required_approving_review_count` to 0

The `required_approving_review_count` parameter on ruleset `15682786`'s `pull_request` rule is set to `0`.

**Rationale.** GitHub structurally prevents PR authors from approving their own pull requests through the review UI; the "Approve" radio is greyed out for the author regardless of ruleset configuration. With one human in the program, every PR is authored by that human, so no approval can ever be recorded. Leaving this parameter at `1` would block all merges indefinitely. Lowering it to `0` reflects the reality that approval is currently honor-system, recorded textually in the PR description's "Lead Review Summary" block rather than via the GitHub review-event mechanism.

**Reversal trigger.** Same as Decision 1 — a separate human Lead Engineer joins the program. The new Lead is structurally eligible to approve PRs authored by `@purush2800`, restoring the approval count's enforcement value.

---

## Consequences

### Positive

- PRs can be merged during M0 bootstrap **without bypassing branch protection** and without using admin-override (which `doc/04-risks.md` V3 specifically calls out as a habit to avoid). The sole-author program continues to ship through the same PR flow it will use post-bootstrap; only two parameters differ.
- **Every other discipline parameter remains in effect.** The eight required CI gates (install, lint, build, test:unit, openapi:validate, openapi:lint, lint:nx-boundaries, verify:vocabulary) still gate merge. `require_code_owner_review: true` still ensures CODEOWNERS routing is logged on every PR. `dismiss_stale_reviews_on_push: true` is preserved so it begins enforcing the moment Decision 2 is reversed. `required_review_thread_resolution: true` continues to require all conversation threads be resolved before merge. Branch deletion is blocked. Force-pushes are blocked.
- The relaxations are documented as **deliberate and time-boxed**, with a named reversal trigger. This is exactly the failure mode `doc/04-risks.md` CX2 (architectural rationale forgotten) is designed to prevent. A future Claude Code instance reading the ruleset and finding `required_approving_review_count: 0` will land on this ADR rather than treating the relaxed state as the program's permanent posture.

### Negative

- During M0, the merge gate is effectively **"all CI checks pass and conversation threads resolved."** There is no recorded GitHub approval action; the audit trail does not show the explicit "this PR was reviewed before merge" green checkmark that GitHub displays when an approval is recorded. The Lead Review Summary text in the PR description is the equivalent record, but it is not captured by GitHub's review-event API.
- **Tier 3 review discipline from `doc/06-lead-review-checklist.md` is honor-system during M0.** The Lead must self-discipline to actually walk the checklist on every Tier 3 PR even though no structural mechanism enforces it. Skipping the checklist on a refusal-layer-relevant PR would not block merge; only the human's own discipline does. This is a real risk on tired days or under deadline pressure.
- **When the reversal trigger is met, a future PR must explicitly reverse both parameters.** If that PR is forgotten or delayed, the program operates in a state where structural enforcement *is* possible (a second human exists) but is *not* enabled. That is strictly worse than the current state, where everyone — Claude Code, Lead, future contributors — knows the relaxation is forced by structure rather than chosen for convenience. The reversal PR should be queued in the same onboarding checklist that grants the new Lead Engineer write access.

### Neutral

- The CODEOWNERS file (added in PR-1.2, commit `fab0811`) already routes review requests for the right paths: `/openapi/`, `/scripts/verify-vocabulary.sh`, `/eslint.config.mjs`, `/redocly.yaml`, `/doc/00-README.md`, `/doc/01-locked-baselines.md`, `/doc/03-refusal-layer.md`, `/doc/adr/`, and `/openapi/common.yaml`. When the reversal trigger is met, no CODEOWNERS update is required as part of re-tightening — the file is already correct for multi-Lead operation. The reversal PR is therefore small (one ruleset PATCH or two UI checkbox flips) and ships quickly.
- **This ADR establishes the precedent for documenting bootstrap-phase relaxations of any kind**, not only branch protection. If future bootstrap relaxations become necessary (e.g., relaxed CODEOWNERS granularity, deferred CI gates pending tooling, single-author commits to immutable docs), they should follow this ADR's shape: explicit Status, Decision per parameter, Rationale, named Reversal Trigger, and Consequences classified Positive / Negative / Neutral. The Reversal Trigger section makes the relaxation auditable and bounded.
- The two relaxed parameters are recorded in the ruleset's API state as concrete `false`/`0` values rather than absent fields. This means a future ruleset audit (`gh api repos/astreinc/aramo-platform/rulesets/15682786`) will surface them explicitly, prompting the question "why is this off?" — at which point the answer is this ADR.

---

## Reversal Trigger

A future PR (anticipated to be one of the first PRs after a separate Lead Engineer joins the program) must:

1. Set `require_last_push_approval: true` on ruleset `15682786`.
2. Set `required_approving_review_count: 1` on ruleset `15682786`.
3. Update this ADR's `Status` field from `Accepted` to `Superseded by ADR-NNNN`, where `NNNN` is the reversal PR's ADR number. The reversal PR's ADR (ADR-NNNN) describes the new state and references this ADR as the prior state.

ADR-0002's Context, Decision, Consequences, and Reversal Trigger sections are preserved as program history; only the `Status` field is updated. Per `doc/adr/README.md`, that is the single allowed modification to a prior ADR's content once it is Accepted.

---

## References

- Ruleset ID: `15682786` on `astreinc/aramo-platform`
- PR-1.2 (`fab0811`) — added CODEOWNERS file with the routing referenced in Consequences (Neutral)
- PR-1.3 (`6fec115` merge) — first PR to exercise the strict ruleset and surface the structural conflict; conversation history captured the four alternatives considered
- `doc/04-risks.md` CX2 (architectural rationale forgotten), V2 ("good enough for now" tech debt), V3 (skipping CI checks under pressure — the failure mode the relaxations explicitly avoid)
- `doc/06-lead-review-checklist.md` Tier 3 — the discipline being relaxed in structural enforcement but preserved in honor-system practice
- `doc/adr/README.md` — ADR conventions; this ADR follows the Michael Nygard short-form template established by ADR-0001
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — pattern PR for ADR format
