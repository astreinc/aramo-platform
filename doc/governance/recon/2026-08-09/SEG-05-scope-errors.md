# SEGMENT 05 — Directive §8 (Authorization/Scope Map) + §9 (Error/Refusal Contract Map)

Baseline audited: origin/main = `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589).
Working tree = detached HEAD `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588), one merge behind.
PR#589 files read via `git show origin/main:<path>` per RECON-CONTEXT caveat.
READ-ONLY. No mutation performed.

================================================================================
## SECTION 8 — AUTHORIZATION / SCOPE MAP
================================================================================

### 8.0 Canonical sources (EXISTS)
- Scope catalog + platform subset + format regex + ScopeDto:
  `libs/identity/src/lib/dto/scope.dto.ts` (319 lines)
  - `SEED_SCOPE_KEYS` (scope.dto.ts:27-290) — 111 keys.
  - `PLATFORM_SCOPE_KEYS` (scope.dto.ts:297-306) — 4 keys.
  - `SCOPE_KEY_FORMAT` (scope.dto.ts:311) — `/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/`.
- Stable id-map: `libs/identity/prisma/seed.ts` `SEED_IDS.scopes` (seed.ts:85-315) — 111 entries.
- Roles map: `SEED_IDS.roles` (seed.ts:60-84) — 14 roles (13 tenant + 1 platform `super_admin`).
- Role bundles (grant matrices): the `*_SEED_BUNDLES` arrays in seed.ts (enumerated below).
- Guard: `@RequireScopes` decorator `libs/authorization/src/lib/require-scopes.decorator.ts`;
  `RolesGuard` `libs/authorization/src/lib/roles.guard.ts`.

### 8.1 EXACT COUNTS
- SEED_SCOPE_KEYS: **111** (verified: awk-extract of quoted keys between the array delimiters).
- SEED_IDS.scopes id-map: **111**.
- PLATFORM_SCOPE_KEYS: **4** (subset of the 111; all four platform keys are IN SEED_SCOPE_KEYS).
- Roles: **14** (SEED_IDS.roles).
- @RequireScopes decorator usages repo-wide (excl. *.spec.ts): **263**.

### 8.2 STRICT BIJECTION STATUS — HOLDS
Guard: `libs/identity/src/tests/scope-catalog-parity.spec.ts`.
- scope-catalog-parity.spec.ts:92-96 — every SEED_SCOPE_KEYS key has exactly one id.
- scope-catalog-parity.spec.ts:98-102 — "no declared id without a catalog key (strict — no exemptions)".
- scope-catalog-parity.spec.ts:85-87 (verbatim): "F-2 CLOSED: platform:tenant:lifecycle:manage
  is now in SEED_SCOPE_KEYS, so the catalog and the id-map are a STRICT bijection — no exemption
  remains. Any NEW declared-id-without-a-catalog-key (or vice versa) now fails outright."
- Creation-parity guard (D-SEED-SCOPES-1): `libs/identity/src/tests/seed-scope-creation-parity.spec.ts`
  proves SEED_IDS.scopes ≡ upserted Scope rows (both sides derived programmatically by running the
  REAL runIdentitySeed against a recording Proxy).
COUNT EQUALITY OBSERVED: 111 (catalog) == 111 (id-map). Bijection currently holds.

PROTECTED zero-grant scopes (hard-coded, scope-catalog-parity.spec.ts:79-83):
  `pre_start_requirement:waive_blocking`, `pre_start_requirement:read_restricted_evidence`,
  `pre_start_requirement:reopen` — asserted EXACTLY zero RoleScope grants (spec lines 173-190).

### 8.3 SCOPE FAMILIES (by `<domain>` prefix; count from programmatic uniq -c; total 111 over 29 prefixes)

