#!/usr/bin/env bash
#
# scripts/verify-vocabulary.sh
#
# PR-1 precedent (two-tier vocabulary enforcement):
#   Tier 1 — R7 LinkedIn gate. The literal "linkedin" is permitted only at
#            paths in the sealed allowlist below. Any other occurrence fails
#            the gate. New allowlist entries require Architect approval per
#            Charter Refusal R7.
#   Tier 2 — Locked-vocabulary discipline. The terms "candidate", "customer",
#            "outreach", "evaluation", "submission", "score", "rank" are
#            scanned across product source but excluded from build artifacts
#            and from documentation files that legitimately reference these
#            terms in anti-pattern examples.
#
# Both lists are literal paths with per-entry comments citing PR-1
# authorization (per Lead-Engineer decision recorded in PR-1).
#
# Runs in CI on every build (.github/workflows/ci.yml `verify:vocabulary`).

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for verify-vocabulary.sh" >&2
  exit 2
fi

# =============================================================================
# Tier 1 — R7 LinkedIn allowlist (sealed)
# =============================================================================
# Paths (literal, not globs) where the literal "linkedin" is permitted to
# appear. Each entry is justified at the time of PR-1 by the actual seeded
# content at that path.
R7_ALLOWLIST=(
  "README.md"                         # PR-1: documents the R7 refusal by name as part of the entry-point overview
  "doc/01-locked-baselines.md"        # PR-1: API Contracts Phase 4 reference ("four-layer LinkedIn refusal")
  "doc/02-claude-code-discipline.md"  # PR-1: Rule 4 references "linkedin_automation_allowed" const constraint
  "doc/03-refusal-layer.md"           # PR-1: R7 canonical specification (Charter-locked refusal layer)
  "doc/04-risks.md"                   # PR-1: RL2 lists "linkedin_automation_allowed" as a never-relax schema
  "doc/06-lead-review-checklist.md"   # PR-1: R7 review check + Pact reference linkedin-rejection.consumer.test.ts
  "eslint.config.mjs"                 # PR-1: header comment documents two-tier design and names the term
  "scripts/verify-vocabulary.sh"      # PR-1: this script itself defines the search pattern and allowlist
  "doc/00-ci-deliberate-failure-evidence.md"  # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1, PO-ratified 2026-05-15): CI evidence doc quotes Charter R10
  "openapi/ingestion.yaml"            # PR-14 ADR-0011, Architect-approved 2026-05-17: R7 Layers 2/4 — x-prohibited-values annotation (§4.3) + SourcePolicyResponse.linkedin_automation_allowed const-false (§4.4)
  "ci/scripts/verify-ingestion-refusal.ts"  # PR-14 ADR-0011 / Directive Amendment v1.0 §4 — verify-ingestion-refusal.ts names linkedin_automation_allowed in its CONST_FALSE_INVARIANTS to enforce R7 Layer 4; mechanical consequence of directive §4.1. Architect-approved 2026-05-17.
  "libs/talent-evidence/prisma/schema.prisma"  # Group 2 §2.2 closed-list enum value (TalentWorkHistoryEntry.source / TalentContactMethod.type) — data-source provenance label, not LinkedIn integration. Charter-Level Review: Aramo-Charter-Review-R7-PR5-LOCKED.
  "libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql"  # Group 2 §2.2 closed-list enum value (TalentWorkHistoryEntry.source / TalentContactMethod.type) — data-source provenance label, not LinkedIn integration. Charter-Level Review: Aramo-Charter-Review-R7-PR5-LOCKED.
  "libs/talent-evidence/src/lib/talent-evidence.repository.ts"  # Group 2 §2.2 closed-list enum value (TalentWorkHistoryEntry.source / TalentContactMethod.type) — data-source provenance label, not LinkedIn integration. Charter-Level Review: Aramo-Charter-Review-R7-PR5-LOCKED.
)

