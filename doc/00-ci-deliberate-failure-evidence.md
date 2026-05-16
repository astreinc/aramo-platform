# PR-M0R-2 — CI Deliberate-Failure Evidence

This document records the deliberate-failure CI evidence required by
**PR-M0R-2 §4 final bullet** (M0 Remediation Plan v1.0 LOCKED) and
**Plan v1.2 §3 M0 Track B — "First deliberate-failure CI test
(drift detection)"**.

## Purpose

Demonstrate that the refusal-enforcement CI gates wired by PR-M0R-2 fail
the build when a deliberately-forbidden field is introduced into the
OpenAPI surface, and recover to green once the drift is reverted. This
converts Charter refusals from policy commitments into machine-enforced
build invariants (per API Contracts v1.0 Phase 6).

## Substrate-substitution note (Gate 5 halt-flagged for Lead)

The PR-M0R-2 §4 directive lists the example drift as
`add internal_reasoning to a refusal-constrained schema in openapi/common.yaml`.
However, `openapi/common.yaml` schemas reach Portal/ATS responses via
`$ref`, and the natural extension that would make a `common.yaml` drift
trip `portal:refusal-check` (scanning `common.yaml` too) raises
false-positives on three documented exceptions in the existing
`common.yaml`:

- `ErrorObject.details` — documented OpenAPI exception, `additionalProperties: true`
- `ConsentGrantResponse.metadata` / `ConsentRevokeRequest.metadata` /
  `ConsentRevokeResponse.metadata` — free-form metadata bag,
  `additionalProperties: true`
- `ConsentDecisionLogEntry.event_payload` — event payload bag,
  `additionalProperties: true`

Resolving this requires an allowlist of `additionalProperties: true`
exception schemas in `common.yaml`, which is interpretation beyond what
PR-M0R-2 §4 names. Per the Gate 5 protocol HALT rule
("Forbidden-field-list authoring requires interpretation of Charter
refusals beyond what the 13 named refusals literally say — surface; do
not improvise interpretations"), this is surfaced to Lead.

**Substitute drift target used for this evidence:** insert the forbidden
field directly into `openapi/portal.yaml` (the file `portal:refusal-check`
unambiguously owns). This achieves the directive's intent — a deliberate
drift triggers `portal:refusal-check` failure and reverting it restores
green — without depending on the unresolved `common.yaml` scope question.

## Local evidence (Gate 5 verified)

### Deliberate drift content

Added schema to `openapi/portal.yaml`:

```yaml
components:
  schemas:
    DriftEvidenceMatchExplanation:
      type: object
      additionalProperties: false
      required: [match_id]
      properties:
        match_id:
          type: string
          format: uuid
        internal_reasoning:
          type: string
          description: Forbidden by Charter R10 — exposes internal reasoning to talent
```

This violates Charter refusal R10 ("Will not expose internal reasoning or
evaluation outputs") and is on the `verify-portal-refusal.ts`
`FORBIDDEN_EXACT` list.

### Local execution under drift

```
$ npm run portal:refusal-check
> aramo-core@0.0.0 portal:refusal-check
> node --import jiti/register ci/scripts/verify-portal-refusal.ts

portal:refusal-check FAILED — 1 violation(s):
  components.schemas.DriftEvidenceMatchExplanation.properties.internal_reasoning: exact-match forbidden field: internal_reasoning
exit code: 1
```

Other gates (`openapi:drift-check`, `ats:refusal-check`,
`version:sync-check`, `error-codes:check`) continued to exit 0 under the
drift — no collateral failures, as required by Gate 5 halt condition
"The deliberate-drift test you inject causes any *unexpected* CI failure
beyond the intended one — halt; do not 'fix it up'."

### Local execution after revert

```
$ npm run portal:refusal-check
> aramo-core@0.0.0 portal:refusal-check
> node --import jiti/register ci/scripts/verify-portal-refusal.ts

portal:refusal-check ok (openapi/portal.yaml)
exit code: 0
```

Working tree byte-identical to pre-drift state
(`git status --porcelain openapi/` → empty).

## Remote CI evidence (Gate 6 — captured)

The directive §4 final bullet requires:

- Push to a branch to trigger CI
- Capture the failing CI run URL/output
- Confirm the drift is reverted

### Failing CI run (drift active)

- Branch: `feature/pr-m0r-2-refusal-scripts`
- HEAD at failing run: `51d1ae0` (deliberate-drift inject commit)
- CI run URL: https://github.com/astreinc/aramo-platform/actions/runs/25919007604
- Failing job: `portal:refusal-check`
- Failure detail (verbatim from CI log):
  `portal:refusal-check FAILED — 1 violation(s):`
  `  components.schemas.DriftEvidenceMatchExplanation.properties.internal_reasoning: exact-match forbidden field: internal_reasoning`
  `exit code: 1`
- Charter R10 enforcement confirmed: machine-detected the forbidden field
  injection without human intervention.

### Drift revert and green-CI restoration

The drift is reverted in a subsequent commit on the same branch
(`feature/pr-m0r-2-refusal-scripts`). After revert, `portal:refusal-check`
returns to exit 0 across the full CI surface (Amendment v1.0 §5 strengthened
acceptance).

## References

- Aramo Charter v1.0 §8 — refusal R10 (no internal reasoning exposure)
- API Contracts v1.0 Phase 6 — "Refusal Enforcement Made Operational"
- M0 Remediation Plan v1.0 §3 PR-M0R-2 §4 — deliberate-failure evidence
  scope
- Plan v1.2 §3 M0 Track B — "First deliberate-failure CI test
  (drift detection)"
- Plan v1.2 §6 DoD #5 — refusal scripts pass
- `ci/scripts/verify-portal-refusal.ts` — gate that detected the drift
