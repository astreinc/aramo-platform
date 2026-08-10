# SEG-04 — API/CONTRACT MAP (§6) + PACT/CONSUMER MAP (§7)
Baseline audited: origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4 (PR #589).
Working tree = detached 3a4a3a4 (PR #588). PR#589 delta = placement-UI/repo-map only
(FE placement-api.ts read via `git show origin/main:` where relevant). No API/OpenAPI/Pact
substrate is inside the #589 delta set, so §6/§7 controller+openapi+pact facts below are
faithful to the working tree == origin/main. READ-ONLY; no mutation performed.

=====================================================================
## SECTION 6 — HTTP ROUTE / CONTRACT MAP
=====================================================================

### 6.0 Exact counts (PL-64, no tildes)
- Controller files (excludes false-positive `libs/fe-foundation/src/auth/consumer.ts`,
  which is a comment-only reference, not a @Controller): 55.
- Total HTTP route decorators (@Get/@Post/@Put/@Patch/@Delete/@All): 242.
  (Two independent counts agree: 242.)
- OpenAPI documented operations (operationId count across all 6 yaml): 70.
- Undocumented controller routes (no OpenAPI path/operationId): 242 - 70 = 172.

Method-decorator vocabulary in use: every route carries `@RequireScopes(...)`
(scope enum, 242 occurrences); guard triple `@UseGuards(JwtAuthGuard, EntitlementGuard,
RolesGuard)` on 60 class sites, `(JwtAuthGuard, RolesGuard)` on 5, `(JwtAuthGuard)` on 5.
`@Public` decorator: 0 real usages (only a comment ref, portal-notice.controller.ts:11).
consumer_type gating referenced 41 times; observed literal values: 'recruiter', 'ingestion',
plus 'portal' (portal JWT path). No `@Scopes`/`@RequiredScopes`/`@ConsumerType`/`@Roles`
decorators (naming is `@RequireScopes`).

### 6.1 OpenAPI documented surface (70 ops across 6 files)
- openapi/ats.yaml (28 ops): submittals (create + 5 lifecycle + get + evidence-package = 8;
  NOTE list GET absent), examination override (1), engagements (9), jobs matches (1),
  exports (1), talent-record dossier + dossier/evidence (2), placements (list, create,
  transition, get, events, assignment = 6; NOTE assignment/end absent).
- openapi/auth.yaml (7 ops): /auth/{consumer}/login|callback|refresh|logout(POST)|
  logout(GET)|session + /.well-known/jwks.json.  DIVERGENCE: servers.url declares
  `https://api.aramo.ai/v1` (auth.yaml:22) yet controller mounts `auth/:consumer`
  (auth.controller.ts:130) with NO global prefix (no setGlobalPrefix anywhere) → the
  documented /v1 base does not compose with the live /auth path.
- openapi/common.yaml (6 ops): /consent/{grant,revoke,check,state,history,decision-log};
  server /v1 base composes correctly to live /v1/consent/*.
- openapi/ingestion.yaml (2 ops): /v1/ingestion/payloads, /v1/ingestion/indeed/search-results.
- openapi/platform.yaml (12 ops): full platform-admin surface (all 12 controller routes doc'd).
- openapi/portal.yaml (15 ops): notice, rights/erase, records(+profile/consent x5),
  verifications, disputes(list/open/get/respond/withdraw) = maps to portal.controller (13)
  + portal-notice (1) + portal-rights (1) = 15.

Documented-fully controllers (route count == documented): platform(12), portal(13),
portal-notice(1), portal-rights(1), engagement(9), consent(6), ingestion(2), auth(6),
jwks(1), examination override(1), match-list(1), export(1), dossier(2). Documented-partial:
placement (6/7; assignment/end undoc), submittal (8/9; list GET undoc).

### 6.2 UNDOCUMENTED controller routes — COMPLETE SET (172, no OpenAPI $ref/path)
Reported SEPARATELY per directive. MEMORY-flagged trio CONFIRMED and shown to be a small
fraction of the true undocumented surface. Grouped by controller (route count):

FIRST-PARTY-UI-ONLY (ats-web FE caller + ats-web Pact interaction exists):
- requisition.controller v1/requisitions/* — 13  [MEMORY-flag /v1/requisitions CONFIRMED]
- pipeline.controller v1/pipelines/* — 6         [MEMORY-flag /v1/pipelines CONFIRMED]
- placement.controller POST v1/placements/{id}/assignment/end — 1 [MEMORY-flag CONFIRMED; placement.controller.ts:182]
- submittal.controller GET v1/submittals (list) — 1
- talent-record.controller v1/talent-records/* CRUD+link+resume — 10
- company.controller v1/companies/* — 9
- company d4a.controller v1/companies/.../assignments + teams/.../clients — 7
- identity d4a.controller v1/management/edges + v1/teams* — 8
- tenant-user-management.controller v1/tenant/users/* — 11
- sites.controller v1/tenant/sites/* — 7
- reporting.controller v1/reports/* — 7
- saved-list.controller v1/saved-lists/* — 6
- import.controller v1/imports/* — 6
- task.controller v1/tasks/* — 5
- contact.controller v1/contacts/* — 5
- calendar.controller v1/calendar-events/* — 5
- attachment.controller v1/attachments/* — 4
- activity.controller v1/activities/* — 4
- sourcing.controller v1/sourcing/* — 4
- advisory-resolution.controller v1/talent/identity/advisories/* — 4
- client-talent-restriction.controller v1/clients/.../restrictions/* — 4
- verification-proposal.controller v1/talent/identity/proposals/* — 3
- domain-verification.controller v1/tenant/domain-verification/* — 3
- tenant-profile.controller v1/tenant/profile — 2
- tenant-settings.controller v1/tenant/settings(+/:key) — 2
- address-lookup.controller v1/address-lookup/* — 2
- dispute-resolution.controller v1/talent/identity/disputes/* — 2
- portal-dispute-disposition.controller v1/talent/identity/portal-disputes/* — 7
  (recruiter-side disposition surface; distinct from portal.yaml /v1/portal/disputes)
- dashboard.controller v1/dashboard — 1
- role-catalog.controller v1/tenant/roles-catalog — 1
- audit.controller v1/tenant/audit-events — 1
- assignable-users.controller v1/tenant/assignable-users — 1
- me.controller v1/me — 1
- examine.controller POST v1/examinations (create) — 1
- contradiction-resolution.controller v1/talent/identity/contradictions/:evidenceId/resolve — 1
- reference-attestation.controller v1/talent-records/:recordId/reference-attestations — 1
- pre-start-requirement.controller v1/pre-start-requirement/* — 9

PORTAL / PUBLIC-UNAUTH (portal-web or unauthenticated flows):
- auth/portal request-link + consume (magic-link) — 2 (portal-auth.controller.ts:83)
- email-verification.controller v1/talent-records/:recordId/email-verifications — 2
- public-verification.controller v1/email-verifications/confirm — 1
- public-invitation.controller v1/invitations/accept — 1

EXTERNAL/PARTNER:
- indeed-apply.controller POST v1/webhooks/indeed/apply — 1 (NO @UseGuards; sole authority
  = X-Indeed-Signature HMAC over raw body; indeed-apply.controller.ts:12-13; ships DARK)

Sum of undocumented per group = 172 (reconciles to 242 - 70).

### 6.3 Audience classification (per §6 enum; HTTP route != supported external API)
- FIRST-PARTY-UI-ONLY: the large ats-web block above. 33 ats-web FE api-client modules
  exist (apps/ats-web/src/**/*-api.ts) covering pipeline, requisitions, placement, sourcing,
  contacts, companies, tasks, activities, dashboard, engagement, submittals, talent, users,
  teams, org/edges, settings/*, consent, portal-disputes, trust-proposals,
  identity-advisories, assignments, search, me, invitation-accept, verify-email-confirm.
- PORTAL: portal.controller (documented), portal-notice, portal-rights, auth/portal,
  email-verification, reference-attestation, public-verification; FE apps/portal-web/src/portal-api.ts.
- PLATFORM-ADMIN: platform.controller (documented, platform.yaml); FE apps/platform-web/src/platform-api.ts,
  apps/platform-admin. Separate host (admin.aramo.ai per platform.yaml:23).
- INTERNAL-SERVICE / auth: auth.controller (Cognito consumer flow), jwks.controller.
- INTERNAL-SERVICE / ingestion: v1/ingestion/payloads (ingestion-consumer Pact).
- EXTERNAL/PARTNER: v1/webhooks/indeed/apply (Indeed, HMAC, DARK); v1/ingestion/indeed/search-results.
- NETWORK-REACHABLE-NO-EXTERNAL-CONSUMER / UNKNOWN possibilities: any undocumented route with
  neither an ats-web FE caller nor a Pact interaction — requires per-route confirmation;
  flagged as (iii) below rather than asserted.

### 6.4 openapi:drift-check TRUE capability (grounded)
- Target: package.json:41 `"openapi:drift-check": "node --import jiti/register ci/scripts/compare-spec-to-openapi.ts"`.
- Script header verbatim, compare-spec-to-openapi.ts:3-6:
  "Walks openapi/*.yaml, resolves every $ref, and verifies the referenced / schema (or path
  operation) exists in the target document. Exits non-zero / on broken refs."
- Verified behaviour: main() -> checkRepo() -> readdir openapi/*.yaml -> findRefs() collects
  every `$ref` string (line 29) -> verifyRef() resolves the JSON pointer against the loaded
  target doc (lines 50-71). It reports ONLY broken/unresolvable `$ref`s.
- What it does NOT do: grep of the script for controller|handler|route|@Get|@Post|apps/|libs/|nest
  returns NONE. The script never reads any controller/handler. There is ZERO route<->handler
  comparison in EITHER direction (handler->OpenAPI absent; OpenAPI->handler absent).
- CONCLUSION: MEMORY claim ($ref-integrity-only) CONFIRMED. A GREEN drift-check does NOT
  establish public-route contract parity; the 172 undocumented routes are invisible to it
  (an undocumented live route has no `$ref`, so nothing to break).

=====================================================================
## SECTION 7 — PACT / CONSUMER MAP
=====================================================================

### 7.1 Consumer roots by filesystem (pact/consumers/*) — PRESENT count
Directories present: 6
  ats-web, auth-service-consumer, ingestion-consumer, portal-thin,
  prohibited-source-type, tenant-console-consumer.
Git-TRACKED source present in only 5 of the 6:
  - ats-web (33 tracked files incl. 30 *.consumer.test.ts)
  - auth-service-consumer (auth.consumer.test.ts)
  - ingestion-consumer (ingestion.consumer.test.ts)
  - portal-thin (5 portal-*.consumer.test.ts)
  - prohibited-source-type (prohibited-source-type.consumer.test.ts)
  - tenant-console-consumer: `git ls-files pact/consumers/tenant-console-consumer/` = EMPTY;
    dir contains ONLY untracked node_modules. No src/, no package.json, no vitest.config.
    -> PHANTOM ROOT (no tracked consumer test).

### 7.2 Consumer roots EXECUTED by root `pact:consumer` script — EXECUTED count
package.json:23 verbatim:
  "pact:consumer": "vitest run --root pact/consumers/auth-service-consumer && vitest run
   --root pact/consumers/prohibited-source-type && vitest run --root pact/consumers/ingestion-consumer
   && vitest run --root pact/consumers/portal-thin && vitest run --root pact/consumers/ats-web"
EXECUTED roots: 5 (auth-service-consumer, prohibited-source-type, ingestion-consumer,
portal-thin, ats-web).
NOT executed: tenant-console-consumer.
=> PRESENT dirs (6) != EXECUTED (5) != roots-with-tracked-src (5). Distinct numbers kept per directive.

### 7.3 Generated pact artifacts (pact/pacts/*.json — all UNTRACKED / git-ignored)
`git ls-files pact/pacts/` = EMPTY. Local artifacts observed: 6 json files:
  ats-web-aramo-core, ingestion-consumer-aramo-core, prohibited-source-type-aramo-core,
  portal-thin-aramo-core, auth-service-consumer-aramo-auth-service,
  tenant-console-consumer-aramo-core.
The tenant-console-consumer json is a STALE local artifact (no tracked source to regenerate it).

### 7.4 Provider relationships — TWO providers (kept distinct)
Provider A: `aramo-core` (apps/api) — verifier pact/provider/src/verify-api.ts.
  Loads exactly 4 consumer pacts (verify-api.ts:743-753):
    - ingestion-consumer-aramo-core.json
    - prohibited-source-type-aramo-core.json
    - portal-thin-aramo-core.json
    - ats-web-aramo-core.json
  tenant-console-consumer is RETIRED for this provider (verify-api.ts:62-66:
  "(retired) tenant-console-consumer formerly contributed 5 consent interactions ...
  Suite deleted in the console-FE retirement (PO-attested dead surface)"). The thin
  recruiter consumer is likewise retired (verify-api.ts:67-74).
  => CONSUMERS-VERIFIED-BY-aramo-core = 4.

Provider B: `aramo-auth-service` — SEPARATE verifier pact/provider/src/verify.ts.
  Loads exactly 1 pact (verify.ts:95,233):
    - auth-service-consumer-aramo-auth-service.json
  => CONSUMERS-VERIFIED-BY-aramo-auth-service = 1.
  Run separately (verify.ts:45 "explicitly via `npm run pact:provider`" — but pact:provider
  target = `vitest run --root pact/provider`, package.json:24, runs the whole root).

CONSUMER COUNT vs CONSUMERS-VERIFIED-BY-A-PROVIDER (directive-mandated distinction):
  - Total consumer roots present (dirs): 6
  - Consumer roots with tracked src: 5
  - Consumer roots executed by pact:consumer: 5
  - Consumers verified by aramo-core provider: 4
  - Consumers verified by aramo-auth-service provider: 1
  auth-service-consumer verifies against aramo-auth-service (Provider B), NOT aramo-core —
  it is NOT one of aramo-core's 4. MEMORY distinction CONFIRMED.

### 7.5 Which Pact roots touch which domain (ats-web consumer test files, tracked)
ats-web (30 tracked consumer tests -> aramo-core): activity, advisory, assignments,
attachment, company, consent, contact, domain-verification, dossier, email-verification,
engagement, examination, import-export, org-teams, pipeline, placement, proposals,
reference-attestation, reporting, requisition-draft, requisition, resume-flow, sites,
sourcing, submittal, talent-record, talent-record-detail, task, tenant-settings, tenant-users.
portal-thin -> portal consent/notice/profile/rtbf/p3a. ingestion-consumer -> ingestion.
prohibited-source-type -> sourcing prohibited-source-type guard. auth-service-consumer -> auth.
NOTE: many OpenAPI-UNDOCUMENTED routes (pipeline, requisition, company, contact, task,
activity, reporting, sites, tenant-users, sourcing, talent-record, etc.) DO carry an ats-web
Pact interaction -> they are first-party contract-covered though absent from OpenAPI.

=====================================================================
## DIVERGENCES (typed; flagged, not resolved)
=====================================================================
(i) CONFLICT with tasking/OpenAPI assumptions:
  - 172 of 242 controller routes have NO OpenAPI documentation. MEMORY-flagged trio
    (/v1/pipelines, /v1/requisitions, POST /v1/placements/{id}/assignment/end) CONFIRMED
    and is a small subset. Undocumented surface spans core ATS domains
    (requisition, pipeline, company, contact, task, activity, talent-record, reporting,
    tenant admin, sites, sourcing, imports, calendar, attachments, saved-lists, identity
    resolution, pre-start-requirement).
  - auth.yaml servers.url declares `/v1` base (auth.yaml:22) but auth.controller mounts
    `auth/:consumer` with no global prefix -> documented base does not compose to the live path.

(ii) ASSUMPTION UNVERIFIABLE (needs per-route confirmation, not asserted here):
  - Exact NETWORK-REACHABLE-NO-EXTERNAL-CONSUMER vs FIRST-PARTY set: a route-by-route
    (FE-caller AND Pact-interaction) cross-check for all 172 was not exhaustively performed;
    classification above is by controller group + presence of a matching ats-web-api module.
  - Full error-code inventory per route not extracted exhaustively (242 routes); out of
    proportion for this segment — flagged as a gap, not claimed complete.

(iii) SUBSTRATE MOVED / STALE ARTIFACTS since baseline:
  - pact/consumers/tenant-console-consumer is a phantom root: dir present, ZERO tracked
    source, not executed by pact:consumer, retired from aramo-core provider (verify-api.ts:62),
    yet a stale local tenant-console-consumer-aramo-core.json artifact exists in pact/pacts.
  - pact/pacts/*.json are all untracked (git-ignored, regenerated by pact:consumer).

=====================================================================
Baseline commit hash audited: ca0974090724b36b130f4d39ea5b1ef486d6adf4 (origin/main, PR #589).
NO MUTATION PERFORMED — read-only git/grep/read inspection only. No file written to the repo;
this report records read-only recon observations only.