# Glob-form exclusions for paths whose entire subtree is allowed to mention
# the term in legitimate "do not use" prompt / spec documentation.
R7_ALLOWLIST_GLOB=(
  "doc/prompts"                       # PR-2: local prompt drafts use "linkedin_*" in "do not add" guardrails
  "doc/milestone-signoffs"            # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): milestone refusal sign-off records routinely quote Charter
  "doc/adr"                           # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): ADRs may reference refusal commitments
  "Aramo-*-LOCKED.docx"               # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): locked artifact filenames preserved for fidelity
  "Aramo-*-Closure-Record-*.docx"     # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): closure records preserved for fidelity
)

# =============================================================================
# Tier 2 — Vocabulary-discipline exclusions
# =============================================================================
# Paths/globs where Tier 2 forbidden vocabulary is permitted to appear.
# Product source (apps/, libs/) is NEVER excluded — vocabulary discipline
# applies to all source code.
TIER2_EXCLUDES=(
  "node_modules"                      # PR-1: vendored third-party code
  "dist"                              # PR-1: build output
  "build"                             # PR-1: build output
  ".nx"                               # PR-1: Nx workspace cache
  "coverage"                          # PR-1: test coverage output
  "package-lock.json"                 # PR-1: npm dependency resolution metadata
  "**/prisma/generated/**"            # PR-1: per-module Prisma generated client output
  "playwright-report"                 # PR-1: Playwright HTML report output
  "test-results"                      # PR-1: Playwright test output
  "doc/01-locked-baselines.md"        # PR-1: references locked program docs by title
  "doc/02-claude-code-discipline.md"  # PR-1: Rule 5 vocabulary table uses anti-terms in "Not" column
  "doc/03-refusal-layer.md"           # PR-1: refusal anti-patterns use forbidden vocabulary
  "doc/04-risks.md"                   # PR-1: drift risks (D3, RL3) reference anti-terms by name
  "doc/05-conventions.md"             # PR-1: naming-conventions section uses anti-terms in "Never use" list
  "doc/06-lead-review-checklist.md"   # PR-1: review checks reference vocabulary anti-terms
  "doc/07-prompt-template.md"         # PR-1: prompt template uses anti-terms in worked examples
  "doc/adr/0010-verification-byte-fidelity-and-additive-index-maturation.md"  # PR-7.1: ADR codifies vocabulary check at verify-before-drafting tier; cites locked anti-terms in Decision A rationale
  "doc/adr/**"                        # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): ADRs may quote Charter when referencing refusal commitments
  "doc/prompts/**"                    # PR-2: local prompt drafts use anti-terms in "do not use" guardrails
  "doc/milestone-signoffs/**"         # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): milestone refusal sign-off records quote Charter
  "doc/00-ci-deliberate-failure-evidence.md"  # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1, PO-ratified 2026-05-15): CI evidence doc quotes Charter R10
  "Aramo-*-LOCKED.docx"               # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): locked artifact filenames preserved for fidelity
  "Aramo-*-Closure-Record-*.docx"     # PR-M0R-2 Amendment v1.0 §4.2 (Policy 1): closure records preserved for fidelity
  "eslint.config.mjs"                 # PR-1: ESLint vocabulary rule patterns literally contain anti-terms
  "scripts/verify-vocabulary.sh"      # PR-1: this script contains the patterns being searched for
  # PR-M0R-2 Amendment v1.1 §4.5 (Policy 1, PO-ratified 2026-05-15):
  # refusal-enforcement script in ci/scripts/verify-*.ts legitimately
  # contains the terms it enforces against by design. Same structural
  # pattern as the pre-existing TIER2_EXCLUDES entries for
  # scripts/verify-vocabulary.sh and eslint.config.mjs.
  "ci/scripts/verify-ats-refusal.ts"
  "ci/scripts/verify-portal-refusal.ts"
  "ci/scripts/verify-error-codes.ts"
  # PR-14 §4.9: ingestion refusal-enforcement script contains FORBIDDEN_PREFIXES
  # 'evaluation_' / 'rank_' by design (it enforces against them). Same structural
  # pattern as the three pre-existing refusal-script TIER2_EXCLUDES entries.
  "ci/scripts/verify-ingestion-refusal.ts"
  # M3 PR-9: portal refusal-enforcement specs legitimately contain
  # forbidden Match-Class/R10 vocabulary (they enforce against leakage).
  # Same structural pattern as the pre-existing ci/scripts/verify-*.ts
  # entries.
  "apps/api/src/tests/portal-refusal.negative-shape.spec.ts"
  "libs/portal/src/tests/portal.controller.spec.ts"
  # M4 PR-3: submittal-create negative-shape spec (F23 standing pattern)
  # legitimately enumerates the forbidden Match-Class vocabulary as part
  # of its leakage-detection logic. Same structural pattern as the M3
  # PR-9 portal-refusal entry above.
  "apps/api/src/tests/submittal-create.negative-shape.spec.ts"
  # M4 PR-4: submittal-confirm negative-shape spec (F23 standing pattern)
  # legitimately enumerates the forbidden Match-Class vocabulary as part
  # of its leakage-detection logic. Same structural pattern as the M4
  # PR-3 submittal-create entry above.
  "apps/api/src/tests/submittal-confirm.negative-shape.spec.ts"
  # M4 PR-5: override-create negative-shape spec (F23 standing pattern)
  # legitimately enumerates the forbidden Match-Class vocabulary as part
  # of its leakage-detection logic. Same structural pattern as the M3
  # PR-9 / M4 PR-3 / M4 PR-4 entries above.
  "apps/api/src/tests/override-create.negative-shape.spec.ts"
  # M4 PR-6: submittal-get + submittal-evidence-package negative-shape
  # specs (F23 standing pattern) legitimately enumerate the forbidden
  # Match-Class vocabulary as part of their leakage-detection logic.
  # Same structural pattern as the M3 PR-9 / M4 PR-3 / M4 PR-4 / M4
  # PR-5 entries above.
  "apps/api/src/tests/submittal-get.negative-shape.spec.ts"
  "apps/api/src/tests/submittal-evidence-package.negative-shape.spec.ts"
  # M4 PR-7: submittal-revoke negative-shape spec (F23 standing pattern)
  # legitimately enumerates the forbidden Match-Class vocabulary as part
  # of its leakage-detection logic. Same structural pattern as the M4
  # PR-3 / PR-4 / PR-5 / PR-6 entries above.
  "apps/api/src/tests/submittal-revoke.negative-shape.spec.ts"
  # M5 PR-2: engagement event-log substrate carries the canonical product
  # vocabulary `outreach_sent` (an EngagementEventType enum value per
  # Group 2 §3 "engagement outreach" — distinct from the forbidden
  # Match-Class refusal vocabulary; the substring overlap is incidental).
  # Per M5 PR-2 directive Ruling 4 / §4.12. Same structural pattern as
  # the M3 PR-9 / M4 PR-3-7 negative-shape entries above (legitimate
  # forbidden-substring occurrence in domain-specific source).
  "libs/engagement/prisma/schema.prisma"
  "libs/engagement/src/lib/engagement-event.ts"
  "libs/engagement/prisma/migrations/**/migration.sql"
  # Test data for the engagement-event log + cross-schema validator
  # exercises the canonical `outreach_sent` enum value as input fixture.
  # Same rationale as the source-file entries above.
  "libs/engagement/src/tests/engagement-event.repository.integration.spec.ts"
  "libs/evidence/src/tests/evidence.repository.cross-schema-validator.integration.spec.ts"
)