| # | Family prefix | keys | Classification |
|---|---|---|---|
| 1 | requisition | 12 | INTERNAL-TENANT-STAFF (requisition:read:all = ADMIN-tier) |
| 2 | pre_start_requirement | 8 | INTERNAL-TENANT-STAFF (3 protected zero-grant) |
| 3 | compensation | 8 | INTERNAL-TENANT-STAFF (field-masking; non-invertibility invariant) |
| 4 | company | 8 | INTERNAL-TENANT-STAFF (company:delete / company:read:all = ADMIN) |
| 5 | tenant | 7 | MIXED: 5 tenant:admin:* = ADMIN; tenant:user:read:{assignable,directory} = INTERNAL-TENANT-STAFF |
| 6 | portal | 7 | PORTAL (portal person-role) |
| 7 | talent | 6 | INTERNAL-TENANT-STAFF (talent:delete = ADMIN; talent:source = sourcer) |
| 8 | placement | 6 | INTERNAL-TENANT-STAFF (Track 3 E1-b/E4) |
| 9 | pipeline | 5 | INTERNAL-TENANT-STAFF (pipeline:remove = ADMIN) |
| 10 | contact | 5 | INTERNAL-TENANT-STAFF (contact:delete = ADMIN) |
| 11 | platform | 4 | ADMIN — PLATFORM-OPERATOR tier (super_admin only; SEPARATE namespace partition) |
| 12 | assignment | 4 | INTERNAL-TENANT-STAFF (Track 4 T4-D) |
| 13 | identity | 3 | MIXED: identity:user:read / identity:tenant:read = STAFF; identity:resolve = ADMIN (TA/TO) |
| 14 | engagement | 3 | INTERNAL-TENANT-STAFF (message-delivery SoD) |
| 15 | consent | 3 | INTERNAL-TENANT-STAFF (tenant-side consent admin) |
| 16 | calendar | 3 | INTERNAL-TENANT-STAFF (calendar:event-delete = ADMIN) |
| 17 | attachment | 3 | INTERNAL-TENANT-STAFF (attachment:delete = recruiter+ carve-out) |
| 18 | activity | 3 | INTERNAL-TENANT-STAFF (activity:redact = oversight tier) |
| 19 | task | 2 | INTERNAL-TENANT-STAFF |
| 20 | submittal | 2 | INTERNAL-TENANT-STAFF |
| 21 | team | 1 | INTERNAL-TENANT-STAFF (AM pod ops) |
| 22 | report | 1 | INTERNAL-TENANT-STAFF (8 operational roles) |
| 23 | org | 1 | INTERNAL-TENANT-STAFF (management-edge mgmt) |
| 24 | import | 1 | INTERNAL-TENANT-STAFF |
| 25 | export | 1 | ADMIN (tenant_admin + tenant_owner) |
| 26 | examination | 1 | INTERNAL-TENANT-STAFF (read-only Core output) |
| 27 | dashboard | 1 | INTERNAL-TENANT-STAFF (8 operational roles) |
| 28 | auth | 1 | INTERNAL-TENANT-STAFF (auth:session:read) |
| 29 | audit | 1 | ADMIN (tenant_admin + tenant_owner) |

