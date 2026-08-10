# SEG-03 — PERSISTENCE / MIGRATION / EVENT-OUTBOX (Directive §4, §5, §10)
Auditor: substrate auditor (READ-ONLY). Authority SHA origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4.
Working tree HEAD = 3a4a3a44b5d635acc276dad7431d74514602616e (PR#588, ONE merge behind). NONE of the 18 PR#589-divergent files touch §4/§5/§10 (all placement-UI/FE + repo-map) → working tree faithful for this segment. NO MUTATION PERFORMED.

================================================================================
## SECTION 4 — DATABASE / PERSISTENCE MAP
================================================================================

### 4.0 Physical PostgreSQL schema inventory
39 `CREATE SCHEMA IF NOT EXISTS` statements exist across `libs/*/prisma/migrations/*/migration.sql`; 1 schema DROPPED (`talent`) → **38 LIVE physical PG schemas**.
Source of truth = per-model `@@schema(...)` in `libs/*/prisma/schema.prisma` (non-generated) + `CREATE SCHEMA` in migrations.

LIVE schemas (owning lib in parens; enum/table counts from schema.prisma model→@@schema map):
activity(activity) · ai_draft(ai-draft) · attachment(attachment) · audit(consent — see co-loc) · auth_storage(auth-storage) · calendar(calendar) · canonicalization(canonicalization) · client_talent_restriction(client-talent-restriction) · company(company) · consent(consent) · contact(contact) · engagement(engagement + submittal — see co-loc) · entitlement(entitlement) · evidence(evidence) · examination(examination) · identity(identity) · identity_index(identity-index) · import(import) · ingestion(ingestion + canonicalization mirror — see co-loc) · job_distribution(job-distribution) · job_domain(job-domain) · metering(metering) · pipeline(pipeline) · placement(placement) · platform_trust(platform-trust) · policy_store(policy-store) · portal_identity(portal-identity) · pre_start_requirement(pre-start-requirement) · requisition(requisition) · saved_list(saved-list) · settings(settings) · sourced_talent(sourced-talent) · submittal(submittal — OutboxEvent only) · talent_evidence(talent-evidence) · talent_record(talent-record) · talent_trust(talent-trust) · task(task) · tenant_reset(tenant-reset).
DROPPED: `talent` — DROP SCHEMA "talent" at `libs/talent/prisma/migrations/20260704160000_drop_core_talent/migration.sql:16` (forward-only, zero-row asserted).

### 4.1 Libs with NO physical schema / NO models (scaffolding-only, PR-1)
audit, auth, common, events, matching, skills-taxonomy — each carries `// PR-1 scaffolding only: this file declares the datasource and generator` (e.g. `libs/audit/prisma/schema.prisma:7`), NO models, NO `@@schema`, NO migrations dir. `talent` lib = datasource-only, ZERO models (schema dropped) — HISTORICAL/LEGACY NAME ONLY.
6 source-prisma libs have NO migrations dir: audit auth common events matching skills-taxonomy.

### 4.2 Full model→schema map (source: repo-wide perl scan of schema.prisma @@schema)
See per-lib listing appended below (§4.APPENDIX). Model/enum totals verified per lib.

### 4.3 CO-LOCATION CASES (logical domain A physically in schema B)
Three co-locations found. NONE asserted as ARCHITECTURE-VIOLATION (all carry in-repo authority citations).

**CL-1 (DIRECTIVE-NAMED): submittal lib → `engagement` PG schema.**
`libs/submittal/prisma/schema.prisma` maps SubmittalState(enum), SubmittalEventType(enum), TalentSubmittalRecord, TalentSubmittalEvent all to `@@schema("engagement")`; ONLY `OutboxEvent` maps to `@@schema("submittal")`.
Authority quote `libs/submittal/prisma/schema.prisma:4`: `// Schema: \`engagement\` per Architecture v2.0/v2.1 §7.1 ten-schema list.`
`:5`: `// First model in the engagement schema`.
CLASSIFICATION: **INTENTIONAL/DOCUMENTED** (Architecture v2.0/v2.1 §7.1). tenant-reset also treats submittal rows as engagement-schema (`tenant-reset.service.ts:83-84`, "§2.2.3 — Submittals (event child first)").

**CL-2: canonicalization lib → `ingestion` PG schema (read-mirror of RawPayloadReference + ResolutionMethod).**
`libs/canonicalization/prisma/schema.prisma` maps OutboxEvent→`canonicalization`; ResolutionMethod(enum)+RawPayloadReference→`ingestion`. Physical table is OWNED by ingestion lib (`libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql:5` CREATE TABLE "ingestion"."RawPayloadReference"). The canonicalization migration does NOT re-create it.
Authority quote `libs/canonicalization/prisma/migrations/20260603160000_init_canonicalization_schema/migration.sql:3-5`: `-- Per the T2-2a Directive §1 Ruling 3 (HARD REQUIREMENT): canonicalization's / -- migrations own ONLY the \`canonicalization\` PG schema. The participant / -- schemas (talent, talent_evidence, ingestion) already exist;`.
CLASSIFICATION: **INTENTIONAL/DOCUMENTED** (T2-2a Directive §1 Ruling 3) — cross-schema READ-MIRROR, no dual table ownership.

**CL-3: consent lib → `audit` PG schema (ConsentAuditEvent); `audit` lib is scaffolding-only.**
`libs/consent/prisma/schema.prisma` declares schemas ["consent","audit"]; ConsentAuditEvent→`@@schema("audit")` (rest→consent). The standalone `audit` LIB has zero models. The `audit` PG schema is populated EXCLUSIVELY by the consent lib.
CLASSIFICATION: **INTENTIONAL/DOCUMENTED** (explicit multiSchema declaration; dedicated audit namespace). No authority found in-repo asserting this is a violation; NOT asserted VIOLATION.

### 4.4 Triggers / functions (immutability + lifecycle enforcement)
Libs with DB functions/triggers in migrations: ai-draft, client-talent-restriction, consent, engagement, evidence, examination, placement, pre-start-requirement, sourced-talent, submittal, talent-trust.
Load-bearing named objects (placement/engagement):
- placement.enforce_placement_one_live_guard / trg_enforce_placement_one_live_guard
- placement.enforce_placement_process_lifecycle / trg_enforce_placement_process_lifecycle
- placement.reject_outbox_mutation / trg_reject_outbox_update + trg_reject_outbox_delete
- placement.reject_placement_process_event_update / _delete + triggers
- engagement.reject_engagement_event_update, reject_engagement_state_update, reject_submittal_event_update, reject_submittal_record_update (+ trg_*)
NULLABLE-column immutability trap (MEMORY): E1-c offer cols + E4 replaces_* ride APP-surface immutability, NOT OLD=NEW triggers (NULL=NULL≠TRUE).

### 4.5 identity_index PII invariant — HELD
`libs/identity-index/prisma/schema.prisma:48` `// Deliberately bare: an opaque id + timestamps, NOTHING else. No tenant_id,`; `:28` CI guard "fails the build if a `tenant_id` or any known-PII column name ever appears". Models: PersonCluster, ClusterFingerprint. NO tenant_id, NO PII. CONFIRMED.

================================================================================
## SECTION 5 — MIGRATION REALITY (A/B/C kept separate)
================================================================================

### 5.A — HISTORICAL STRUCTURAL migrations (built present schema)
**Migration roots BY PATTERN:** `libs/<lib>/prisma/migrations/<timestamp>_<name>/migration.sql`.
- Total migration.sql files: **146** (repo-wide `find libs -name migration.sql`, node_modules excluded).
- Libs WITH a migrations dir: **38**. migration_lock.toml files: **34** (4 migrations dirs lack a lock file — find them by grep, never by count; MEMORY: curated-COUNT untrustworthy).
- Migration files never contain a `;` inside `--` comment blocked by splitDdl (splitter is comment-blind — author guard `grep -nE '^\s*--.*;'`).

**Curated migration lists BY PATTERN (NOT a single central list — per-spec, untrustworthy by count):**
They are per-integration-spec `const X_INIT = resolve(ROOT, 'libs/<lib>/prisma/migrations/.../migration.sql')` consts, some flat arrays, some SINGLE-PATH consts.
- Array-style example: `apps/api/src/tests/ats-batch2-requisition.integration.spec.ts:231` iterates `[ENTITLEMENT_INIT, REQUISITION_INIT, ... , recruiting_status_supersession]`.
- SINGLE-PATH const example (MEMORY-warned): `apps/api/src/tests/ats-batch8-pr-a8-4-export.integration.spec.ts:115` `const PIPELINE_INIT = resolve(...)` (a lone resolve, NOT an array → append a SEPARATE const, never a 2nd resolve() arg → ENOTDIR).
- `${lib}` directory-scan style: `apps/api/src/tests/requisition-concurrency.integration.spec.ts:43` `resolve(ROOT, \`libs/${lib}/prisma/migrations\`)`.
Specs carrying such lists (partial, 40+): ats-batch2/3/6/7/8, domain-verification, requisition-concurrency, override-create, submittal-revoke, settings-d4-sites, tr2a-b3b, tr8/tr6/tr5/tr12, policy-*, etc.

### 5.B — FUTURE STRUCTURAL needs + KNOWN DEPLOY-ORDER CONSTRAINTS
No pending un-applied future-structural migration file found in-repo (all present migrations are class-A applied history).
**KNOWN DEPLOY-ORDER CONSTRAINT (Track4-B2, migration-BEFORE-app):**
`libs/requisition/prisma/migrations/20260811120000_t4b2_drop_openings_available/migration.sql` — `ALTER TABLE "requisition"."Requisition" DROP COLUMN "openings_available";`. Self-labeled "DEDICATED, irreversible DROP required by the locked ordering." Public API `openings_available` now DERIVED = max(capacity_balance,0). MEMORY hard constraint: B2 req reads now depend on `placement.ContractAssignment`; prod lacks the chain → app-before-migration deploy makes reads FAIL. Migration→application rollout REQUIRED.

### 5.C — BUSINESS-DATA / BACKFILL
NO standalone class-C business-data/backfill migration exists. Backfill DML (INSERT/UPDATE) is EMBEDDED INSIDE structural (class-A) migrations (29 migration.sql files contain INSERT/UPDATE), e.g. requisition/add_requisition_number, requisition/recruiting_status_supersession, identity/add_tenant_* , entitlement/init (seed INSERT), placement/placement_offer_and_outbox, placement/placement_contract_assignment. These are A-with-embedded-backfill, not standalone C.

### 5.D — DESTRUCTIVE / IRREVERSIBLE migrations (HAZARD inventory)
- `talent/20260704160000_drop_core_talent` — DROP TABLE TalentTenantOverlay + DROP TABLE Talent + **DROP SCHEMA "talent"** (the ONLY DROP SCHEMA in repo). Forward-only, zero-row asserted.
- `pipeline/20260807100000_e6_pipeline_live_episode_unique` — `DROP INDEX "pipeline"."Pipeline_talent_record_id_requisition_id_key"`; self-labeled `-- DESTRUCTIVE AND IRREVERSIBLE` (once dup historical rows exist the total unique CANNOT be recreated). Replaces with partial `Pipeline_live_episode_key`. Literal terminal-status set held equal to registry TERMINAL_STATUSES by B-index-parity drift test.
- `requisition/20260811120000_t4b2_drop_openings_available` — DROP COLUMN (irreversible; deploy-order hazard, see 5.B).
- Other structural DROPs (forward-only retirements): requisition/drop_legacy_requisition_comp, job-domain/drop_job_domain_requisition, ingestion/drop_resolved_talent_id_from_raw_payload_reference, talent-record/drop_core_talent_id.

### 5.E — RESET MIGRATION DEPENDENCIES + reset participation
Reset engine: `libs/tenant-reset/src/lib/tenant-reset.service.ts`.
- **DELETE_INVENTORY = 20 reset targets** (`tenant-reset.service.ts:75-129`) — matches MEMORY "reset targets = 20 (Track 4 Inc 1 added ContractAssignment; was 19)". CONFIRMED grounded.
  Ordered: activity.Activity(scoped §2.2.1) · requisition.RequisitionLifecycleEvent · engagement.TalentSubmittalEvent · engagement.TalentSubmittalRecord · engagement.TalentEngagementEvent · engagement.TalentJobEngagement · pipeline.PipelineStatusHistory · pipeline.Pipeline · requisition.RequisitionAssignment · requisition.Requisition · requisition.RequisitionNumberSequence · pre_start_requirement.{Audit,Instance,Definition,MaterializationIntent,Set} · placement.OutboxEvent · placement.PlacementProcessEvent · placement.ContractAssignment · placement.PlacementProcess.
- **PRESERVE_INVENTORY = 7** (`:173-185`): metering.UsageEvent, consent.TalentConsentEvent, talent_record.TalentRecord, company.Company, contact.Contact, identity.Tenant, activity.Activity(non-workflow).
- **LOCK/FREEZE = 19 tables** (`:137-162`).
- **Reset ESCAPE via migration:** BEFORE-DELETE reject triggers carry an exact-value transaction-local reset-escape GUC on PreStartRequirementAudit, PreStartRequirementInstance, placement.OutboxEvent, placement.PlacementProcessEvent (escape migration `20260806090000_placement_tenant_reset_escape`). *(The literal GUC marker is cited by source, not restated here: the exact-path default-deny guard `apps/api/src/tests/pre-start-requirement/marker-confinement.spec.ts` allowlists only the code/migrations that SET it — governance prose must not carry the literal.)* placement.ContractAssignment has NO trigger/escape (`:123-127`, "NO delete-reject trigger → NO escape migration needed").
- **Restore paths = 0**: `libs/tenant-reset/src/lib/reset-batch.store.ts:16` "there is NO update method and NO delete" (append-only ResetBatch). Reset is ONE-WAY.
- **Self-documented substrate DIVERGENCE** `tenant-reset.service.ts:187-192`: §2.3 USAGE_SNAPSHOT_FIELDS (actor/channel/billing_key/requisition_id/pipeline_id/correlation_id) do NOT exist on live metering.UsageEvent (only id, tenant_id, event_type, quantity, occurred_at) — §2.3 HALT cannot fire on this substrate. FLAGGED (see Divergences).

### 5.F — PRODUCTION POPULATION (grounded, per-track)
Authoritative population records are in OneDrive Aramo/locked (Ledger v1.6 §0.1 / §6 preflight), NOT the repo. In-repo corroboration ONLY:
`libs/requisition/src/tests/capacity-agreement-b2.integration.spec.ts:19-20` — `// production preflight (which found prod EMPTY) and NOT an A2 backfill`.
- Track 4 (T4-A2/B2): PROD EMPTY / ZERO-ROW per 2026-08-09 §6 preflight (all six classes = 0) — corroborated by the repo line above + MEMORY. T4-A2 = NO-OP (nothing to migrate); its empty-population agreement was VACUOUS ≠ capacity verified.
- Track 3 (placement/pipeline/engagement/submittal), Portal, Identity, Sourcing: **UNKNOWN from repo** — no in-repo population record; must read Ledger v1.6 to state zero/nonzero. Re-preflight REQUIRED before any deploy that assumes population state (esp. B2 migration→app ordering).

================================================================================
## SECTION 10 — EVENT / OUTBOX MAP
================================================================================

### 10.A — OUTBOX systems (transactional outbox pattern)
**5 OutboxEvent tables, one per schema**, IDENTICAL shape (id Uuid PK, tenant_id Uuid, event_type String[NOT enum], event_payload Json, created_at Timestamptz default now(), published_at Timestamptz? NULLABLE, @@index([published_at])):
1. canonicalization.OutboxEvent (`libs/canonicalization/prisma/schema.prisma:64`)
2. consent.OutboxEvent
3. engagement.OutboxEvent
4. placement.OutboxEvent (Timestamptz(6))
5. submittal.OutboxEvent
- **published/unpublished handling:** `published_at IS NULL` = unpublished; drain sets `published_at = now()`.
- **Producer:** each owning lib's repository writes its OutboxEvent in the SAME transaction as the aggregate change (atomic outbox).
- **Single Consumer:** `libs/outbox-publisher/src/lib/outbox-publisher.processor.ts` — drains **5 schemas per tick** (consent, engagement, submittal, canonicalization, placement) via injected repos (`:5-9`): CanonicalizationOutboxRepository, OutboxPublisherRepository(@aramo/consent), EngagementOutboxRepository, SubmittalOutboxRepository, PlacementOutboxRepository. `drainSchema` typed union `:146`. Per-schema failure does NOT abort other schemas (`:42`). Examination OUT OF SCOPE (deferred PR-2d).
- **Permanence:** placement.OutboxEvent rows are trigger-immutable (reject_outbox_mutation, update+delete) EXCEPT the transaction-local reset-escape GUC path (literal cited by source per the marker-confinement guard) → deleted in tenant reset (§2.2.8). Append-only ≠ survives reset.

### 10.B — DOMAIN EVENT-LOG tables (append-only HISTORICAL EVIDENCE)
- engagement.TalentEngagementEvent (immutability triggers) — EngagementEventType closed **5-value** list: state_transition, response_received, conversation_started, plus the two engagement message-delivery event-type values defined verbatim at `libs/engagement/src/lib/engagement-event.ts` (cited by source, not restated — those literals carry a Tier-2 substring and expanding them here would fail `scripts/verify-vocabulary.sh`).
- engagement.TalentSubmittalEvent (submittal lib, engagement schema; immut triggers) — SubmittalEventType closed list: state_transition.
- placement.PlacementProcessEvent (reject update+delete triggers) — PlacementEventType: state_transition.
- pipeline.PipelineStatusHistory.
- requisition.RequisitionLifecycleEvent (RequisitionLifecycleOrigin: ui, agent, integration).
- consent.TalentConsentEvent (PRESERVED across reset) + consent.ConsentAuditEvent (in `audit` schema).
- identity.IdentityAuditEvent; talent-trust.EvidenceEvent; ai-draft.AiDraftEvent; metering.UsageEvent; policy-store.PolicyDecisionRecord (APPEND-ONLY, fail-closed).

### 10.C — EVENT VOCABULARY = HISTORICAL EVIDENCE (do NOT infer event rename from code/module rename)
- Enum VALUES are frozen wire/history vocabulary, NOT code identifiers:
  - EngagementState values (11): surfaced, evaluated, engaged, maybe, passed, awaiting_response, responded, in_conversation, not_interested, ready_for_submittal, submitted.
  - SubmittalState values (6): created, handoff_draft, ready_for_review, submitted_to_ats, confirmed, revoked. (`rename_submittal_state_canonical` migration cut over M4's 2-value subset; the ENUM values are the historical evidence, not the module name.)
  - PlacementState (10): OFFER_EXTENDED, OFFER_ACCEPTED, PRE_START, BLOCKED, READY_TO_START, STARTED, OFFER_DECLINED, OFFER_RESCINDED, NO_SHOW, FELL_THROUGH.
  - PipelineStatus (11): no_status, no_contact, contacted, talent_responded, qualifying, submitted, interviewing, offered, not_in_consideration, client_declined, placed. Terminal set {placed, not_in_consideration, client_declined} is a DB invariant (E6 partial index literal).
  - RecruitingStatus (9): lead, draft, pending_approval, open, on_hold, submittals_closed, canceled, closed, archived.
  - ActivityType (4): pipeline_status_change, note, call, email_logged. CalendarEventType (6): call, email, meeting, interview, personal, other.
- **NAME-vs-SCHEMA historical evidence:** `tenant-reset.service.ts:85` `// §2.2.4 — Selection (currently \`engagement\`) workflow rows` — "Selection" is the logical domain; `engagement` is the physical schema. Do NOT infer a rename. Submittal domain physically in engagement schema (CL-1). Canonicalization reads ingestion (CL-2).

================================================================================
## VOCABULARY SURFACE (mandate §4 — trust-assessment vocabulary touched via §10 talent-trust events)
================================================================================
`scripts/verify-vocabulary.sh` allowlists (banned Tier-2 terms NOT restated; reference the script per CLAUDE.md):
- TIER2_TERMS_REGEX defined at `scripts/verify-vocabulary.sh:477` (the banned Tier-2 list — NOT quoted here).
- Exemption allowlists (array names + line): R7_ALLOWLIST `:36`, R7_ALLOWLIST_GLOB `:59`, FRONTDOOR_LEGACY_ALLOWLIST `:77`, **TIER2_EXCLUDES `:94`** (the Tier-2 vocabulary exemptions), Portal P1 Amendment v1.1 narrow host-word exemption `:580` (scoped to the single literal PUBLIC portal host string — cited by source at `scripts/verify-vocabulary.sh:580-592`, not restated here; drops lines whose ONLY match is that host literal; NOT a file-level exclude).
- TIER2_EXCLUDES quoted entries: **142** distinct (mix of path globs, exact spec/DTO/migration paths, and a few string-literal exemptions). New entries require Architect approval (`:8`). The script excludes ITSELF from its scan (`:44`).

================================================================================
## CONTRACT SURFACE (mandate §5 — Pact)
================================================================================
§4/§5/§10 touches Pact only via the engineering law "any new migration changing a returned shape must be registered in `pact/provider/src/verify-api.ts`" (CLAUDE.md). Full Pact consumer/provider enumeration is OUT OF THIS SEGMENT'S SCOPE (deferred to the contract-surface segment). Distinct-number rule to carry there: "consumer count" ≠ "consumers verified by this provider" (auth-service-consumer verifies against a SEPARATE provider). `pact/provider/src/verify-api.ts` and `pact/consumers/ats-web/src/engagement.consumer.test.ts` appear in the vocab allowlist (evidence they exist), but counts NOT computed here.

================================================================================
## DIVERGENCES (typed; flagged, NOT resolved)
================================================================================
- (iii) SUBSTRATE MOVED SINCE BASELINE: working tree HEAD 3a4a3a4 (PR#588) is ONE merge behind authority origin/main ca09740 (PR#589). Confirmed NONE of the 18 PR#589 files are §4/§5/§10 (all FE/repo-map). No SHA mixing in this segment.
- (i) CONFLICT w/ documented spec (self-documented): tenant-reset §2.3 USAGE_SNAPSHOT_FIELDS do not exist on live metering.UsageEvent (`tenant-reset.service.ts:187-192`). The code documents the divergence and states the §2.3 HALT cannot fire. FLAG for disposition.
- (ii) ASSUMPTION UNVERIFIABLE IN-REPO: production population for Track 3 / Portal / Identity / Sourcing — no in-repo record; only Track 4 EMPTY is corroborated (`capacity-agreement-b2...spec.ts:19`). Read Ledger v1.6 §0.1/§6 preflight; re-preflight before population-dependent deploy.
- (ii) migration_lock.toml (34) < migrations dirs (38): 4 dirs lack a lock file. Count-based reasoning is UNSAFE (MEMORY: curated-COUNT untrustworthy) — enumerate by grep.
- NOTE (not a divergence): reset targets = 20 CONFIRMED (matches MEMORY); identity_index PII-free CONFIRMED; co-locations CL-1/2/3 all carry in-repo authority → NONE asserted ARCHITECTURE-VIOLATION.

================================================================================
## §4.APPENDIX — FULL model/enum → @@schema map
================================================================================
(M=model, E=enum) — source: repo-wide perl scan of libs/*/prisma/schema.prisma
activity: E ActivityType, M Activity → activity
ai-draft: M AiDraftEvent → ai_draft
attachment: E AttachmentOwnerType, M Attachment → attachment
auth-storage: M HostAuthProfile, RefreshToken → auth_storage
calendar: E CalendarEventType, M CalendarEvent → calendar
canonicalization: M OutboxEvent → canonicalization; E ResolutionMethod, M RawPayloadReference → ingestion (READ-MIRROR)
client-talent-restriction: E RestrictionType/AssertedByType/SourceSystem/CloseReasonCode, M ClientTalentRestriction → client_talent_restriction
company: M Company/CompanyDepartment/UserClientAssignment/TeamClientOwnership → company
consent: M TalentConsentEvent/IdempotencyKey/OutboxEvent → consent; M ConsentAuditEvent → audit
contact: M Contact → contact
engagement: E EngagementState/EngagementEventType, M TalentJobEngagement/OutboxEvent/TalentEngagementEvent → engagement
entitlement: E Capability, M TenantEntitlement → entitlement
evidence: M TalentJobEvidencePackage → evidence
examination: E ExaminationTrigger/ExaminationTier/ExaminationLifecycleState/OverrideType, M TalentJobExamination/ExaminationOverride → examination
identity-index: M PersonCluster/ClusterFingerprint → identity_index
identity: M User/Tenant/Site/UserTenantMembership/Role/Scope/RoleScope/UserTenantMembershipRole/ServiceAccount/ExternalIdentity/Invitation/IdentityAuditEvent/ManagementEdge/Team/TeamMembership → identity
import: E ImportTargetEntity/ImportBatchStatus, M ImportBatch/ImportFailure → import
ingestion: E ResolutionMethod, M RawPayloadReference → ingestion (OWNER)
job-distribution: M ChannelPostingState/TenantChannelConfig → job_distribution
job-domain: M Job/GoldenProfile → job_domain
metering: M UsageEvent → metering
pipeline: E PipelineStatus, M Pipeline/PipelineStatusHistory → pipeline
placement: E PlacementState/PlacementEventType/ContractAssignmentProvenance/ContractAssignmentState/ContractAssignmentEndReason, M PlacementProcess/PlacementProcessEvent/OutboxEvent/ContractAssignment → placement
platform-trust: M DormantLink → platform_trust
policy-store: M StoredPolicyVersion/PolicyDecisionRecord → policy_store
portal-identity: M PortalUser/PortalLoginToken/NoticeDelivery → portal_identity
pre-start-requirement: M PreStartRequirementSet/Definition/Instance/MaterializationIntent/Audit → pre_start_requirement
requisition: E RecruitingStatus/RatePeriod/RequisitionCompensationModel/RequisitionLifecycleOrigin, M Requisition/RequisitionNumberSequence/RequisitionAssignment/UserRequisitionState/RequisitionLifecycleEvent → requisition
saved-list: E SavedListItemType, M SavedList/SavedListEntry → saved_list
settings: M TenantSetting → settings
sourced-talent: M SourcedTalent → sourced_talent
submittal: E SubmittalState/SubmittalEventType, M TalentSubmittalRecord/TalentSubmittalEvent → engagement (CO-LOC); M OutboxEvent → submittal
talent-evidence: 13 E + 9 M → talent_evidence
talent-record: M TalentRecord/TalentResumeText/TalentRecordFieldProvenance/TalentRecordReconcileContradiction → talent_record
talent-trust: M ResolutionSubject/ResolutionSubjectRef/EvidenceRecord/EvidenceEvent/EvidenceLink/TrustState/SubjectAnchor/SubjectMatchAdvisory/VerificationProposal/SubjectMergeOperation/VerificationRequest/PortalDispute/PortalDisputeWorkItem/PortalDisputeStatement → talent_trust
task: E TaskStatus, M Task → task
tenant-reset: M ResetBatch → tenant_reset

BASELINE COMMIT AUDITED: origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4 (working tree 3a4a3a4, one merge behind; §4/§5/§10 faithful).
NO MUTATION PERFORMED during recon (read-only git/grep/find/perl only; this segment records recon observations and mutated nothing).