# =============================================================================
# Tier 2 — Forbidden terms (with regex form)
# =============================================================================
# Substring match for entity vocabulary (any form is forbidden); word-boundary
# match for field-name vocabulary (avoid false positives like "underscore").
TIER2_TERMS_REGEX=(
  "candidate:candidate"
  "customer:customer"
  "outreach:outreach"
  "evaluation:evaluation"
  "submission:submission"
  "score:\\bscore\\b"
  "rank:\\brank\\b"
)

EXIT=0

# Build a single ripgrep glob list for shared exclusions.
COMMON_GLOBS=(
  --glob '!node_modules'
  --glob '!dist'
  --glob '!build'
  --glob '!.nx'
  --glob '!coverage'
  --glob '!package-lock.json'
  --glob '!**/prisma/generated/**'
  --glob '!playwright-report'
  --glob '!test-results'
  --glob '!.git'
)

# -----------------------------------------------------------------------------
# Tier 1 — strict LinkedIn gate
# -----------------------------------------------------------------------------
R7_GLOB_FLAGS=()
for g in "${R7_ALLOWLIST_GLOB[@]}"; do
  R7_GLOB_FLAGS+=(--glob "!${g}")
done

matches="$(rg -i --no-heading --line-number --color=never \
  "${COMMON_GLOBS[@]}" \
  "${R7_GLOB_FLAGS[@]}" \
  'linkedin' . || true)"