SERVICE family: **NONE PRESENT** — no scope key carries a service/API-key consumer. (Indeed Apply
webhook auth is HMAC-SHA1 `X-Indeed-Signature`, NOT scope-gated; MEMORY #468.)
EXTERNAL family: **NONE PRESENT** — no scope is granted to an external party. `portal:*` is the
person-facing family but is a first-party portal role, classified PORTAL not EXTERNAL.

### 8.4 T4 assignment:* family (Track 4 T4-D) — DETAIL
Keys (scope.dto.ts:286-289): `assignment:read` (0xcf), `assignment:create` (0xd0),
`assignment:update` (0xd1), `assignment:end` (0xd2).
Grants (`ASSIGNMENT_SEED_BUNDLES`, seed.ts:1833-1840): recruiter → read only;
account_manager / tenant_admin / tenant_owner → read+create+update+end. super_admin/recruiting_manager/
all others = ZERO. 13 RoleScope rows (ids 0xb00+, seed.ts:1842+).
BACKEND consumers: `apps/api/src/placement/placement.controller.ts:184` `@RequireScopes('assignment:end')`;
:271 `@RequireScopes('assignment:read')`. Controller comment (:178-180): assignment:end is
"NOT reused from placement:* or requisition:assign (§7)."
FE consumers (PR#589, via origin/main): `apps/ats-web/src/placement/AssignmentLifecyclePanel.tsx:64,66`
gate panel on `assignment:read` and END control on `assignment:end` (hasScope); comment :28 —
"the END control follows assignment:end (a distinct scope — placement:* does NOT satisfy)".
`apps/ats-web/src/placement/placement-api.ts:46-59` (origin/main).
assignment:create / assignment:update: catalog+seed+role-matrix present; NO live op / no throw-site
producer (MEMORY: behavioral proofs DEFERRED).

### 8.5 placement:* family (Track 3 E1-b/E4) — DETAIL
Keys (scope.dto.ts:269-277): read/create/transition/activate/terminate/replace (0xc9-0xce).
Grants (`PLACEMENT_SEED_BUNDLES`, seed.ts:1801-1808): recruiter → read+create+transition;
account_manager/tenant_admin/tenant_owner → all six. recruiting_manager/super_admin = ZERO.
21 RoleScope rows (ids 0xa00+). BACKEND: placement.controller.ts:55/89/202/235/271 static
`@RequireScopes`; :95-98 imperative placement:replace conjunction; :141 transition-class DERIVED
`placement:${cls}`. FE: board-derivation.spec.ts:12-13, PlacementBoard.spec.tsx:8-9,
board-derivation.ts:51.

### 8.6 Platform namespace (AUTHZ-2) — DETAIL
4 keys (platform:tenant:provision/read/admin:invite/tenant:lifecycle:manage). All granted to
super_admin ONLY. Backend guard: `apps/platform-admin/src/app/platform/platform.controller.ts`
:69,:106,:126,:137,:166,:193,:218 (provision/read), :238,:261,:283 (lifecycle:manage). Namespace-
partition invariant asserted by RolesGuard/EntitlementGuard separation proofs (scope.dto.ts:293-306).

### 8.7 RENAME-RIPPLE HOT SCOPES (rename would ripple ≥3 checked surfaces — do NOT propose renames)
Every scope rename ripples: SEED_SCOPE_KEYS + SEED_IDS.scopes (strict bijection, hard-fail) +
the owning `*_SEED_BUNDLES` grant literal + @RequireScopes guard literal + OpenAPI (where surfaced)
+ FE `hasScope`/scope-array literal. Highest-blast-radius:
- `talent:search` — REUSED across A1a (talent domain) AND Search PR-1 (search family); scope.dto.ts:55,
  :169-179 note. Two grant rationales pinned to the same key.
- `compensation:view:pay` (+ every compensation:view:* / edit:* — 8 keys) — pinned by the
  `assertNonInvertibleBundle` invariant (libs/field-masking) + D5_COMPENSATION_BUNDLES (seed.ts:1028)
  + d5-non-invertibility.spec; rename ripples the invariant proof.
- `pre_start_requirement:{waive_blocking,read_restricted_evidence,reopen}` — hard-coded in
  scope-catalog-parity.spec.ts:79-83 PROTECTED_ZERO_GRANT_SCOPES; rename breaks the exact-zero assertion.
- `platform:tenant:lifecycle:manage` — appears in BOTH SEED_SCOPE_KEYS and PLATFORM_SCOPE_KEYS
  (scope.dto.ts:126,:305) + drives the namespace-partition separation proof.
- `assignment:end`, `assignment:read`, `placement:replace` — FE (PR#589) + BE controller imperative
  string checks + bundle literals.
- Any `:read:all` / `:delete` — carry the Ruling-1 ADMIN-divergence semantics in-comment; rename
  loses the audited divergence anchor.
Structural guardrails that hard-fail on any drift: scope-catalog-parity.spec.ts (bijection),
seed-scope-creation-parity.spec.ts (D-SEED-SCOPES-1 creation parity), portal-role-scope-parity.spec.ts.
New scope = the D-SEED-SCOPES-1 seed touchpoints (guard-enforced) per CLAUDE.md.

================================================================================
## SECTION 9 — ERROR / REFUSAL CONTRACT MAP
================================================================================

### 9.0 Canonical sources (EXISTS)
- Registry tuple: `libs/common/src/lib/errors/error-codes.ts` `ERROR_CODES` (:267-500).
- HTTP-status map: `libs/common/src/lib/errors/aramo-error.ts` `ERROR_CODE_TO_HTTP_STATUS`
  (:18-123) — `Readonly<Record<ErrorCode, number>>` (TS-exhaustive; missing entry = build error).
- OpenAPI enum: `openapi/common.yaml` `ErrorCode` schema (:1397, enum :1587-1662).
- Parity test: `libs/common/src/tests/error-codes.spec.ts`; CI enforcer `ci/scripts/verify-error-codes.ts`.
- Envelope: `AramoError` (aramo-error.ts:127-144); filter `aramo-exception.filter.ts`.

### 9.1 EXACT COUNTS — TRIPLE PARITY HOLDS
- ERROR_CODES tuple: **75**.
- ERROR_CODE_TO_HTTP_STATUS entries: **75** (TS Record<ErrorCode,number> — exhaustive).
- OpenAPI common.yaml ErrorCode enum members: **75**.
All three == 75. Declaration order pinned identical (common.yaml:1585-1586: "Declaration order in this
enum matches ERROR_CODES tuple order").
NOTE: error-codes.ts:1 + common.yaml:1400 both still describe the registry as a "Closed subset of the
locked 36-code error registry (API Contracts Phase 5)" — the doc-header figure (36) DIVERGES from the
current tuple size (75). Historical-header artifact, not a live contract break (see §9.5 divergence).

### 9.2 ERROR-CODE DOMAIN FAMILIES (75 total)
- Platform/transport/auth cross-cutting (INTERNAL-IMPLEMENTATION / FIRST-PARTY-WIRE):
  AUTH_REQUIRED(401) INVALID_TOKEN(401) TENANT_ACCESS_DENIED(403) VALIDATION_ERROR(400)
  IDEMPOTENCY_KEY_CONFLICT(409) INTERNAL_ERROR(500) INVALID_SCOPE_COMBINATION(422)
  TENANT_SELECTION_REQUIRED(409) REFRESH_TOKEN_INVALID(401) INVALID_REQUEST(400)
  INSUFFICIENT_PERMISSIONS(403) NOT_FOUND(404) TENANT_CAPABILITY_NOT_ENTITLED(403).
- Submittal/examination (M4): SUBMITTAL_STRETCH_BLOCKED JUSTIFICATION_REQUIRED ATTESTATION_MISSING
  EXAMINATION_PINNED_OUTDATED SUBMITTAL_ALREADY_CONFIRMED OVERRIDE_INVALID REVOKE_NOT_ALLOWED
  SUBMITTAL_STATE_INVALID.
- Engagement/AI (M5): ENGAGEMENT_EVENT_REF_NOT_FOUND ENGAGEMENT_REFERENCE_NOT_FOUND
  ENGAGEMENT_STATE_INVALID AI_PROVIDER_UNAVAILABLE(502) AI_RATE_LIMITED(429)
  CONSENT_NOT_GRANTED_AT_SEND(403).
- Pipeline: INVALID_PIPELINE_TRANSITION(422) REQUISITION_NO_OPENINGS(409 RETIRED)
  PIPELINE_EPISODE_ALREADY_LIVE(409) PIPELINE_RECONCILE_LIVE_CONFLICT(409).
- Talent-link / canonicalization / object-storage: TALENT_LINK_INVALID CANONICALIZATION_PAYLOAD_NOT_FOUND
  OBJECT_STORAGE_UPLOAD_FAILED(502) PRESIGNED_URL_EXPIRED(410).
- Saved-list / import: SAVED_LIST_ITEM_TYPE_MISMATCH IMPORT_THRESHOLD_EXCEEDED IMPORT_ALREADY_REVERTED
  IMPORT_REVERT_WINDOW_EXPIRED.
- Platform-tier provisioning (AUTHZ-2): TENANT_ALREADY_EXISTS COGNITO_PROVISION_FAILED(502)
  INVITATION_ALREADY_EXISTS MANAGEMENT_CYCLE_REJECTED.
- Identity/trust/advisory (TR-*): TALENT_RECORD_SUPERSEDED ADVISORY_NOT_PENDING ADVISORY_NOT_MERGED
  ADVISORY_NO_MERGED_SUBJECT MERGE_SUBJECT_NOT_ACTIVE CONTRADICTION_OVERRIDE_REQUIRED(400)
  REVERSAL_JUSTIFICATION_REQUIRED(400) VERIFICATION_CONSENT_REQUIRED(403) CLAIM_SHAPE_INVALID
  EVIDENCE_NOT_CONTRADICTED PROPOSAL_NOT_OPEN EVIDENCE_NOT_DISPUTABLE EVIDENCE_NOT_DISPUTED
  DISPUTE_OUTCOME_INVALID.
- Portal disputes: PORTAL_DISPUTE_NOT_OPEN PORTAL_DISPUTE_EXTENSION_USED.
- Tenant lifecycle (Inc-3): TENANT_SUSPENDED(403) TENANT_CLOSED(403).
- Policy engine: POLICY_DENIED(403).
- Activity redaction: ACTIVITY_NOT_REDACTABLE ACTIVITY_ALREADY_REDACTED.
- Requisition (Track 1): REQUISITION_VERSION_CONFLICT(409) REQUISITION_STATUS_GATED(422).
- Client-talent restriction (E7): RESTRICTION_INVALID RESTRICTION_ALREADY_CLOSED.
- Placement (Track 3 E1-a/E2/E3/E4 + T4-A1): PLACEMENT_STATE_INVALID PLACEMENT_ALREADY_LIVE
  PRE_START_REQUIREMENT_INVALID PRE_START_NOT_READY PLACEMENT_REASON_INVALID
  PLACEMENT_REPLACEMENT_INVALID PLACEMENT_START_CONTEXT_REQUIRED.

### 9.3 MEMORY-REFERENCED CODES — VERIFIED
- `PIPELINE_EPISODE_ALREADY_LIVE` — 409. Producer: `libs/pipeline/src/lib/pipeline.repository.ts:335`
  (throw); sourcing idempotent-catch `apps/api/src/talent-identity/sourcing.service.ts:269`.
  OpenAPI enum:1661. Registry error-codes.ts:498. Classification: FIRST-PARTY-WIRE-CONTRACT.
- `PIPELINE_RECONCILE_LIVE_CONFLICT` — 409. Producer:
  `apps/api/src/talent-identity/record-reconcile.orchestrator.ts:232`. OpenAPI enum:1662.
  error-codes.ts:499. Classification: FIRST-PARTY-WIRE-CONTRACT (merge-time refusal; details.requisition_ids).
- `REQUISITION_STATUS_GATED` — 422. Producer: `libs/requisition/src/lib/requisition.repository.ts:960`.
  OpenAPI enum:1651. error-codes.ts:405. Classification: FIRST-PARTY-WIRE-CONTRACT.
- `REQUISITION_NO_OPENINGS` — RETIRED (see §9.4).
Also verified: PLACEMENT_START_CONTEXT_REQUIRED producer `libs/placement/src/lib/placement.repository.ts:262`;
POLICY_DENIED producers `apps/api/src/talent-identity/sourcing.controller.ts:125`,
`libs/requisition/src/lib/requisition.repository.ts:565,610`.

### 9.4 RETIRED-BUT-STILL-REFERENCED — REQUISITION_NO_OPENINGS (T4-B2 §7)
Status: RESERVED in registry, NO PRODUCER (no throw-site). All references:
- `libs/common/src/lib/errors/error-codes.ts:296` — kept in tuple, comment: "RESERVED, no longer
  emitted — T4-B2 §7 retired ... Kept in the registry for compatibility (still referenced by the
  ats-web pipeline error-message map)."
- `libs/common/src/lib/errors/aramo-error.ts:47` — HTTP 409 status map entry (required for TS exhaustiveness).
- `openapi/common.yaml:1616` — enum member retained; :1454-1461 documents the retirement.
- `libs/pipeline/src/lib/pipeline.repository.ts:78,:511` — COMMENTS ONLY (historical; no throw).
- **DEAD FE HANDLER**: `apps/ats-web/src/pipeline/error-messages.ts:11` —
  `if (error.code === 'REQUISITION_NO_OPENINGS') {` — live branch consuming a code the backend can
  no longer emit (MEMORY: "REQUISITION_NO_OPENINGS frontend dead-handler DEFERRED"). CONFIRMED PRESENT.
Classification: PERMANENT/HISTORICAL (compatibility-retained wire token, non-emitting).

### 9.5 CONTRACT SURFACE (Pact) — TWO DISTINCT NUMBERS
Provider: aramo-core (`pact/provider/src/verify-api.ts`).
- Pact contract JSON files present in `pact/pacts/`: **6** —
  auth-service-consumer-aramo-auth-service.json, prohibited-source-type-aramo-core.json,
  portal-thin-aramo-core.json, ingestion-consumer-aramo-core.json,
  tenant-console-consumer-aramo-core.json, ats-web-aramo-core.json.
- "Consumer count" (distinct consumer names with a pact file): **6**.
- "Consumers VERIFIED BY THIS PROVIDER (aramo-core)": the 5 `*-aramo-core.json` are the
  aramo-core-provider consumers; `auth-service-consumer-aramo-auth-service.json` verifies against a
  SEPARATE provider (aramo-auth-service), NOT aramo-core (per CLAUDE.md: "auth-service-consumer
  verifies against a separate provider"). verify-api.ts:62-70 documents RETIRED consumers
  (tenant-console-consumer, thin recruiter consumer) whose pact files still sit in pact/pacts/ but are
  no longer live-verified. EXACT live-verified-by-aramo-core count NOT independently confirmed from
  verify-api.ts filter in this segment (see §9.6 unverifiable finding).

### 9.6 VOCABULARY SURFACE (CLAUDE.md mandate — Tier-2 exemption inventory)
`scripts/verify-vocabulary.sh` `TIER2_TERMS_REGEX` (:477-485) defines the banned Tier-2 term set (7 terms). Referenced here by source, **not restated inline**: restating them as bare literals would itself fail the verifier (CLAUDE.md discipline; do not "expand for readability"). Authoritative set: `scripts/verify-vocabulary.sh:477-485`.
The scope/error catalog carries banned literals LEGITIMATELY and is EXEMPTED via `TIER2_EXCLUDES`
(the sealed file allowlist, :94+). Exemptions relevant to THIS segment (verbatim paths):
- `libs/identity/src/lib/dto/scope.dto.ts` (portal person-role scopes; the third engagement scope key — both defined verbatim at that source, cited not restated) — listed TWICE
  (two rule groups).
- `libs/identity/prisma/seed.ts` (portal person-role bundles; the third engagement scope bundle) — listed TWICE.
- `libs/identity/src/lib/dto/role.dto.ts` (the portal person-role key, defined verbatim at that source).
- `libs/common/src/lib/errors/error-codes.ts` (registry — CONSENT/engagement code comments).
- `openapi/common.yaml`.
- `ci/scripts/verify-error-codes.ts` (refusal-enforcement script names the terms by design).
NARROW host exemption (:585-592): ONLY the single literal PUBLIC portal host string (cited by source at `scripts/verify-vocabulary.sh:585-592`, not restated here) is stripped
before that term's scan; every other occurrence of the term still fails. No trust-assessment
Tier-2 banned term appears as a bare literal in the §8/§9 checked-in prose reviewed here.

================================================================================
## DIVERGENCES (typed — flagged, NOT resolved)
================================================================================
- (i) CONFLICT-WITH-TASKING-ASSUMPTION — none found on the scope side: strict bijection HOLDS
  (111==111), so the tasking's "verify the bijection currently holds" resolves POSITIVE.
- (iii) SUBSTRATE-MOVED / STALE-HEADER — error-codes.ts:1 and openapi/common.yaml:1400 both label the
  registry a "Closed subset of the locked 36-code error registry", but the live tuple is 75. The "36"
  is a stale doc-header figure (historical baseline), not the enforced count. Flag: doc-header drift.
- (iii) SUBSTRATE-MOVED — REQUISITION_NO_OPENINGS: producer retired (T4-B2 §7) yet the FE dead-handler
  at apps/ats-web/src/pipeline/error-messages.ts:11 remains live (DEFERRED per MEMORY). Flag; the code
  is unreachable from the backend but still branched on client-side.
- (ii) ASSUMPTION-UNVERIFIABLE — "consumers verified by this provider" exact live count: pact/pacts/
  holds 6 JSON files but verify-api.ts:62-70 names RETIRED consumers whose files persist; the precise
  set aramo-core actively verifies today was NOT confirmed from the runtime verify filter in this
  segment. Reported as: 6 pact files; 5 target aramo-core, 1 targets aramo-auth-service; live-verified
  subset unverified here.
- (ii) ASSUMPTION-UNVERIFIABLE — assignment:create / assignment:update have catalog+id-map+role-bundle
  entries but NO throw-site/live-op producer (behavioral proofs DEFERRED per MEMORY); their runtime
  enforcement path could not be grounded to a controller route in this segment.

BASELINE COMMIT AUDITED: origin/main `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589).
Working tree at `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588); PR#589 paths read via git show.
NO MUTATION PERFORMED — read-only git/grep/awk/sed inspection only; no write, edit, commit, push, or
DB/tree change.
