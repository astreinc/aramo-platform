# ADR-0011 — R7 sealed-allowlist extension for openapi/ingestion.yaml and verify-ingestion-refusal.ts

## Status

Accepted — 2026-05-17. Engineering Lead/Architect ratification under PR-14
authority + PR-14 Directive Amendment v1.0 §4.2.
Refusal-enforcement-adjacent (R7 is a protected Charter refusal); flagged
for PO awareness.

## Date

2026-05-17

## Context

The R7 sealed allowlist in `scripts/verify-vocabulary.sh` carries the
authorization rule verbatim:

> "New allowlist entries require Architect approval per Charter Refusal R7."

PR-13's §8.1-B pre-filing substrate-config diff established that
`openapi/ingestion.yaml` was not in the R7 allowlist (neither in
`R7_ALLOWLIST` nor `R7_ALLOWLIST_GLOB`) and that the file contained zero
`linkedin` occurrences. PR-13 therefore deferred R7 Layers 2/4 (which
deliberately introduce the literal `linkedin` token) to PR-14 — the
authorized R7-coverage PR.

PR-14 deliberately introduces the `linkedin` token at exactly three
authorized surfaces across two files:

1. **§4.3 — R7 Layer 2** — `x-prohibited-values: [linkedin, linkedin_scrape,
   linkedin_bulk, generic_web_scrape]` annotation on the `IngestionSource`
   schema in `openapi/ingestion.yaml`, per API Contracts v1.0 Phase 4
   "Four-Layer LinkedIn Refusal Enforcement" Layer 2 ("Explicit prohibited
   list: x-prohibited-values extension on AdapterType and SourceType makes
   the refusal machine-readable").
2. **§4.4 — R7 Layer 4** — the `SourcePolicyResponse` schema in
   `openapi/ingestion.yaml` with `linkedin_automation_allowed: { type:
   boolean, const: false }`, per API Contracts v1.0 Phase 4 Layer 4
   ("Schema-level const constraints:
   SourcePolicyResponse.linkedin_automation_allowed: type: boolean,
   const: false. Any response saying 'true' fails OpenAPI validation").
3. **§4.1 + Amendment §4.2 — R7 Layer 4 CI enforcement** —
   `ci/scripts/verify-ingestion-refusal.ts` names the literal
   `linkedin_automation_allowed` token in its `CONST_FALSE_INVARIANTS`
   list. The script is the CI tripwire that enforces the Layer-4
   const-false invariant — it cannot enforce the invariant without
   naming the token in source.

Without R7 allowlist entries, the `verify:vocabulary` CI gate's Tier-1
R7 ripgrep scan would fail at the deliberate `linkedin` substrings in
both files.

The Gate 5 v1 §12 report surfaced surface (3) — the enforcement script
itself — as an enumeration gap in the original directive §4.5 (which
named only `openapi/ingestion.yaml`). PR-14 Directive Amendment v1.0
§4.2 (Engineering Lead/Architect ratification, May 17, 2026) confirmed
the enforcement-script entry as authorized: "ci/scripts/verify-ingestion-
refusal.ts is added to R7_ALLOWLIST. This is precedent-grounded and is
a mechanical consequence of §4.1, not new scope." The amendment cites
the existing precedent of `scripts/verify-vocabulary.sh` (allowlisted
because it defines the search pattern itself).

## Decision

Add TWO entries to `R7_ALLOWLIST` in `scripts/verify-vocabulary.sh`:

1. `openapi/ingestion.yaml` — for the §4.3 + §4.4 token occurrences.
2. `ci/scripts/verify-ingestion-refusal.ts` — for the §4.1
   enforcement-script occurrence (Amendment §4.2).

Both entries are literal file paths — **not** a `openapi/*.yaml` or
`ci/scripts/verify-*-refusal.ts` glob in `R7_ALLOWLIST_GLOB` —
consistent with the narrowest-defensible-scope ruling (Lead,
2026-05-17). Every existing allowlist entry justifies its breadth by
current substrate need; no present need justifies authorizing the
`linkedin` token in `ats.yaml`, `portal.yaml`, `auth.yaml`,
`common.yaml`, or in the portal/ats refusal-enforcement scripts (which
do not contain the `linkedin` token and need no R7 entry). Future
analogous needs are future ADRs.

The entries carry per-entry comments matching the existing convention
(each allowlist entry justifies itself in-place by the PR authorizing
it):

```
  "openapi/ingestion.yaml"            # PR-14 ADR-0011, Architect-approved 2026-05-17: R7 Layers 2/4 — x-prohibited-values annotation (§4.3) + SourcePolicyResponse.linkedin_automation_allowed const-false (§4.4)
  "ci/scripts/verify-ingestion-refusal.ts"  # PR-14 ADR-0011 / Directive Amendment v1.0 §4 — verify-ingestion-refusal.ts names linkedin_automation_allowed in its CONST_FALSE_INVARIANTS to enforce R7 Layer 4; mechanical consequence of directive §4.1. Architect-approved 2026-05-17.
```

## Consequences

- The `linkedin` token is permitted in exactly two files —
  `openapi/ingestion.yaml` (the §4.3/§4.4 documentation surfaces) and
  `ci/scripts/verify-ingestion-refusal.ts` (the §4.1 CI enforcement
  surface) — and nowhere else in the repo. The R7 sealed allowlist
  remains as narrow as possible.
- `ats.yaml`, `portal.yaml`, `auth.yaml`, and `common.yaml` remain
  non-allowlisted; the R7 gate continues to fail on any `linkedin`
  occurrence in those files. The portal/ats refusal-enforcement scripts
  remain non-allowlisted for R7 (they don't name the linkedin token).
  A future analogous need (e.g., if Phase 4 Group N introduces analogous
  R7 documentation in another OpenAPI surface) is a future ADR.
- The §8.1-B pre-filing protocol gains a standing checklist item
  (Amendment §4.3): when a PR introduces a new refusal-enforcement
  script, verify whether it needs BOTH a TIER2_EXCLUDES entry (if it
  names Tier-2 vocabulary) AND an R7_ALLOWLIST entry (if it names the
  literal `linkedin` token). The two are independent.
- `pact/consumers/` is explicitly NOT allowlisted by this ADR. PR-14's
  §4.2 prohibited-source-type Pact test is hard-constrained to contain
  zero `linkedin` token in its content — the test uses a non-`linkedin`
  prohibited source value to exercise the closed-enum rejection (which
  exercises the identical `@IsIn(INGESTION_SOURCES)` rejection path).
- The CI tripwire enforcing R7 Layer 4 (`linkedin_automation_allowed`
  const false) is `verify-ingestion-refusal.ts`'s `CONST_FALSE_INVARIANTS`
  mechanism (PR-14 §4.1), mirroring the `verify-ats-refusal.ts`
  `examination_mutated` precedent. Any future change flipping the
  property away from `const: false` fails the `ingestion:refusal-check`
  CI job.
- Charter Section 8 (refusal posture) is unchanged. R7 remains
  non-negotiable; this ADR documents the two authorized documentation
  surfaces for the refusal, not a relaxation of it.

## References

- PR-14 Directive v1.0 — LOCKED, §4.1, §4.3, §4.4, §4.5
- PR-14 Directive Amendment v1.0 — LOCKED, §4 (R7_ALLOWLIST second entry)
- API Contracts v1.0 Phase 4 — Four-Layer LinkedIn Refusal Enforcement
- Aramo Charter v1.0 — R7
- PR-13 §8.1-B pre-filing substrate-config diff (originating cause for the
  openapi/ingestion.yaml entry)
- PR-14 Gate 5 v1 §12 report (originating cause for the
  verify-ingestion-refusal.ts entry)
- `scripts/verify-vocabulary.sh` — `R7_ALLOWLIST` (authorization rule)
- `ci/scripts/verify-ingestion-refusal.ts` — the Layer-4 CI tripwire