filtered="$matches"
for path in "${R7_ALLOWLIST[@]}"; do
  filtered="$(printf '%s\n' "$filtered" | grep -v -F "./${path}:" || true)"
done
filtered="$(printf '%s\n' "$filtered" | sed '/^[[:space:]]*$/d')"

if [[ -n "$filtered" ]]; then
  echo "ERROR (R7 — Charter Refusal): 'linkedin' found at non-allowlisted location(s):" >&2
  printf '%s\n' "$filtered" >&2
  echo "" >&2
  echo "Per Charter Refusal R7, 'linkedin' may appear only at allowlisted paths." >&2
  echo "If the path is legitimate, add it to R7_ALLOWLIST in this script with an" >&2
  echo "explicit per-entry comment, AND escalate to Architect (Charter-level review)." >&2
  echo "  (Edit R7_ALLOWLIST in scripts/verify-vocabulary.sh.)" >&2
  EXIT=1
fi

# -----------------------------------------------------------------------------
# Tier 2 — broader vocabulary discipline
# -----------------------------------------------------------------------------
TIER2_GLOBS=()
for excl in "${TIER2_EXCLUDES[@]}"; do
  TIER2_GLOBS+=(--glob "!${excl}")
done

for entry in "${TIER2_TERMS_REGEX[@]}"; do
  term="${entry%%:*}"
  pattern="${entry##*:}"
  matches="$(rg -i --no-heading --line-number --color=never \
    "${TIER2_GLOBS[@]}" \
    "$pattern" . || true)"
  matches="$(printf '%s\n' "$matches" | sed '/^[[:space:]]*$/d')"
  if [[ -n "$matches" ]]; then
    echo "ERROR (Tier 2): forbidden vocabulary '${term}' found:" >&2
    printf '%s\n' "$matches" >&2
    echo "" >&2
    echo "Use locked Aramo vocabulary per doc/02-claude-code-discipline.md Rule 5:" >&2
    echo "  candidate -> talent ; customer -> tenant ; outreach -> engagement" >&2
    echo "  evaluation -> examination ; submission -> submittal" >&2
    echo "  score / rank -> forbidden as Portal fields (R10)" >&2
    echo "  (If a path legitimately requires forbidden vocabulary, edit TIER2_EXCLUDES in scripts/verify-vocabulary.sh.)" >&2
    EXIT=1
  fi
done

if [[ "$EXIT" -eq 0 ]]; then
  echo "OK: vocabulary discipline verified."
  echo "  Tier 1 (R7 LinkedIn refusal): clean — no occurrences outside sealed allowlist."
  echo "  Tier 2 (locked vocabulary): clean — no anti-term matches in product source."
fi

exit "$EXIT"
