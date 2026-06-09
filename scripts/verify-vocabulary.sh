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
  "libs/canonicalization/prisma/schema.prisma"  # T2-2a — bit-identical FOLLOWER copy of libs/talent-evidence's TalentContactType enum (which lists `linkedin` as a closed-list provenance label). The follower is structurally required by Directive §1 Ruling 1 (Option A multi-schema client) and enforced bit-identical by the §1 Ruling 2 mandatory drift-tripwire. Same data-source-provenance-label rationale as the libs/talent-evidence entries above; NOT a new LinkedIn integration. Charter-Level Review: T2-2a Gate-5 Lead review (Aramo-T2-2a-Canonicalization-Orchestration-Directive-v1_0-LOCKED.md §2.4 explicitly names `linkedin|github|portfolio|other` as the contact-type categorisation for the URL-host heuristic).
  "libs/canonicalization/src/lib/canonicalization.repository.ts"  # T2-2a — URL-host heuristic per Directive §2.4: `profile_url` whose hostname is linkedin.com is classified as TalentContactType 'linkedin' (closed-list value mirrored from libs/talent-evidence). Operates on a URL string in storage; NOT a LinkedIn API integration. Same Charter-Level Review as the schema entry above.
  "libs/canonicalization/src/tests/canonicalization.integration.spec.ts"  # T2-2a — integration spec fixture exercises a linkedin.com profile URL to assert the §2.4 URL-host heuristic correctly classifies it as TalentContactType 'linkedin' (the closed-list enum value mirrored from libs/talent-evidence). Test data only; same Charter-Level Review as the production-code entries above.
  "libs/canonicalization/src/tests/canonicalization.tripwires.spec.ts"  # T2-2a — tripwire spec asserts the §2.4 URL-host classifier returns the closed-list 'linkedin' enum value (same Charter-Level Review as the schema/repository entries above; the spec verifies the heuristic, it does NOT introduce a LinkedIn integration).
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
  # PR-A8-2: import-seam INBOUND-vocabulary synonym table. The talent_record
  # identity-field synonym sets accept "candidate" / "applicant" as inbound
  # CSV-header aliases (every OpenCATS / Dice / Indeed / legacy-ATS export
  # carries them) — the heuristic translates them into the canonical
  # `first_name` / `last_name` target fields at the import boundary. NEVER
  # displayed, NEVER stored as a field name. Same translation-purpose
  # pattern as the eslint.config.mjs and scripts/verify-vocabulary.sh
  # entries above — a file that legitimately lists an anti-term because
  # its job is to translate AWAY from it.
  "libs/import/src/lib/mapping/field-catalog.ts"
  # Paired unit spec: constructs "Candidate" / "Applicant" header strings
  # as test input and asserts the heuristic translates them to first_name
  # / last_name. Same lockstep pattern as the M5 PR-6 / PR-7 source +
  # spec entries above.
  "libs/import/src/tests/mapping-suggestion.service.spec.ts"
  # PR-A8-4: OUTBOUND-vocabulary enforcement. The export field-catalog
  # unit spec + the integration spec carry an anti-token list containing
  # `candidate` / `applicant` / `joborder` precisely because they assert
  # the export's CSV header row contains ZERO of these tokens (export
  # speaks Talent; the inbound carve-out at libs/import does NOT apply
  # outbound). Same refusal-enforcement-by-listing-the-anti-terms
  # pattern as the pre-existing PR-A8-2 + ci/scripts/verify-*.ts entries
  # above. Lockstep with the matching eslint.config.mjs TIER2_EXCLUDES
  # entries.
  "libs/export/src/tests/field-catalog.spec.ts"
  "apps/api/src/tests/ats-batch8-pr-a8-4-export.integration.spec.ts"
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
  # M5 PR-8b2: 3 new submittal mainline-transition endpoint negative-
  # shape specs (F23 standing pattern) legitimately enumerate the
  # forbidden Match-Class vocabulary as part of their leakage-detection
  # logic. Same structural pattern as the M3 PR-9 / M4 PR-3 through
  # PR-7 entries above.
  "apps/api/src/tests/submittal-mark-ready.negative-shape.spec.ts"
  "apps/api/src/tests/submittal-submit-to-ats.negative-shape.spec.ts"
  "apps/api/src/tests/submittal-confirm-ats.negative-shape.spec.ts"
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
  # M5 PR-4: HTTP-surface specs and Pact consumer/provider tests for the
  # engagement endpoints exercise the canonical `outreach_sent` enum
  # value in state-transition fixture data + the engagement-controller
  # unit + integration specs reference the same. Same canonical-vocab
  # rationale as the M5 PR-2 entries above.
  # engagement-create.negative-shape.spec.ts enumerates the F23
  # FORBIDDEN_MATCH_CLASS_KEYS array (rank/score/etc.) for recursive-
  # descent leak detection — same structural pattern as the M3 PR-9
  # / M4 PR-3-7 negative-shape entries above.
  "apps/api/src/tests/engagement-create.negative-shape.spec.ts"
  "apps/api/src/tests/engagement-transition.negative-shape.spec.ts"
  # T2-2a — canonicalization R10/R12 structural tripwire spec enumerates
  # the forbidden match-class output vocabulary (tier/score/rank/...)
  # for a recursive-descent leak detection scan against the canonicalize
  # source. Same pattern as the engagement-create.negative-shape.spec.ts
  # entry above. The companion canonicalization.repository.ts entry below
  # covers the R-boundary docstring's "no tier / score / rank / match"
  # disclaimer comment (the same comment-mention precedent as
  # libs/engagement/src/lib/engagement.repository.ts above).
  "libs/canonicalization/src/tests/canonicalization.tripwires.spec.ts"
  "libs/canonicalization/src/lib/canonicalization.repository.ts"
  # T2-3 — canonicalization integration spec proof 8 asserts the
  # talent.canonicalized outbox-event payload is R10-clean by enumerating
  # the forbidden match-class output vocabulary (tier/score/rank/match)
  # as a negative-shape anti-token list against the emitted event keys.
  # Same structural pattern + same Charter-Level rationale as the
  # canonicalization.tripwires.spec.ts entry above (the proof's
  # describe-block comment + the assertion array both legitimately name
  # the forbidden tokens to verify their absence).
  "libs/canonicalization/src/tests/canonicalization.integration.spec.ts"
  # T2-2b — outbox-publisher integration spec asserts the drained
  # talent.canonicalized payload is R10-clean by enumerating the
  # forbidden vocabulary (tier/score/rank/match) as a negative-shape
  # anti-token list. Same structural pattern + same Charter-Level
  # rationale as the canonicalization.tripwires.spec.ts entry above.
  "libs/outbox-publisher/src/tests/outbox-publisher.integration.spec.ts"
  "pact/consumers/ats-thin/src/engagement-create.consumer.test.ts"
  "pact/consumers/ats-thin/src/engagement-transition.consumer.test.ts"
  "pact/consumers/ats-thin/src/engagement-reads.consumer.test.ts"
  "libs/engagement/src/tests/engagement.controller.spec.ts"
  "apps/api/src/tests/engagement.controller.integration.spec.ts"
  # M5 PR-4: OpenAPI common.yaml carries the canonical EngagementEventTypeValue
  # enum with `outreach_sent` per Group 2 §2.3b Loops 3-5 event-emission
  # semantics — the same rationale as libs/engagement/src/lib/engagement-event.ts.
  # Same structural pattern as openapi/ingestion.yaml's R7 enum-value exemption.
  "openapi/common.yaml"
  # M5 PR-6: outreach-send HTTP surface — the new DTOs, delivery-port
  # adapter, F23 negative-shape spec, Pact consumer test, and ats.yaml
  # path documentation carry the canonical `outreach`/`outreach_sent`
  # vocabulary by design (the new POST /v1/engagements/{id}/outreach
  # endpoint + OutreachSentPayload event payload). Same canonical-vocab
  # rationale as the M5 PR-2 / PR-4 entries above.
  "libs/common/src/lib/errors/error-codes.ts"
  "libs/engagement/src/lib/engagement.module.ts"
  # R7 BE-prereq — the engagement scope catalog (`engagement:outreach`
  # as the canonical scope-action vocabulary; same domain-scope-action
  # pattern as `compensation:edit:pay` / `submittal:create`). Mirrored
  # in eslint.config.mjs.
  "libs/identity/src/lib/dto/scope.dto.ts"
  "libs/identity/prisma/seed.ts"
  "libs/engagement/src/index.ts"
  "libs/engagement/src/lib/dto/outreach-send-request.dto.ts"
  "libs/engagement/src/lib/dto/outreach-send-response.dto.ts"
  "libs/engagement/src/lib/dto/outreach-sent-payload.ts"
  # Outreach Draft/Preview Directive v1.0 / Amendment v1.1 — the draft half.
  "libs/engagement/src/lib/dto/outreach-draft-request.dto.ts"
  "libs/engagement/src/lib/dto/outreach-draft-response.dto.ts"
  "libs/engagement/src/lib/dto/outreach-drafted-payload.ts"
  "libs/engagement/src/lib/delivery/delivery-provider.interface.ts"
  "libs/engagement/src/lib/delivery/send-stub.provider.ts"
  "libs/engagement/src/lib/engagement.controller.ts"
  "libs/engagement/src/lib/engagement.repository.ts"
  "apps/api/src/tests/outreach-send.negative-shape.spec.ts"
  "apps/api/src/tests/outreach-send.integration.spec.ts"
  # M5 PR-9b §4.7 / Ruling 10 — consent-at-send refusal integration
  # spec carries the canonical `outreach` vocabulary in fixture + test
  # names (the new spec is a dedicated refusal-class file per Ruling 10
  # rather than an extension of outreach-send.integration.spec.ts).
  "apps/api/src/tests/outreach-send-consent-revoked.integration.spec.ts"
  "pact/consumers/ats-thin/src/outreach-send.consumer.test.ts"
  "openapi/ats.yaml"
  # M5 PR-6 — repository unit + integration tests reference outreach in
  # test names + mocks (the controller spec + apps/api integration
  # spec already appear above under the M5 PR-4 block).
  "libs/engagement/src/tests/engagement.repository.spec.ts"
  "libs/engagement/src/tests/engagement.repository.integration.spec.ts"
  "pact/provider/src/verify-api.ts"
  # M5 PR-7: response-received HTTP surface — new DTOs + Pact consumer +
  # negative-shape spec + integration spec carry the canonical `outreach`
  # vocabulary via the cross-event reference field `outreach_event_ref_id`
  # (Ruling 4) and references to the prior `outreach_sent` event. Same
  # canonical-vocab rationale as the M5 PR-6 entries above (substring
  # overlap with legacy entity-name anti-pattern is incidental).
  "libs/engagement/src/lib/dto/record-response-request.dto.ts"
  "libs/engagement/src/lib/dto/record-response-response.dto.ts"
  "libs/engagement/src/lib/dto/engagement-response-received-payload.ts"
  "apps/api/src/tests/response-received.negative-shape.spec.ts"
  "apps/api/src/tests/response-received.integration.spec.ts"
  "pact/consumers/ats-thin/src/response-received.consumer.test.ts"
  # M5 PR-8a — conversation-started specs traverse /outreach + /response to reach
  # responded precondition; same canonical-vocab rationale as M5 PR-6 + PR-7 entries above
  "apps/api/src/tests/conversation-started.negative-shape.spec.ts"
  "apps/api/src/tests/conversation-started.integration.spec.ts"
  "libs/engagement/src/lib/dto/record-conversation-started-response.dto.ts"
  "libs/engagement/src/lib/dto/engagement-conversation-started-payload.ts"
  "pact/consumers/ats-thin/src/conversation-started.consumer.test.ts"
  # M5 PR-11 Ruling 7: 4 BullMQ background job integration specs
  # (stale-consent + outbox-publisher + cross-schema-consistency +
  # skill-canonicalization). Pattern matches F23 standing per-spec
  # TIER2_EXCLUDES pattern (M5 PR-6/PR-7/PR-8a/PR-9b precedent). PR-11
  # is the first PL-66 Category 5 ratification PR (ADR-0018 Decision 9).
  "libs/consent/src/tests/stale-consent.integration.spec.ts"
  "libs/consent/src/tests/outbox-publisher.integration.spec.ts"
  "libs/common/src/tests/cross-schema-consistency.integration.spec.ts"
  "libs/skills-taxonomy/src/tests/skill-canonicalization.integration.spec.ts"
  # M5 PR-12 (M5-close handoff): the handoff doc quotes Charter v1.2
  # Exit Criteria verbatim (incl. "outreach" — canonical engagement
  # vocabulary in the Charter), the Plan v1.5 §M5 Track A item 2
  # deliverable name (M5 outreach flow with AI-assisted draft generation),
  # prior PR titles (PR-6 outreach surface), and Architecture §9.2
  # Adapter BullMQ job names (incl. "candidate-direct upload" — the
  # Architecture-locked adapter-job nomenclature). Pattern matches the
  # M5 PR-6/PR-7/PR-8a/PR-9b precedent for documents carrying canonical
  # locked-spec vocabulary by design. Per directive §6.8 anticipation.
  "doc/aramo-handoff-m5-close.md"
  # PR-A1a Ruling 3 (Commit Plan v1.0 §1 Ruling B, file-scoped — NOT token-level):
  # `candidate` here is a JWT role-name (the portal-user principal role
  # identifier), NOT entity vocabulary for the talent record. The gate
  # exclusion is path-scoped to the five identity files where this role
  # key appears. The Tier-2 `candidate` ban still applies everywhere else
  # in the tree; any new occurrence outside these paths trips the gate.
  "libs/identity/src/lib/dto/role.dto.ts"
  "libs/identity/src/lib/dto/scope.dto.ts"
  "libs/identity/prisma/seed.ts"
  "libs/identity/src/tests/seed.spec.ts"
  "libs/identity/src/tests/identity.integration.spec.ts"
  # AUTHZ-D5: the seeded-bundle non-invertibility proof iterates every
  # role in the locked role-to-view matrix (D5_COMPENSATION_BUNDLES) —
  # `candidate` here is the JWT role-name (the PR-A1a Ruling 3 portal-user
  # principal), NOT entity vocabulary. Same file-scoped exclusion pattern
  # as the four sibling libs/identity entries above.
  "libs/identity/src/tests/d5-non-invertibility.spec.ts"
  # Settings S5b Ruling 5 (Gate-5): the tenant-console user-management
  # picker mirrors the role catalog (PL-94 §2 ruling 5 — "include candidate;
  # the picker mirrors the catalog"). `candidate` here is the JWT role-name
  # (the PR-A1a Ruling B portal-user principal role identifier), NOT entity
  # vocabulary for the talent record. The mirror lives in the FE because
  # the GET roles-catalog endpoint is a deferred follow-up (PL-94 §2 ruling
  # 2 — hand-mirror + smoke spec). Same file-scoped exclusion pattern as
  # the five sibling libs/identity entries above. Paired with the matching
  # eslint.config.mjs TIER2_EXCLUDES entries.
  "apps/tenant-console/src/users/types.ts"
  "apps/tenant-console/src/users/types.spec.ts"
  "apps/tenant-console/src/users/RolePicker.spec.tsx"
  # PR-A4 Gate 5: ATS Batch 3 R10-enforcement integration spec. Per the
  # M0R-2 Amendment v1.1 §4.5 / PR-A2 R10-spec precedent: refusal-
  # enforcement specs legitimately enumerate the forbidden Match-Class
  # vocabulary as part of their leakage-detection logic. The R10
  # invariant for TalentRecord is asserted by the spec walking the
  # response shape against the forbidden-keys array (rank/score/tier/
  # reasoning/match_*). Same structural pattern as M3 PR-9 portal-
  # refusal and M4 PR-3 submittal-create negative-shape specs.
  "apps/api/src/tests/ats-batch3-talent-record-attachment.integration.spec.ts"
  # Recruiter R6 — the PHASE-B-CARRY (T1) code anchor at the wizard's
  # create-path identity seam references the LOCKED carry filename
  # `Aramo-Carry-T1-Identity-Bridge-and-ATS-Score-Store-Phase-B.md` BY
  # NAME (the directive's mandated debt-containment mechanism — grep-able
  # via "PHASE-B-CARRY"). The filename contains the forbidden token
  # `Score` (locked artifact name; out of this PR's control). Same
  # structural pattern as the `Aramo-*-LOCKED.docx` glob entry above
  # (locked artifact filenames preserved for fidelity).
  "apps/recruiter-console/src/submittals/submittals-api.ts"
  "apps/recruiter-console/src/submittals/SubmittalWizard.tsx"
  # Recruiter R7 — the engagement FE surface (the recruiter-console consumer
  # of the engagement backend). `outreach` appears here as the canonical
  # engagement event-type discriminant (`outreach_drafted` / `outreach_sent`),
  # the response-picker source (a response answers a prior `outreach_sent`
  # event — `outreach_event_ref_id`), and the recruiter-facing product
  # vocabulary in copy ("Outreach sent" / "the selected outreach") — NOT a
  # misuse of `outreach` as a standalone entity name competing with
  # `engagement`. Same canonical-vocabulary rationale as the libs/engagement
  # M5 PR-2/PR-6/PR-7 entries above. Lockstep with the matching
  # eslint.config.mjs TIER2_EXCLUDES entries.
  "apps/recruiter-console/src/engagement/types.ts"
  "apps/recruiter-console/src/engagement/engagement-api.ts"
  "apps/recruiter-console/src/engagement/EventLog.tsx"
  "apps/recruiter-console/src/engagement/ResponseLogger.tsx"
  "apps/recruiter-console/src/engagement/EngagementDetailView.tsx"
  "apps/recruiter-console/src/engagement/error-messages.ts"
  "apps/recruiter-console/src/engagement/EngagementDetailView.spec.tsx"
  # Recruiter R7 PR-2 — the draft→preview→send outreach composer. Same
  # canonical-vocabulary rationale as the PR-1 entries above; lockstep with
  # the matching eslint.config.mjs TIER2_EXCLUDES entries.
  "apps/recruiter-console/src/engagement/OutreachComposer.tsx"
  "apps/recruiter-console/src/engagement/OutreachComposer.spec.tsx"
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
