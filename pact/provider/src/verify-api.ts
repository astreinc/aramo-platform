import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { AppModule } from '@aramo/api';
// PC-6 — resume mock-infra: overrideProvider(Class) needs the concrete class
// (Gate-5 eslint amendment). Backends only; controllers stay live-verified.
import { ObjectStorageService } from '@aramo/object-storage';
import { ResumeParserService } from '@aramo/resume-parse';
// PC-7c — Symbol()-keyed ports the tenant-user lifecycle injects. Overriding a
// Symbol token requires the token itself (Gate-5 eslint amendment). MAILER_PORT
// is a plain string ('MAILER_PORT'), overridden by string literal below.
import { TENANT_COGNITO_PORT, AUDIT_FINANCIALS_GATE } from '@aramo/identity';
// M5 PR-9 §4.2 — hashCanonicalizedBody imported for idempotency
// replay/conflict state-handlers. The same hash function the controllers
// use computes the request_hash that the seeded IdempotencyKey row must
// match for replay; the conflict state-handler seeds an intentionally
// different hash. Single source of truth keeps the hash semantics
// aligned between seed + lookup.
import { hashCanonicalizedBody } from '@aramo/common';
// M5 PR-6 §4.14 — string-DI-token literals overridden so the verify
// harness doesn't need real Anthropic API + AWS Secrets Manager +
// SES/SendGrid wiring. The strings here match the const values in
// libs/ai-draft/src/lib/providers/tokens.ts and libs/engagement/src/lib/
// delivery/tokens.ts respectively. Per Ruling 13: provider verification
// with mocked adapters is the supported test posture for substrate
// that crosses external-service boundaries.
const PACT_DRAFT_PROVIDER_TOKEN = 'DRAFT_PROVIDER_TOKEN';
const PACT_DELIVERY_PROVIDER_TOKEN = 'DELIVERY_PROVIDER_TOKEN';

// PR-14 §4.7 + Amendment v1.0 §2 + PR-15 §4.2/§4.3 + M3 PR-8 §4.7 —
// Pact provider verifier for apps/api.
//
// Scope:
//   - PR-14: ingestion-consumer (2 interactions) + prohibited-source-type
//     (1 interaction)
//   - (retired) tenant-console-consumer formerly contributed 5 consent
//     interactions (PR-15 §4.2, F10). Suite deleted in the console-FE
//     retirement (PO-attested dead surface); its two consumer-agnostic
//     given-states survive below, driven by the ats-web consent reads
//     (PC-7a).
//   - (retired) the thin recruiter consumer formerly contributed 23
//     consent + 4 match-list interactions plus the engagement / submittal
//     / examination / outreach surface. Its pact was removed in the
//     Architecture-Realignment thin-consumer retirement; the dead consent,
//     engagement, match-list and submittal state handlers + fixtures it
//     drove were deleted in the backlog-item-2 prune (directive + v1.1
//     amendment). 'a recruiter token' / 'no valid token' are retained
//     (still exercised by live examination / portal-thin pacts).
//   - M3 PR-9 §4.8: portal-thin (5 interactions; profile happy + 403 +
//     401, consent happy + 403). Talent + TalentTenantOverlay seeded via
//     a new seedPortalTalentFixture helper; talent migration added to
//     the bootstrap. New ingestion JWT signed for the consent-403 case.
//
// Migration set (per Gate 5 §4.7 inspection + PR-15 §3 + M3 PR-8 §4.7):
// consent + ingestion + examination init + examination live-list index +
// job-domain init. Examination + job-domain migrations are added by M3
// PR-8 so the match-list state handler can seed Requisition + ranked
// TalentJobExamination rows the new endpoint serves. The API-side
// AuthModule is a pure JWT validator with zero Prisma queries; identity /
// auth / auth-storage / common are NOT required. ConsentAuditEvent (audit
// schema) is created by the consent migration, which the decision-log
// interactions rely on.
//
// Auth — PR-14 Amendment §2.2: inline JWT signing with the production
// issuer 'Aramo Core Auth' so JwtAuthGuard accepts the token. Mirrors
// libs/consent/src/tests/cookie-auth.integration.spec.ts. The signing
// key is generated fresh at bootstrap; the public key is fed back via
// AUTH_PUBLIC_KEY before AppModule init.
//
// Request filter:
//   - ats-web (and formerly tenant-console-consumer) pacts ship Cookie:
//     aramo_access_token=eyJfake.access.token — rewritten to the real
//     JWT cookie.
//   - the retired thin-consumer pacts shipped Authorization: Bearer
//     eyJfake.token — rewritten to a real Bearer JWT. The literal
//     'Bearer not-a-jwt' was intentionally NOT rewritten so JwtAuthGuard
//     returns INVALID_TOKEN 401. (Both branches are now unexercised.)
//
// Run condition: ARAMO_RUN_PACT_PROVIDER=1 gating. Invoke via
// `npm run pact:provider`.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../..');
const CONSENT_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
// Step-5 consent re-key: renames TalentConsentEvent.talent_id → talent_record_id
// (a returned-shape change), so the migration must be registered here + the
// seedConsentEvent INSERT column below updated, or provider verification 500s.
const CONSENT_REKEY_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
);
const INGESTION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql',
);
const INGESTION_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql',
);
// T2-2a additive — resolved_talent_id + resolution_method columns + the new
// ResolutionMethod enum. Without this migration, IngestionRepository.createPayload's
// Prisma RETURNING * fails because the generated client expects the new columns
// (the additive applied to schema.prisma forces the Prisma client to read them),
// surfacing as a 500 INTERNAL_ERROR on the ingestion-consumer pacts.
const INGESTION_T2_ADDITIVE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260603160100_add_resolved_talent_id_to_raw_payload_reference/migration.sql',
);
// Step 4b additive — resolved_cluster_id. Same RETURNING * reason as the
// T2-2a additive above: the regenerated ingestion client expects the column,
// so createPayload's RETURNING * 500s on the ingestion-consumer pacts without
// this migration applied.
const INGESTION_4B_ADDITIVE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260630120000_add_resolved_cluster_id_to_raw_payload_reference/migration.sql',
);
// Fix-Slice-2 additive — resolved_subject_id. Same RETURNING * reason: the
// regenerated ingestion client expects the column, so createPayload's
// RETURNING * 500s on the ingestion-consumer pacts without this migration.
const INGESTION_FS2_ADDITIVE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260704120000_add_resolved_subject_id_to_raw_payload_reference/migration.sql',
);
// Fix-Slice-Final-Drop — drops the husk resolved_talent_id (added then dropped;
// the regenerated ingestion client no longer selects it, so createPayload's
// RETURNING * must not encounter it).
const INGESTION_FS2_DROP_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260704160000_drop_resolved_talent_id_from_raw_payload_reference/migration.sql',
);
// Cold-Ingest Extraction additive above: extraction_done_at + extraction_attempts.
// The regenerated ingestion client selects both columns, so createPayload's
// RETURNING * 500s on the ingestion-consumer pacts without this migration.
const INGESTION_EXTRACTION_MARKER_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260704180000_add_extraction_marker_to_raw_payload_reference/migration.sql',
);
// TR-2a-B1 source_class additive above: the regenerated ingestion client selects
// source_class, so createPayload's RETURNING * 500s on the ingestion-consumer
// pacts without this migration applied.
const INGESTION_SOURCE_CLASS_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260706170000_add_source_class_to_raw_payload_reference/migration.sql',
);
// TR-2a-B2 declared_name additive: the regenerated ingestion client selects it,
// so createPayload's RETURNING * 500s on the ingestion-consumer pacts without
// this migration applied.
const INGESTION_DECLARED_NAME_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260706190000_add_declared_name_to_raw_payload_reference/migration.sql',
);
// TR-2a-B2 ResolutionMethod enum value add (confirmed_anchor_match). Keeps the
// DB enum in step with the regenerated client's widened type.
const INGESTION_CONFIRMED_METHOD_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260706210000_add_confirmed_anchor_match_to_resolution_method/migration.sql',
);
const EXAMINATION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
// M4 PR-5 §4.10 — ExaminationOverride table + absolute-immutability trigger
// migration; required so the override-create state handlers can seed the
// referenced TalentJobExamination row and persist override rows at request
// time.
const EXAMINATION_OVERRIDE_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260523180000_add_examination_override/migration.sql',
);
const JOB_DOMAIN_INIT_MIGRATION = resolve(
  ROOT,
  'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);
// Fix-Slice-Final-Drop — the talent (Core husk) schema is retired; no provider
// state seeds or reads talent.Talent, so its init migration is no longer applied.
// 4e-engagement-key — engagement.talent_id now references
// talent_record.TalentRecord.id, so the engagement-create provider state
// (seedEngagementBasics) seeds a TalentRecord. The column-mutating
// talent-record migrations (whole files; pg parses them natively).
const TALENT_RECORD_MIGRATIONS = [
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  // 4e-rest — drops core_talent_id (must run last so the provider schema
  // matches the regenerated Prisma client, which no longer projects it).
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  // Gate-1 G1-A — adds work_authorization (regenerated client projects it).
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  // TR-2a-B3a (DDR-3 §3) — adds record_status / superseded_by_record_id /
  // superseded_at (the regenerated client projects them; the provider schema
  // must carry them or every TalentRecord read 500s). COUPLING FLAG: this file
  // is the TR-2a↔Pact coupling point — whichever of the TR-2a track / a
  // concurrent pact-consumer track lands SECOND rebases this list onto the other.
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
].map((p) => resolve(ROOT, p));
// PR-A1b §4 sweep — entitlement schema applied for the pact verifier so
// the portal-thin pact interactions (5 interactions traversing the now
// class-level @RequireCapability('portal') gate) can pass through
// EntitlementGuard.
const ENTITLEMENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
// PR-A1c §4 sweep — metering schema applied because every engagement +
// submittal state-transition write method (the methods the pact provider
// formerly exercised through the retired thin-consumer pacts) now emits
// an in-tx UsageEvent INSERT in the same $transaction array.
const METERING_INIT_MIGRATION = resolve(
  ROOT,
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
);
// M4 PR-1 + PR-3 — evidence + submittal migrations applied so the
// submittal-create pact verification can seed an examination (via
// seedSubmittalFixture below), trigger the SubmittalController which
// calls buildPackage (writes evidence schema) and then writes the
// submittal record (engagement schema).
const EVIDENCE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
);
const SUBMITTAL_INIT_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
);
// M4 PR-7 §4.9 — submittal revoke migration: extends SubmittalState
// with 'revoked', adds revoked_at / revoked_by / revocation_justification
// columns, and rewrites the column-scoped trigger function to encode
// both Transition A (draft→submitted) and Transition B (submitted→
// revoked). Required by the submittal-revoke pact verification so the
// state handlers can transition rows to 'submitted' / 'revoked' via
// raw SQL (the column-scoped trigger validates each transition).
const SUBMITTAL_REVOKE_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
);
// M5 PR-8b1 §4.9 — TalentSubmittalEvent event-log substrate (enum +
// table + intra-schema FK + absolute-immutability trigger). Applied
// AFTER the submittal init + revoke migrations so the FK on
// TalentSubmittalRecord resolves. Substrate-only PR — no state
// handlers consume it yet (PR-8b2+ wires appendEvent into the
// existing repository write methods).
const SUBMITTAL_EVENT_LOG_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260526140602_add_submittal_event_log/migration.sql',
);
// M5 PR-8b2 §4.13 — submittal canonical rename + cutover migration.
// Replaces M4's 2-value subset (draft, submitted) plus PR-7's revoked
// sibling with the canonical 5-state machine (created -> handoff_draft
// -> ready_for_review -> submitted_to_ats -> confirmed + revoked
// sibling). Closes F37. Applied AFTER the event-log substrate so the
// pre-rename event-log integrity is preserved across the rename.
// Required by the M5 PR-8b2 pact verification so the state handlers
// can transition rows to the canonical states via raw SQL (the
// rewritten 5-state-matrix trigger validates each transition).
const SUBMITTAL_RENAME_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
);
// M4 PR-3 — talent-evidence migration applied so the buildPackage
// rate_expectation lookup can find a TalentRateExpectation row when the
// optional rate_expectation_id is supplied (the pact happy-path body
// does NOT supply one, but the migration is harmless to apply).
const TALENT_EVIDENCE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
);
// TR-7 B1 — TalentEducationEntry + TalentCertificationEntry. The regenerated
// talent-evidence client knows these models; the examine reconcile (Step 4b) reads
// them, so the tables must exist or examine-exercising provider states 500.
const TALENT_EVIDENCE_TR7_MIGRATION = resolve(
  ROOT,
  'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql',
);
// M5 PR-1 + PR-2 — engagement schema migrations: TalentJobEngagement
// init + TalentEngagementEvent event-log + absolute-immutability trigger.
// Required for M5 PR-4 engagement-* pact interactions.
const ENGAGEMENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql',
);
const ENGAGEMENT_EVENT_LOG_MIGRATION = resolve(
  ROOT,
  'libs/engagement/prisma/migrations/20260525150000_add_engagement_event_log/migration.sql',
);
// M6 PR-2 §3 — engagement schema OutboxEvent. Applied AFTER the event-log
// substrate (same schema namespace). Required by the engagement-* pact
// interactions because the M6 emit points now write an outbox row inside
// the same $transaction as the engagement state transition; without this
// migration, prisma.outboxEvent.create raises "relation does not exist".
const ENGAGEMENT_OUTBOX_MIGRATION = resolve(
  ROOT,
  'libs/engagement/prisma/migrations/20260531000000_add_outbox_event/migration.sql',
);
// Outreach Draft/Preview Amendment v1.1 §3 — the outreach_drafted enum value.
// Required by the outreach draft + send pact interactions (the send path
// reads a seeded outreach_drafted event for the cross-event-ref check).
const ENGAGEMENT_OUTREACH_DRAFTED_MIGRATION = resolve(
  ROOT,
  'libs/engagement/prisma/migrations/20260609000000_add_outreach_drafted_event_type/migration.sql',
);
// M6 PR-2 §3 — submittal schema OutboxEvent (in its own `submittal` PG
// namespace; the migration includes CREATE SCHEMA IF NOT EXISTS). Applied
// after the submittal canonical-rename so the schema-creation step runs
// last in the submittal sequence. Required by submittal-* pact interactions
// because the M6 emit points write an outbox row inside the same
// $transaction as the submittal state transition.
const SUBMITTAL_OUTBOX_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260531000000_add_outbox_event/migration.sql',
);
// TR-2a-B3b — the four Group-2 immutability reconcile-re-key trigger amendments
// (GUC-gated exemption of the talent_id re-point). Behaviorally a no-op for the
// pact interactions (the app.reconcile GUC is never set outside the reconcile
// repoint methods), but registered so the provider carries the amended trigger
// fns. COUPLING FLAG: verify-api.ts is the TR-2a↔Pact coupling point — the second
// of {this track, a concurrent pact track} to land rebases (--force-with-lease).
const ENGAGEMENT_RECONCILE_REKEY_MIGRATION = resolve(
  ROOT,
  'libs/engagement/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
);
const EXAMINATION_RECONCILE_REKEY_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
);
const SUBMITTAL_RECONCILE_REKEY_MIGRATION = resolve(
  ROOT,
  'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
);
const EVIDENCE_RECONCILE_REKEY_MIGRATION = resolve(
  ROOT,
  'libs/evidence/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
);
// M5 PR-6 §4.14 — ai-draft schema migration required by the outreach-send
// state handlers (AiDraftService writes audit-event rows even when the
// DraftProvider is mocked; without this migration, prisma.aiDraftEvent
// .create raises "table ai_draft.AiDraftEvent does not exist").
const AI_DRAFT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/ai-draft/prisma/migrations/20260525170000_init/migration.sql',
);
// Settings S1 — the FIRST settings-schema migration into the api pact-verifier
// MIGRATIONS set (PL-95). AppModule wires SettingsModule (the GET /v1/tenant/
// settings endpoint) post-Settings-S1; the settings PrismaService is lazy
// (no boot-time DB hit per the post-PR-17 uniform pattern), so the pact
// contracts in this verifier do NOT currently target /v1/tenant/settings
// (no consumer yet). Applying the migration is harmless and keeps the
// verifier prepared for future settings-touching consumer pacts.
const SETTINGS_INIT_MIGRATION = resolve(
  ROOT,
  'libs/settings/prisma/migrations/20260605000000_init_settings_model/migration.sql',
);
// PC-7b — settings surface (tenant settings/profile/roles/audit/domain/sites).
// The FULL identity chain: the Prisma Tenant client SELECTs every column, so
// all Tenant-column migrations must apply (profile/allowed-domain/domain-
// verification/slug/idp) or a read 500s on a missing column. All self-contained
// (init CREATEs the schema), zero cross-schema FK (I1). IdentityAuditEvent is in
// init; Site + hierarchy in the site migrations; TenantSetting = settings init
// (already applied above).
const IDENTITY_INIT_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql');
const IDENTITY_SITE_AXIS_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql');
const IDENTITY_AUTHZ_TEAM_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql');
const IDENTITY_TENANT_PROFILE_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql');
const IDENTITY_SITE_HIERARCHY_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql');
const IDENTITY_INVITATION_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql');
const IDENTITY_ALLOWED_DOMAIN_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql');
const IDENTITY_DOMAIN_VERIFICATION_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql');
const IDENTITY_TENANT_SLUG_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql');
const IDENTITY_IDP_MIGRATION = resolve(ROOT, 'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql');
const IDENTITY_IDP_MIGRATION_LC = resolve(ROOT, 'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql');
// PC-4 — activity + pipeline schemas. GET /v1/talent-records runs the
// apps/api TalentRecordEnrichmentInterceptor, which reads activity
// (last_activity_at) + pipeline (current_stage) + consent (consent_summary).
// consent is already applied; without activity + pipeline the enrichment
// SELECTs hit missing tables → 500 INTERNAL_ERROR on list/search. Both init
// migrations are self-contained (no external-schema FK refs); the tables stay
// empty (no seed) so the enrichment resolves to null / default.
const ACTIVITY_INIT_MIGRATION = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
);
const PIPELINE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
);
// PC-5a — ats-web Gate-2a desk (company + contact CRUD spine + D4a). The
// company schema (Company + CompanyDepartment + the two D4a join tables +
// the field-expansion columns CompanyView/the facets read) and the contact
// schema (Contact + list-surface fields). Order is init → additive ALTERs,
// each same-schema (init CREATEs the schema; nothing here has a cross-schema
// FK, so the list applies in isolation). The index-only Search PR-1 (pg_trgm
// GIN) migrations are OMITTED: the paged reads use ?paged=true with no ?q=,
// so no trigram path is exercised, and an index is never SELECTed by the
// Prisma client. No identity migrations are needed — company:read:all short-
// circuits the visibility resolver to zero reads, the D4a service reads only
// company.* tables, and its IdentityAuditService writes are best-effort
// (swallowed when the identity audit table is absent).
const COMPANY_INIT_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260601160000_init_company_model/migration.sql',
);
const COMPANY_IMPORT_BATCH_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260603140100_add_import_batch_id_to_company/migration.sql',
);
const COMPANY_AUTHZ_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260604000000_add_authz_assignment_ownership/migration.sql',
);
const COMPANY_FIELD_EXPANSION_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611000000_add_company_field_expansion/migration.sql',
);
const COMPANY_ADDRESS_PLACE_REF_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260611120000_add_company_address_place_ref/migration.sql',
);
const COMPANY_OFF_LIMITS_MIGRATION = resolve(
  ROOT,
  'libs/company/prisma/migrations/20260616000000_add_company_off_limits/migration.sql',
);
const CONTACT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260601160000_init_contact_model/migration.sql',
);
const CONTACT_IMPORT_BATCH_MIGRATION = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260603140100_add_import_batch_id_to_contact/migration.sql',
);
const CONTACT_LIST_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/contact/prisma/migrations/20260618120000_add_contact_list_surface_fields/migration.sql',
);
// PC-5b — ats-web Gate-2a desk (requisition spine + profile-confirm +
// assignments). Requisition init CREATEs the schema + Requisition +
// RequisitionAssignment + the RequisitionStatus enum; the additive ALTERs add
// the compensation / job-module / rate-type columns RequisitionView reads.
// All FKs are intra-schema (RequisitionAssignment -> Requisition); every
// cross-schema ref (company_id, golden_profile_id, …) is a plain UUID (§7.3),
// so the list applies in isolation. Search PR-1 (pg_trgm) omitted (index-
// only; no ?q= path — GET /v1/requisitions has no paged variant). profile-
// confirm writes job_domain.Job/GoldenProfile/Requisition, all created by the
// already-applied JOB_DOMAIN_INIT_MIGRATION.
const REQUISITION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
);
const REQUISITION_IMPORT_BATCH_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260603140100_add_import_batch_id_to_requisition/migration.sql',
);
const REQUISITION_COMPENSATION_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260605123400_add_compensation_fields_to_requisition/migration.sql',
);
const REQUISITION_JOB_MODULE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260611220000_job_module_requisition_fields/migration.sql',
);
const REQUISITION_DROP_LEGACY_COMP_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260612120000_drop_legacy_requisition_comp/migration.sql',
);
const REQUISITION_RATE_TYPE_MIGRATION = resolve(
  ROOT,
  'libs/requisition/prisma/migrations/20260618120000_add_rate_type_subk_runmatch/migration.sql',
);
// PC-5d — ats-web Gate-2a desk (task + attachment, the final increment). task
// init CREATEs the schema + Task + the TaskStatus enum ('open','done'); the
// workspace-fields migration ALTERs the enum (+in_progress/waiting/cancelled)
// and adds the source column. attachment init CREATEs the schema + Attachment +
// AttachmentOwnerType enum. All columns are logical UUIDs / TEXT / enums — no
// FK, so each applies in isolation. No index-only migrations to skip.
const TASK_INIT_MIGRATION = resolve(
  ROOT,
  'libs/task/prisma/migrations/20260609140000_init_task_model/migration.sql',
);
const TASK_WORKSPACE_MIGRATION = resolve(
  ROOT,
  'libs/task/prisma/migrations/20260617120000_task_workspace_fields/migration.sql',
);
const ATTACHMENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/attachment/prisma/migrations/20260602120000_init_attachment_model/migration.sql',
);
// PC-4b — Promotion / Advisory / Sourcing (post-B3). The talent_trust schema
// (11 migrations: init + anchor + advisory + resolution + watermark + 2 index-
// only + 2 B1 source_class + B2 reopen + B3b subject_merge_operation) — the
// full L2 identity substrate the sourcing/advisory/promote paths read+write.
// All TEXT-backed vocab (no PG enums), self-contained (CREATE SCHEMA in init),
// FKs intra-schema, cross-schema refs FK-less UUIDs (I1). PLUS saved_list (init
// + list_kind) — the WRITE-CLOSURE of POST /v1/sourcing/bench (getOrCreate
// tenant-bench + addToTenantBench); discovered at build, additive test-infra,
// bench disposition unchanged.
const TALENT_TRUST_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
);
const TALENT_TRUST_ANCHOR_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
);
const TALENT_TRUST_ADVISORY_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
);
const TALENT_TRUST_ADVISORY_RESOLUTION_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
);
const TALENT_TRUST_WATERMARK_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
);
const TALENT_TRUST_ATS_REF_UNIQUE_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
);
const TALENT_TRUST_POOL_KEYSET_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
);
const TALENT_TRUST_B1_SOURCE_CLASS_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
);
const TALENT_TRUST_B1_SOURCE_CLASS_UNIQUE_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
);
const TALENT_TRUST_B2_REOPEN_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
);
const TALENT_TRUST_B3B_MERGE_OP_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
);
// TR-6 B1 — ResolutionSubject.last_matched_at (the regenerated client SELECTs it on
// every subject read) + SubjectMergeOperation.kind/actor/reason (the advisory
// reverse-happy state's reverseMerge → unmergeSubjects now persists a DIRECT_UNMERGE
// row). Without both, the advisory-resolution provider states 500 (client select /
// insert of a column the DB lacks).
const TALENT_TRUST_TR6_LAST_MATCHED_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
);
const TALENT_TRUST_TR6_MERGE_OP_KIND_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
);
// TR-3 B2 — the VerificationRequest table (T3-B1, landed writer-less). The
// email-verification provider states seed/read it (the pending-token confirm
// state INSERTs a row; the request-happy state's confirm path writes one), and
// the regenerated client SELECTs its columns, so the table must exist or those
// provider states 500. COUPLING FLAG: this TALENT_TRUST migration list is shared
// with the TR track — a concurrent TR lander rebases this addition.
const TALENT_TRUST_TR3_VERIFICATION_REQUEST_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
);
// TR-4 B1 — EvidenceLink @@unique([from,to,relation]). Adds no column (the client
// SELECT shape is unchanged), so no provider state 500s; registered here so the
// provider schema matches HEAD. COUPLING FLAG: shared talent_trust list — a
// concurrent TR lander rebases this addition.
const TALENT_TRUST_TR4_LINK_UNIQUE_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
);
// TR-4 B3 — ResolutionSubject.last_consistency_at (the consistency-poll watermark).
// The regenerated client SELECTs it on every subject read, so the column must exist
// or those provider states 500. COUPLING FLAG: shared talent_trust list — second lander rebases.
const TALENT_TRUST_TR4_CONSISTENCY_WATERMARK_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
);
// TR-5 B2 — TrustState.single_source_only + longitudinal_observed (the thinness
// flags). The regenerated client SELECTs them on every trust-state read, so the
// columns must exist or those provider states 500. COUPLING FLAG: shared
// talent_trust list — second lander rebases.
const TALENT_TRUST_TR5_THINNESS_FLAGS_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
);
// TR-8 D2 — TrustState.verified_control_stale. The regenerated client SELECTs it on
// every trust-state read, so the column must exist or those provider states 500.
// COUPLING FLAG: shared talent_trust list — second lander rebases.
const TALENT_TRUST_TR8_VERIFIED_STALE_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
);
// TR-12 B1 — the VerificationProposal table. The regenerated client knows the
// model, so the table must exist or the talent_trust provider states 500.
// COUPLING FLAG: shared talent_trust list — second lander rebases.
const TALENT_TRUST_TR12_PROPOSAL_MIGRATION = resolve(
  ROOT,
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
);
const SAVED_LIST_INIT_MIGRATION = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
);
const SAVED_LIST_LIST_KIND_MIGRATION = resolve(
  ROOT,
  'libs/saved-list/prisma/migrations/20260706130000_add_list_kind_tenant_bench/migration.sql',
);
// PC-7d — import model (ImportBatch + ImportFailure). The GET /v1/imports +
// :id/failures reads live-verify against these tables; only the import_batch_id
// FK COLUMNS were in-list previously, not the import schema itself.
const IMPORT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/import/prisma/migrations/20260603140000_init_import_model/migration.sql',
);
// PC-7d — calendar model. GET /v1/dashboard's tenant_counts includes
// calendarRepository.count() → the read 500s without the schema.
const CALENDAR_INIT_MIGRATION = resolve(
  ROOT,
  'libs/calendar/prisma/migrations/20260602120000_init_calendar_model/migration.sql',
);
const INGESTION_PACT = resolve(
  ROOT,
  'pact/pacts/ingestion-consumer-aramo-core.json',
);
const PROHIBITED_PACT = resolve(
  ROOT,
  'pact/pacts/prohibited-source-type-aramo-core.json',
);
const PORTAL_THIN_PACT = resolve(ROOT, 'pact/pacts/portal-thin-aramo-core.json');
// PC-1 — ats-web consumer, engagement domain (the only live FE, Lead R1).
const ATS_WEB_PACT = resolve(ROOT, 'pact/pacts/ats-web-aramo-core.json');

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-pact-provider-api-audience';
const ALG = 'RS256';

const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';
// M3 PR-9 §4.8 — portal-thin pact uses TALENT_SUB as the talent id; the
// portal JWT's `sub` claim carries this value, and the GET /v1/portal/*
// endpoints derive talent_id from authContext.sub. Must match the
// pact/consumers/portal-thin/src/portal-*.consumer.test.ts constant.
const PORTAL_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

// Constants used by the consent-read given-states (and formerly the retired
// thin consumer). The talent uuid matches the value the consumer tests
// use; the recruiter actor uuid matches the audit-row value the pacts
// assert with a regex matcher.
const PACT_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PACT_RECRUITER_ACTOR_ID = '00000000-0000-7000-8000-000000000bb1';

// Migration files contain dollar-quoted PL/pgSQL bodies (the
// TalentConsentEvent immutability trigger), so the naive ;-split used by
// the auth-service verifier doesn't work here. pg's Client.query()
// accepts multi-statement strings via the simple query protocol — we
// hand each migration file in whole, which preserves the dollar quotes.

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — aramo-core (apps/api)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let accessJwt: string;
    let portalJwt: string;
    // M3 PR-9 §4.8 — ingestion-typed JWT for the portal-thin 403 test
    // ("an ingestion-consumer token (non-portal)"); the controller's
    // per-route consumer_type check rejects it with 403.
    let ingestionJwt: string;
    // Assigned in beforeAll before any state handler runs; initialized empty
    // for strict null-checks compliance.
    let dbUrl = '';

    // M4 PR-5 §4.10 — state-isolation tracking for override-create
    // interactions. Each override state handler captures the pre-execution
    // TalentJobExamination row hash here keyed by examination_id; the
    // afterEach hook re-reads the row, computes the post-execution hash,
    // and asserts byte-identity. Mismatches are collected as violations
    // and asserted-empty after verifier.verifyProvider() returns so the
    // Pact verification fails when an override write mutates the
    // examination row. This is the FIRST Aramo Pact contract enforcing
    // a state-isolation invariant (directive §4.10).
    const overrideStateIsolation: {
      preHash: Map<string, string>;
      violations: string[];
    } = { preHash: new Map(), violations: [] };

    // M4 PR-7 §4.9 — state-isolation tracking for submittal-revoke
    // interactions. Each revoke state handler captures the pre-execution
    // TalentJobEvidencePackage row hash here (keyed by
    // evidence_package_id) when the submittal exists; the afterEach hook
    // re-reads the row, computes the post-execution hash, and asserts
    // byte-identity. Mismatches are collected as violations and
    // asserted-empty after verifier.verifyProvider() returns so the
    // Pact verification fails when a revoke write mutates the evidence
    // package row. Ruling 6 (refined) per directive §4.9: applies to
    // ALL 4 PR-7 interactions (1 success + 3 refusals); each
    // seedSubmittalRevokeFixture call captures preHash when
    // submittalExists is true; afterEach verifies byte-identity
    // regardless of whether the route succeeded or refused. Mirrors the
    // overrideStateIsolation pattern from M4 PR-5.
    const evidencePackageStateIsolation: {
      preHashes: Map<string, string>;
      violations: string[];
    } = { preHashes: new Map(), violations: [] };

    async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: dbUrl });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    }

    // Truncate every table the consent + ingestion pacts touch so each
    // interaction starts from a known-empty floor. The Pact verifier runs
    // interactions in sequence; without a reset a prior interaction's
    // rows would shadow the next.
    async function resetAllRows(c: Client): Promise<void> {
      await c.query('TRUNCATE TABLE ingestion."RawPayloadReference" CASCADE');
      await c.query('TRUNCATE TABLE consent."TalentConsentEvent" CASCADE');
      await c.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
      await c.query('TRUNCATE TABLE consent."OutboxEvent" CASCADE');
      await c.query('TRUNCATE TABLE audit."ConsentAuditEvent" CASCADE');
      // M3 PR-8 — match-list state handlers seed rows into these tables;
      // truncate them at the start of every interaction so a prior
      // interaction's data doesn't leak forward.
      await c.query('TRUNCATE TABLE examination."TalentJobExamination" CASCADE');
      await c.query('TRUNCATE TABLE job_domain."Requisition" CASCADE');
      // Fix-Slice-Final-Drop: the Core husk (talent.Talent + overlay) is
      // dropped; no provider state seeds it (nothing reads it post-fix-sequence).
      // 4e-engagement-key — engagement.talent_id references TalentRecord.
      await c.query('TRUNCATE TABLE talent_record."TalentRecord" CASCADE');
      // M4 PR-3 — submittal-create state handlers seed an examination
      // and trigger buildPackage which writes the evidence package +
      // submittal record. Truncate both tables so prior runs don't leak.
      // M5 PR-8b1 §4.9 — TalentSubmittalEvent has FK to TalentSubmittalRecord;
      // CASCADE on the parent truncates child rows, but explicit child
      // TRUNCATE here mirrors the engagement-side pattern (line ~308)
      // for clarity. No PR-8b1 state handlers append rows to this table
      // yet (substrate-only PR).
      await c.query('TRUNCATE TABLE engagement."TalentSubmittalEvent" CASCADE');
      await c.query('TRUNCATE TABLE engagement."TalentSubmittalRecord" CASCADE');
      await c.query('TRUNCATE TABLE evidence."TalentJobEvidencePackage" CASCADE');
      // M4 PR-5 — override-create state handlers seed an examination and
      // the controller persists override rows at request time. Truncate
      // ExaminationOverride so prior runs don't leak.
      await c.query('TRUNCATE TABLE examination."ExaminationOverride" CASCADE');
      // M5 PR-4 — engagement-* state handlers seed TalentJobEngagement +
      // TalentEngagementEvent rows + the controller persists more on
      // create/transition. Truncate so prior runs don't leak.
      await c.query('TRUNCATE TABLE engagement."TalentEngagementEvent" CASCADE');
      await c.query('TRUNCATE TABLE engagement."TalentJobEngagement" CASCADE');
      // M6 PR-2 §3 — engagement + submittal OutboxEvent. Each state-
      // transition emit point now writes an outbox row inside the same
      // $transaction; truncate per interaction so prior runs don't leak.
      await c.query('TRUNCATE TABLE engagement."OutboxEvent" CASCADE');
      await c.query('TRUNCATE TABLE submittal."OutboxEvent" CASCADE');
      // M5 PR-6 — outreach-send state handlers cause AiDraftService to
      // append audit-event rows for each generateDraft call. Truncate so
      // prior runs don't leak forward across pact interactions.
      await c.query('TRUNCATE TABLE ai_draft."AiDraftEvent" CASCADE');
      // PC-5a — company + contact desk. TRUNCATE Company CASCADE also clears
      // CompanyDepartment + UserClientAssignment + TeamClientOwnership (all
      // FK company_id ON DELETE CASCADE). Contact has no FK (company_id is a
      // logical ref) so it is truncated explicitly.
      await c.query('TRUNCATE TABLE company."Company" CASCADE');
      await c.query('TRUNCATE TABLE contact."Contact" CASCADE');
      // PC-5b — requisition spine. TRUNCATE Requisition CASCADE clears
      // RequisitionAssignment (FK requisition_id ON DELETE CASCADE). profile-
      // confirm writes job_domain.Job + GoldenProfile (job_domain.Requisition
      // is already truncated above); clear them so prior confirms don't leak.
      await c.query('TRUNCATE TABLE requisition."Requisition" CASCADE');
      await c.query('TRUNCATE TABLE job_domain."Job" CASCADE');
      await c.query('TRUNCATE TABLE job_domain."GoldenProfile" CASCADE');
      // PC-5c — pipeline + activity. TRUNCATE Pipeline CASCADE clears
      // PipelineStatusHistory (FK pipeline_id ON DELETE CASCADE); the
      // transition write also appends an activity + a history row, cleared
      // here per interaction. Activity is standalone (no FK).
      await c.query('TRUNCATE TABLE pipeline."Pipeline" CASCADE');
      await c.query('TRUNCATE TABLE activity."Activity" CASCADE');
      // PC-5d — task + attachment (no FK; standalone truncates). The
      // attachment 'talent' owner lives in talent_record."TalentRecord",
      // already truncated above.
      await c.query('TRUNCATE TABLE task."Task" CASCADE');
      await c.query('TRUNCATE TABLE attachment."Attachment" CASCADE');
      // PC-4b — talent_trust L2 substrate + saved_list bench. TRUNCATE
      // ResolutionSubject CASCADE clears its FK-children (ResolutionSubjectRef,
      // EvidenceRecord[+events/links], TrustState, SubjectMatchAdvisory,
      // SubjectAnchor). SubjectMergeOperation has no FK (logical) → separate.
      // SavedList CASCADE clears SavedListEntry. RawPayloadReference (the mint
      // arrival) is already truncated above (ingestion).
      await c.query('TRUNCATE TABLE talent_trust."ResolutionSubject" CASCADE');
      await c.query('TRUNCATE TABLE talent_trust."SubjectMergeOperation" CASCADE');
      // TR-3 B2 — VerificationRequest has NO FK to ResolutionSubject (subject_id
      // is a logical UUID ref), so the CASCADE above does not clear it; truncate
      // explicitly so a prior email-verification interaction's row does not leak.
      await c.query('TRUNCATE TABLE talent_trust."VerificationRequest" CASCADE');
      // TR-12 B2 — VerificationProposal is relation-less (subject_id is a logical
      // UUID ref), so the ResolutionSubject CASCADE above does not clear it;
      // truncate explicitly so a prior proposal interaction's row does not leak.
      await c.query('TRUNCATE TABLE talent_trust."VerificationProposal" CASCADE');
      await c.query('TRUNCATE TABLE saved_list."SavedList" CASCADE');
      // PC-7b — identity + settings. TRUNCATE Tenant CASCADE clears Site (FK) +
      // memberships/teams; IdentityAuditEvent (nullable tenant_id, no FK) and
      // settings.TenantSetting are standalone.
      await c.query('TRUNCATE TABLE identity."Tenant" CASCADE');
      await c.query('TRUNCATE TABLE identity."IdentityAuditEvent" CASCADE');
      await c.query('TRUNCATE TABLE settings."TenantSetting" CASCADE');
      // PC-7c — User + Role are global (no tenant FK); CASCADE clears
      // memberships, membership-roles, team-memberships, edges, invitations.
      await c.query('TRUNCATE TABLE identity."User" CASCADE');
      await c.query('TRUNCATE TABLE identity."Role" CASCADE');
      // PC-7d — import model. TRUNCATE ImportBatch CASCADE; ImportFailure is
      // truncated explicitly (its import_batch_id FK is not declared ON DELETE
      // CASCADE) so a prior failures interaction's rows do not leak.
      await c.query('TRUNCATE TABLE import."ImportBatch" CASCADE');
      await c.query('TRUNCATE TABLE import."ImportFailure" CASCADE');
    }

    // 4e-rest-b — seed the portal talent's TalentRecord for the portal-thin
    // pacts. findSelfProfile re-homed OFF Core (Talent+overlay) ONTO the
    // TalentRecord heart, so the fixture now seeds one talent_record row.
    // The portal JWT's sub is PORTAL_TALENT_ID; the controller derives
    // talent_id from authContext.sub (= the TalentRecord id) and tenant_id
    // from authContext.tenant_id (TENANT_ID). tenant_status + source_channel
    // are set non-null so the reader's un-statused → 404 guard is satisfied
    // (the pact matches both as non-null). Both states ("profile P" and
    // "consent grants G") use the same fixture; consent grants are seeded
    // separately via seedConsentEvent.
    async function seedPortalTalentFixture(c: Client): Promise<void> {
      await c.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel,
            created_at, updated_at)
         VALUES ($1, $2, 'Portal', 'Talent', 'active', 'self_signup', NOW(), NOW())`,
        [PORTAL_TALENT_ID, TENANT_ID],
      );
    }

    async function seedConsentEvent(
      c: Client,
      opts: {
        id: string;
        scope: string;
        action: 'granted' | 'revoked';
        occurredAt: string;
        createdAt?: string;
        expiresAt?: string | null;
      },
    ): Promise<void> {
      const createdAtSql = opts.createdAt ?? opts.occurredAt;
      await c.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
            captured_method, consent_version, occurred_at, expires_at,
            created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'recruiter_capture','v1',$7,$8,$9)`,
        [
          opts.id,
          PACT_TALENT_ID,
          TENANT_ID,
          opts.scope,
          opts.action,
          PACT_RECRUITER_ACTOR_ID,
          opts.occurredAt,
          opts.expiresAt ?? null,
          createdAtSql,
        ],
      );
    }

    async function seedAuditEvent(
      c: Client,
      opts: {
        id: string;
        actorId: string | null;
        actorType: 'recruiter' | 'system' | 'self';
        eventType: string;
        payload: Record<string, unknown>;
        createdAt: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO audit."ConsentAuditEvent"
           (id, tenant_id, actor_id, actor_type, event_type, subject_id,
            event_payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          opts.id,
          TENANT_ID,
          opts.actorId,
          opts.actorType,
          opts.eventType,
          PACT_TALENT_ID,
          JSON.stringify(opts.payload),
          opts.createdAt,
        ],
      );
    }

    // ===================================================================
    // PC-1 — ats-web engagement domain live fixtures.
    //
    // NEW live seed helpers — deliberately NOT reusing the ats-thin-era
    // seedEngagementBasics / seedEngagementRow / seedIdempotencyKey (dead
    // code). Keeping these separate keeps the eventual dead-handler prune
    // (backlog item 2) clean and satisfies "derive from live DTOs, not the
    // retired ats-thin files". resetAllRows already truncates every table
    // these touch (job_domain.Requisition, talent_record.TalentRecord,
    // engagement.TalentJobEngagement / TalentEngagementEvent,
    // consent.IdempotencyKey), so NO new TRUNCATE lines are required.
    // ===================================================================
    const ATSW_JOB_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
    const ATSW_REQUISITION_ID = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
    // Engagement fixtures — one id per seeded state (mirror the consumer).
    const ATSW_SURFACED_ID = '00000000-0000-7000-8000-a00000000001';
    const ATSW_AWAITING_ID = '00000000-0000-7000-8000-a00000000002';
    const ATSW_RESPONDED_ID = '00000000-0000-7000-8000-a00000000003';
    const ATSW_ENGAGED_ID = '00000000-0000-7000-8000-a00000000004';
    const ATSW_ENGAGED_DRAFT_ID = '00000000-0000-7000-8000-a00000000005';
    const ATSW_ENGAGED_SEND_ID = '00000000-0000-7000-8000-a00000000006';
    const ATSW_EVENTS_ID = '00000000-0000-7000-8000-a00000000007';
    const ATSW_ENGAGED_SEND_NO_CONSENT_ID = '00000000-0000-7000-8000-a00000000008';
    const ATSW_OUTREACH_SENT_EVENT_ID = '00000000-0000-7000-8000-b00000000001';
    const ATSW_OUTREACH_DRAFTED_EVENT_ID = '00000000-0000-7000-8000-b00000000003';
    const ATSW_TRANSITION_EVENT_ID = '00000000-0000-7000-8000-e00000000001';
    // Idempotency keys (mirror the consumer).
    const ATSW_K_TRANSITION_REPLAY = '00000000-0000-7000-8000-d00000000101';
    const ATSW_K_TRANSITION_CONFLICT = '00000000-0000-7000-8000-d00000000102';
    const ATSW_K_RESPONSE_REPLAY = '00000000-0000-7000-8000-d00000000201';
    const ATSW_K_RESPONSE_CONFLICT = '00000000-0000-7000-8000-d00000000202';
    const ATSW_K_CONVERSATION_REPLAY = '00000000-0000-7000-8000-d00000000301';
    const ATSW_K_CONVERSATION_CONFLICT = '00000000-0000-7000-8000-d00000000302';
    const ATSW_K_DRAFT_REPLAY = '00000000-0000-7000-8000-d00000000401';
    const ATSW_K_DRAFT_CONFLICT = '00000000-0000-7000-8000-d00000000402';
    const ATSW_K_SEND_REPLAY = '00000000-0000-7000-8000-d00000000501';
    const ATSW_K_SEND_CONFLICT = '00000000-0000-7000-8000-d00000000502';
    // Request bodies — MUST byte-match the consumer bodies so
    // hashCanonicalizedBody produces the same request_hash (replay) or a
    // deliberate mismatch (conflict, via a literal non-hash string).
    const ATSW_TRANSITION_BODY = {
      to_state: 'evaluated',
      event_id: ATSW_TRANSITION_EVENT_ID,
    };
    const ATSW_RESPONSE_BODY = {
      response_received_at: '2026-05-25T11:00:00.000Z',
      outreach_event_ref_id: ATSW_OUTREACH_SENT_EVENT_ID,
    };
    const ATSW_CONVERSATION_BODY = {
      conversation_started_at: '2026-05-25T12:00:00.000Z',
    };
    const ATSW_DRAFT_BODY = { prompt: 'Reach out to the talent about the role.' };
    const ATSW_SEND_BODY = {
      draft_event_id: ATSW_OUTREACH_DRAFTED_EVENT_ID,
      final_text: 'Hello — we have a role that matches your background.',
    };
    // Canonical event payloads for the fixtures that need a prior event.
    const ATSW_DRAFTED_PAYLOAD = {
      draft_text: 'Mocked outreach draft for pact verification.',
      ai_draft_audit_record_id: '00000000-0000-7000-8000-b0000000000a',
      model_used: 'claude-sonnet-mock',
      input_tokens: 10,
      output_tokens: 20,
      duration_ms: 100,
      prompt: 'Reach out to the talent about the role.',
      max_tokens: 512,
    };
    const ATSW_SENT_PAYLOAD = {
      ai_draft_audit_record_id: '00000000-0000-7000-8000-b0000000000b',
      model_used: 'claude-sonnet-mock',
      input_tokens: 10,
      output_tokens: 20,
      duration_ms: 100,
      delivered_at: '2026-05-25T10:01:00.000Z',
      delivery_channel: 'email',
      delivery_id: '00000000-0000-7000-8000-b0000000000c',
    };
    // Cached response bodies for the idempotency-replay fixtures (returned
    // verbatim by the controller's idempotency.lookup replay branch).
    function atswEngagementBody(id: string, state: string): unknown {
      return {
        id,
        tenant_id: TENANT_ID,
        talent_id: PACT_TALENT_ID,
        requisition_id: ATSW_REQUISITION_ID,
        examination_id: null,
        state,
        created_at: '2026-05-25T00:00:00.000Z',
      };
    }
    function atswEventBody(id: string, engagementId: string, eventType: string): unknown {
      return {
        id,
        tenant_id: TENANT_ID,
        engagement_id: engagementId,
        event_type: eventType,
        event_payload: {},
        created_at: '2026-05-25T00:00:00.000Z',
      };
    }

    async function seedAtsWebEngagementBasics(c: Client): Promise<void> {
      await c.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, 'Pact', 'Talent', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [PACT_TALENT_ID, TENANT_ID],
      );
      await c.query(
        `INSERT INTO job_domain."Job" (id, tenant_id)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [ATSW_JOB_ID, TENANT_ID],
      );
      await c.query(
        `INSERT INTO job_domain."Requisition"
           (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [ATSW_REQUISITION_ID, TENANT_ID, ATSW_JOB_ID, PACT_RECRUITER_ACTOR_ID],
      );
    }

    async function seedAtsWebEngagement(
      c: Client,
      params: { id: string; state: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO engagement."TalentJobEngagement"
           (id, tenant_id, talent_id, requisition_id, examination_id, state, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5::engagement."EngagementState", NOW())`,
        [params.id, TENANT_ID, PACT_TALENT_ID, ATSW_REQUISITION_ID, params.state],
      );
    }

    async function seedAtsWebEngagementEvent(
      c: Client,
      params: {
        id: string;
        engagementId: string;
        eventType: string;
        payload: Record<string, unknown>;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO engagement."TalentEngagementEvent"
           (id, tenant_id, engagement_id, event_type, event_payload, created_at)
         VALUES ($1, $2, $3, $4::engagement."EngagementEventType", $5::jsonb, NOW())`,
        [
          params.id,
          TENANT_ID,
          params.engagementId,
          params.eventType,
          JSON.stringify(params.payload),
        ],
      );
    }

    async function seedAtsWebIdempotencyKey(
      c: Client,
      params: {
        id: string;
        key: string;
        requestHash: string;
        responseStatus?: number;
        responseBody?: unknown;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO consent."IdempotencyKey"
           (id, tenant_id, key, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          params.id,
          TENANT_ID,
          params.key,
          params.requestHash,
          params.responseStatus ?? 200,
          JSON.stringify(params.responseBody ?? { pact_seeded: true }),
        ],
      );
    }
    // Grants the 'contacting' scope (consent operation 'engagement' maps to
    // 'contacting') so the draft soft-check + the send binding gate pass.
    async function seedAtsWebContactingConsent(c: Client): Promise<void> {
      await seedConsentEvent(c, {
        id: '00000000-0000-7000-8000-b0000000001a',
        scope: 'profile_storage',
        action: 'granted',
        occurredAt: '2026-05-25T00:00:00.000Z',
      });
      await seedConsentEvent(c, {
        id: '00000000-0000-7000-8000-b0000000001b',
        scope: 'matching',
        action: 'granted',
        occurredAt: '2026-05-25T00:00:00.000Z',
      });
      await seedConsentEvent(c, {
        id: '00000000-0000-7000-8000-b0000000001c',
        scope: 'contacting',
        action: 'granted',
        occurredAt: '2026-05-25T00:00:00.000Z',
      });
    }
    // Non-empty ledger with contacting UN-granted → resolveConsentState
    // returns result:'denied' (NOT the empty-ledger Decision K 'error' →
    // 500). This is what drives the send binding gate to 403
    // CONSENT_NOT_GRANTED_AT_SEND.
    async function seedAtsWebNoContactingConsent(c: Client): Promise<void> {
      await seedConsentEvent(c, {
        id: '00000000-0000-7000-8000-b0000000002a',
        scope: 'profile_storage',
        action: 'granted',
        occurredAt: '2026-05-25T00:00:00.000Z',
      });
      await seedConsentEvent(c, {
        id: '00000000-0000-7000-8000-b0000000002b',
        scope: 'matching',
        action: 'granted',
        occurredAt: '2026-05-25T00:00:00.000Z',
      });
    }

    // ===================================================================
    // PC-2 — ats-web submittal domain live fixtures.
    //
    // seedAtsWebExamination + seedAtsWebEvidencePackage are COMPOSABLE
    // NAMED helpers (Lead Gate-5 addition #2): PC-3 (examination domain)
    // imports them. Fresh live seeds — NOT the dead ats-thin
    // seedSubmittalFixture/insertExaminationRow (kept untouched). All
    // tables here are already truncated by resetAllRows (examination,
    // job_domain.Requisition, talent_record, engagement.TalentSubmittal*,
    // evidence.TalentJobEvidencePackage, consent.IdempotencyKey) → NO new
    // TRUNCATE lines.
    // ===================================================================
    const ATSW_SUB_JOB_ID = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
    const ATSW_SUB_REQ_ID = '22222222-0000-7000-8000-0000000000dd';
    const ATSW_SUB_GOLDEN_ID = '22221111-0000-7000-8000-0000000000dd';
    const ATSW_SUB_EXAM_ID = '00000000-0000-7000-8000-5e0000000001';
    const ATSW_SUB_EXAM_NEWER_ID = '00000000-0000-7000-8000-5e0000000002';
    const ATSW_SUB_CREATED_ID = '00000000-0000-7000-8000-5a0000000001';
    const ATSW_SUB_HANDOFF_ID = '00000000-0000-7000-8000-5a0000000002';
    const ATSW_SUB_READY_ID = '00000000-0000-7000-8000-5a0000000003';
    const ATSW_SUB_SUBMITTED_ID = '00000000-0000-7000-8000-5a0000000004';
    const ATSW_SUB_CONFIRMED_ID = '00000000-0000-7000-8000-5a0000000005';
    const ATSW_SUB_STRETCH_ID = '00000000-0000-7000-8000-5a0000000006';
    const ATSW_SUB_WORTH_ID = '00000000-0000-7000-8000-5a0000000007';
    const ATSW_SUB_OUTDATED_ID = '00000000-0000-7000-8000-5a0000000008';
    const ATSW_SUB_EVIDENCE_ID = '00000000-0000-7000-8000-5c0000000001';
    // idempotency keys (mirror the consumer).
    const ATSW_SUB_K_CREATE_REPLAY = '00000000-0000-7000-8000-5d0000000101';
    const ATSW_SUB_K_CREATE_CONFLICT = '00000000-0000-7000-8000-5d0000000102';
    const ATSW_SUB_K_MARKREADY_REPLAY = '00000000-0000-7000-8000-5d0000000201';
    const ATSW_SUB_K_MARKREADY_CONFLICT = '00000000-0000-7000-8000-5d0000000202';
    const ATSW_SUB_K_SUBMIT_REPLAY = '00000000-0000-7000-8000-5d0000000301';
    const ATSW_SUB_K_SUBMIT_CONFLICT = '00000000-0000-7000-8000-5d0000000302';
    const ATSW_SUB_K_CONFIRM_REPLAY = '00000000-0000-7000-8000-5d0000000401';
    const ATSW_SUB_K_CONFIRM_CONFLICT = '00000000-0000-7000-8000-5d0000000402';
    const ATSW_SUB_K_CONFIRMATS_REPLAY = '00000000-0000-7000-8000-5d0000000501';
    const ATSW_SUB_K_CONFIRMATS_CONFLICT = '00000000-0000-7000-8000-5d0000000502';
    const ATSW_SUB_K_REVOKE_REPLAY = '00000000-0000-7000-8000-5d0000000601';
    const ATSW_SUB_K_REVOKE_CONFLICT = '00000000-0000-7000-8000-5d0000000602';
    // Request bodies — MUST byte-match the consumer bodies (hash parity).
    const ATSW_SUB_CREATE_BODY = {
      talent_id: PACT_TALENT_ID,
      job_id: ATSW_SUB_JOB_ID,
      examination_id: ATSW_SUB_EXAM_ID,
      talent_identity: { full_name: 'Pact Talent', location: 'Remote (US)' },
      contact_summary: { contact_available: true, channels_verified: ['email'] },
      capability_summary_overrides: {
        key_work_history: [
          { employer_name: 'Acme', role_title: 'Senior Engineer', start_date: '2020-01' },
        ],
      },
      recruiter_contribution: {
        conversation_summary: { recruiter_summary: 'Spoke with the talent about the role.' },
        talent_confirmed: { spoken_to_recruiter: true },
      },
    };
    const ATSW_SUB_EMPTY_BODY = {};
    const ATSW_SUB_ATTEST_OK = {
      attestations: {
        talent_evidence_reviewed: true,
        constraints_reviewed: true,
        submittal_risk_acknowledged: true,
      },
    };
    const ATSW_SUB_REVOKE_BODY = {
      revocation_justification: 'Role closed before the submittal advanced.',
    };

    // Cached response body for submittal idempotency-replay fixtures
    // (returned verbatim by the controller's idempotency.lookup replay).
    function atswSubmittalBody(
      id: string,
      state: string,
      opts: { confirmedAt?: boolean; revoked?: boolean } = {},
    ): unknown {
      return {
        id,
        tenant_id: TENANT_ID,
        talent_id: PACT_TALENT_ID,
        job_id: ATSW_SUB_JOB_ID,
        evidence_package_id: ATSW_SUB_EVIDENCE_ID,
        pinned_examination_id: ATSW_SUB_EXAM_ID,
        state,
        created_by: PACT_RECRUITER_ACTOR_ID,
        justification: null,
        failed_criterion_acknowledgments: null,
        created_at: '2026-05-25T00:00:00.000Z',
        confirmed_at: opts.confirmedAt ? '2026-05-25T00:00:00.000Z' : null,
        revoked_at: opts.revoked ? '2026-05-25T00:00:00.000Z' : null,
        revoked_by: opts.revoked ? PACT_RECRUITER_ACTOR_ID : null,
        revocation_justification: opts.revoked
          ? 'Role closed before the submittal advanced.'
          : null,
      };
    }

    // PC-4 — talent-record fixture id (list/search/update target).
    const ATSW_TALENT_ID = '00000000-0000-7000-8000-7a0000000001';

    // COMPOSABLE (PC-4, PC-5+ reuse): seed a talent-record row. Extracted
    // from seedAtsWebExamination's inline insert (behavior-preserving —
    // tenant_status/source_channel default to NULL when omitted, exactly the
    // prior columns; non-regression proven by the 61 existing interactions
    // staying green through pact:provider in CI).
    async function seedAtsWebTalentRecord(
      c: Client,
      params: {
        id: string;
        firstName: string;
        lastName: string;
        tenantStatus?: string;
        sourceChannel?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.firstName,
          params.lastName,
          params.tenantStatus ?? null,
          params.sourceChannel ?? null,
        ],
      );
    }

    // PC-5a — ats-web Gate-2a desk fixture ids. Shared with the consumer
    // files' local path constants (get/patch/delete targets); POST responses
    // carry provider-minted ids matched with uuid().
    const ATSW_COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
    const ATSW_DEPT_ID = '00000000-0000-7000-8000-de0000000001';
    const ATSW_CONTACT_ID = '00000000-0000-7000-8000-c07ac0000001';
    const ATSW_ASSIGN_USER_ID = '00000000-0000-7000-8000-115e00000001';
    const ATSW_TEAM_ID = '00000000-0000-7000-8000-7ea000000001';
    const ATSW_ASSIGNMENT_ID = '00000000-0000-7000-8000-a55160000001';
    const ATSW_OWNERSHIP_ID = '00000000-0000-7000-8000-04e160000001';

    // COMPOSABLE (PC-5a+): seed a company row. Only the required columns
    // (tenant_id, name); everything else defaults (id/is_hot/status/tags/
    // off_limits/timestamps).
    async function seedAtsWebCompany(
      c: Client,
      params: { id: string; name: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO company."Company" (id, tenant_id, name)
         VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.name],
      );
    }

    async function seedAtsWebCompanyDepartment(
      c: Client,
      params: { id: string; companyId: string; name: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO company."CompanyDepartment" (id, tenant_id, company_id, name)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.companyId, params.name],
      );
    }

    async function seedAtsWebUserClientAssignment(
      c: Client,
      params: { id: string; userId: string; companyId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO company."UserClientAssignment" (id, tenant_id, user_id, company_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.userId, params.companyId],
      );
    }

    async function seedAtsWebTeamClientOwnership(
      c: Client,
      params: { id: string; teamId: string; companyId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO company."TeamClientOwnership" (id, tenant_id, team_id, company_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.teamId, params.companyId],
      );
    }

    async function seedAtsWebContact(
      c: Client,
      params: {
        id: string;
        companyId: string;
        firstName: string;
        lastName: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO contact."Contact"
           (id, tenant_id, company_id, first_name, last_name)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.companyId, params.firstName, params.lastName],
      );
    }

    // PC-5b — requisition spine fixture ids (list/get/patch/profile/confirm +
    // assignment targets). REQ_COMPANY_ID is a logical UUID ref (no FK), so no
    // company row is required for the requisition seeds.
    const ATSW_REQ_ID = '00000000-0000-7000-8000-4e9000000001';
    const ATSW_REQ_COMPANY_ID = '00000000-0000-7000-8000-c00000000001';
    const ATSW_REQ_ASSIGN_USER_ID = '00000000-0000-7000-8000-115e00000002';
    const ATSW_REQ_ASSIGNMENT_ID = '00000000-0000-7000-8000-a55160000002';

    // COMPOSABLE (PC-5b+): seed a requisition row. Only the required columns
    // (tenant_id, title, company_id); status defaults 'active', openings/
    // openings_available default 1, golden_profile_id stays null (profile-less
    // until confirm stamps it).
    async function seedAtsWebRequisition(
      c: Client,
      params: { id: string; title: string; companyId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.title, params.companyId],
      );
    }

    async function seedAtsWebRequisitionAssignment(
      c: Client,
      params: { id: string; requisitionId: string; userId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO requisition."RequisitionAssignment"
           (id, tenant_id, requisition_id, user_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.requisitionId, params.userId],
      );
    }

    // PC-5c — pipeline + activity fixture ids. talent_record_id and
    // requisition_id on Pipeline are logical UUID refs (no FK), so a basic
    // pipeline seed needs no parent rows; only the no-openings 409 case seeds
    // a real requisition (openings_available forced to 0).
    const ATSW_PIPE_ID = '00000000-0000-7000-8000-71be00000001';
    const ATSW_PIPE_OFFERED_ID = '00000000-0000-7000-8000-71be00000002';
    const ATSW_PIPE_TALENT_ID = '00000000-0000-7000-8000-7a1e00000001';
    const ATSW_PIPE_REQ_ID = '00000000-0000-7000-8000-4e9100000001';
    const ATSW_PIPE_FULL_REQ_ID = '00000000-0000-7000-8000-4e9100000002';
    const ATSW_PIPE_HISTORY_ID = '00000000-0000-7000-8000-415700000001';
    const ATSW_ACTIVITY_ID = '00000000-0000-7000-8000-ac7100000001';

    // COMPOSABLE (PC-5c+): seed a pipeline row. status defaults 'no_contact'
    // (the create-state) unless a specific stage is passed (e.g. 'offered' for
    // the placement-transition case).
    async function seedAtsWebPipeline(
      c: Client,
      params: {
        id: string;
        talentRecordId: string;
        requisitionId: string;
        status?: string;
      },
    ): Promise<void> {
      if (params.status === undefined) {
        await c.query(
          `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
          [params.id, TENANT_ID, params.talentRecordId, params.requisitionId],
        );
        return;
      }
      await c.query(
        `INSERT INTO pipeline."Pipeline"
           (id, tenant_id, talent_record_id, requisition_id, status)
         VALUES ($1,$2,$3,$4,$5::"pipeline"."PipelineStatus")
         ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.talentRecordId, params.requisitionId, params.status],
      );
    }

    async function seedAtsWebPipelineHistory(
      c: Client,
      params: {
        id: string;
        pipelineId: string;
        statusFrom: string;
        statusTo: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO pipeline."PipelineStatusHistory"
           (id, tenant_id, pipeline_id, status_from, status_to)
         VALUES ($1,$2,$3,$4::"pipeline"."PipelineStatus",$5::"pipeline"."PipelineStatus")
         ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.pipelineId, params.statusFrom, params.statusTo],
      );
    }

    async function seedAtsWebActivity(
      c: Client,
      params: {
        id: string;
        type: string;
        subjectType?: string;
        subjectId?: string;
        notes?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO activity."Activity"
           (id, tenant_id, type, subject_type, subject_id, notes)
         VALUES ($1,$2,$3::"activity"."ActivityType",$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.type,
          params.subjectType ?? null,
          params.subjectId ?? null,
          params.notes ?? null,
        ],
      );
    }

    // PC-5d — task + attachment fixture ids. task owner_id / attachment
    // owner_id are logical UUID refs (no FK). The my-tasks list keys to the
    // recruiter (assignee_id = RECRUITER_ID); the attachment 'talent' owner is
    // a real talent_record.TalentRecord (validateOwner requires it on create).
    const ATSW_TASK_ID = '00000000-0000-7000-8000-7a5c00000001';
    const ATSW_TASK_OWNER_REQ_ID = '00000000-0000-7000-8000-4e9200000001';
    const ATSW_ATT_ID = '00000000-0000-7000-8000-a77ac0000001';
    const ATSW_ATT_TALENT_ID = '00000000-0000-7000-8000-7a1e00000002';

    // COMPOSABLE (PC-5d+): seed a task. created_by_user_id is required (set to
    // the recruiter); assignee defaults to the recruiter so the my-tasks list
    // (keyed to authContext.sub) returns it; status defaults 'open'.
    async function seedAtsWebTask(
      c: Client,
      params: {
        id: string;
        title: string;
        ownerType: string;
        ownerId: string;
        assigneeId?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO task."Task"
           (id, tenant_id, title, created_by_user_id, owner_type, owner_id, assignee_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.title,
          RECRUITER_ID,
          params.ownerType,
          params.ownerId,
          params.assigneeId ?? RECRUITER_ID,
        ],
      );
    }

    async function seedAtsWebAttachment(
      c: Client,
      params: {
        id: string;
        ownerType: string;
        ownerId: string;
        fileName: string;
        mime: string;
        sizeBytes: number;
        storageKey: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO attachment."Attachment"
           (id, tenant_id, owner_type, owner_id, file_name, mime, size_bytes, storage_key)
         VALUES ($1,$2,$3::"attachment"."AttachmentOwnerType",$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.ownerType,
          params.ownerId,
          params.fileName,
          params.mime,
          params.sizeBytes,
          params.storageKey,
        ],
      );
    }

    // PC-4b — Promotion / Advisory / Sourcing fixture ids (talent_trust L2).
    const ATSW_DETAIL_LIVE_ID = '00000000-0000-7000-8000-7a0000000010';
    const ATSW_DETAIL_SUPERSEDED_ID = '00000000-0000-7000-8000-7a0000000011';
    const ATSW_SUPERSEDED_BY_ID = '00000000-0000-7000-8000-7a0000000012';
    const ATSW_POOL_SUBJECT_ID = '00000000-0000-7000-8000-5b1000000001';
    const ATSW_POOL_SUBJECT_B_ID = '00000000-0000-7000-8000-5b1000000008';
    const ATSW_POOL_SOURCED_REF_ID = '00000000-0000-7000-8000-50c000000001';
    const ATSW_POOL_ADVISORY_ID = '00000000-0000-7000-8000-adf000000009';
    const ATSW_MINT_SUBJECT_ID = '00000000-0000-7000-8000-5b1000000002';
    const ATSW_MINT_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000001';
    const ATSW_PROMOTED_SUBJECT_ID = '00000000-0000-7000-8000-5b1000000003';
    const ATSW_PROMOTED_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000002';
    const ATSW_PROMOTED_TALENT_ID = '00000000-0000-7000-8000-7a0000000013';
    const ATSW_DEFER_SUBJECT_ID = '00000000-0000-7000-8000-5b1000000004';
    const ATSW_DEFER_SUBJECT_B_ID = '00000000-0000-7000-8000-5b1000000005';
    const ATSW_DEFER_ARRIVAL_ID = '00000000-0000-7000-8000-a44000000003';
    const ATSW_DEFER_ADVISORY_ID = '00000000-0000-7000-8000-adf00000000a';
    const ATSW_ADV_SUBJECT_A_ID = '00000000-0000-7000-8000-5b1000000006';
    const ATSW_ADV_SUBJECT_B_ID = '00000000-0000-7000-8000-5b1000000007';
    const ATSW_ADV_PENDING_ID = '00000000-0000-7000-8000-adf000000001';
    const ATSW_ADV_MERGED_ID = '00000000-0000-7000-8000-adf000000002';
    const ATSW_ADV_CONTRADICTION_ID = '00000000-0000-7000-8000-adf000000003';
    // TR-14 B2 — the trust dossier states.
    const ATSW_DOSSIER_RECORD_ID = '00000000-0000-7000-8000-d05000000001';
    const ATSW_DOSSIER_SUBJECT_ID = '00000000-0000-7000-8000-d05000000002';
    const ATSW_DOSSIER_REF_ID = '00000000-0000-7000-8000-d05000000003';
    const ATSW_DOSSIER_EVIDENCE_ID = '00000000-0000-7000-8000-d05000000004';
    const ATSW_DOSSIER_EVENT_ID = '00000000-0000-7000-8000-d05000000005';
    const ATSW_DOSSIER_EMPTY_RECORD_ID = '00000000-0000-7000-8000-d05000000010';
    const ATSW_CONTRA_SUBJECT_ID = '00000000-0000-7000-8000-d05000000020';
    const ATSW_CONTRA_REF_ID = '00000000-0000-7000-8000-d05000000021';
    const ATSW_CONTRA_RECORD_ID = '00000000-0000-7000-8000-d05000000022';
    const ATSW_CONTRA_EVIDENCE_ID = '00000000-0000-7000-8000-d05000000023';
    // TR-12 B2 — the Trust Proposals worklist states.
    const ATSW_PROP_OPEN_ID = '00000000-0000-7000-8000-d12000000001';
    const ATSW_PROP_TERMINAL_ID = '00000000-0000-7000-8000-d12000000002';
    const ATSW_PROP_SUBJECT_ID = '00000000-0000-7000-8000-d12000000005';
    const ATSW_PROP_RECORD_ID = '00000000-0000-7000-8000-d12000000010';
    const ATSW_PROP_REF_ID = '00000000-0000-7000-8000-d12000000011';
    const ATSW_PROP_EVIDENCE_ID = '00000000-0000-7000-8000-d12000000020';

    // TR-12 B2 — seed a VerificationProposal (talent_trust worklist row). All
    // vocab is TEXT (no enum casts); basis_snapshot is jsonb (kinds only).
    async function seedAtsWebVerificationProposal(
      c: Client,
      params: { id: string; subjectId: string; status?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."VerificationProposal"
           (id, tenant_id, subject_id, kind, trigger_kind, basis_ref_id, basis_snapshot, status,
            created_by, created_at, updated_at, resolved_by, resolved_at, justification)
         VALUES ($1,$2,$3,'RESOLVE_CONTRADICTION','OPEN_CONTRADICTION',$4,$5::jsonb,$6,
            'caseworker', now(), now(), $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.subjectId,
          ATSW_PROP_EVIDENCE_ID,
          JSON.stringify({ assertion_type: 'EMPLOYMENT' }),
          params.status ?? 'OPEN',
          params.status !== undefined && params.status !== 'OPEN' ? 'prior-actor' : null,
          params.status !== undefined && params.status !== 'OPEN' ? new Date() : null,
          params.status !== undefined && params.status !== 'OPEN' ? 'prior resolution' : null,
        ],
      );
    }

    // COMPOSABLE (PC-4b+): seed a ResolutionSubject (talent_trust L2 anchor).
    // All talent_trust vocab is TEXT (no enum casts). status defaults ACTIVE.
    async function seedAtsWebResolutionSubject(
      c: Client,
      params: { id: string; status?: string; mergedIntoSubjectId?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."ResolutionSubject"
           (id, tenant_id, status, merged_into_subject_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.status ?? 'ACTIVE', params.mergedIntoSubjectId ?? null],
      );
    }

    async function seedAtsWebResolutionSubjectRef(
      c: Client,
      params: { id: string; subjectId: string; refType: string; refId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source)
         VALUES ($1,$2,$3,$4,$5,'pact-seed') ON CONFLICT (id) DO NOTHING`,
        [params.id, params.subjectId, TENANT_ID, params.refType, params.refId],
      );
    }

    async function seedAtsWebTrustState(
      c: Client,
      params: {
        subjectId: string;
        identityBand: string;
        claimsBand: string;
        continuityBand: string;
        eligibilityBand: string;
        openContradictionCount?: number;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."TrustState"
           (subject_id, tenant_id, identity_band, claims_band, continuity_band,
            eligibility_band, open_contradiction_count, last_recomputed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (subject_id) DO NOTHING`,
        [
          params.subjectId,
          TENANT_ID,
          params.identityBand,
          params.claimsBand,
          params.continuityBand,
          params.eligibilityBand,
          params.openContradictionCount ?? 0,
        ],
      );
    }

    // Evidence — non-read defaults are picked from valid vocab; the promote/
    // pool/detail paths only read dimension + assertion_type + current_status +
    // assertion_payload.
    async function seedAtsWebEvidenceRecord(
      c: Client,
      params: {
        id: string;
        subjectId: string;
        assertionType: string;
        assertionPayload: Record<string, unknown>;
        dimension?: string;
        currentStatus?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."EvidenceRecord"
           (id, subject_id, tenant_id, dimension, assertion_type, assertion_payload,
            source_class, method, strength, collected_at, decay_profile,
            portability_class, current_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,'THIRD_PARTY_UNVERIFIED','DOCUMENT',0.1,
                 NOW(),'SLOW','TENANT_ONLY',$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          params.subjectId,
          TENANT_ID,
          params.dimension ?? 'IDENTITY',
          params.assertionType,
          JSON.stringify(params.assertionPayload),
          params.currentStatus ?? 'VALID',
          RECRUITER_ID,
        ],
      );
    }

    // TR-14 B2 — seed an EvidenceEvent (the dossier evidence timeline's spine).
    async function seedAtsWebEvidenceEvent(
      c: Client,
      params: {
        id: string;
        evidenceId: string;
        eventType: string;
        reason?: string | null;
        linkedEvidenceId?: string | null;
        actor?: string | null;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."EvidenceEvent"
           (id, evidence_id, tenant_id, event_type, reason, linked_evidence_id, actor, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          params.evidenceId,
          TENANT_ID,
          params.eventType,
          params.reason ?? null,
          params.linkedEvidenceId ?? null,
          params.actor ?? RECRUITER_ID,
        ],
      );
    }

    async function seedAtsWebSubjectMatchAdvisory(
      c: Client,
      params: {
        id: string;
        subjectA: string;
        subjectB: string;
        adviseBand: string;
        status: string;
        hasContradiction?: boolean;
        survivingSubjectId?: string;
        mergedSubjectId?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, has_contradiction,
            match_basis, status, surviving_subject_id, merged_subject_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'{"shared":[],"contradiction_kinds":[]}'::jsonb,
                 $7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.subjectA,
          params.subjectB,
          params.adviseBand,
          params.hasContradiction ?? false,
          params.status,
          params.survivingSubjectId ?? null,
          params.mergedSubjectId ?? null,
          RECRUITER_ID,
        ],
      );
    }

    // The L1 origin arrival (ingestion.RawPayloadReference) the promote basis
    // check reads: source MUST be a consent-source type (talent_direct). id
    // MUST equal the SOURCED_TALENT ref_id. updated_at is @updatedAt (no default
    // → supply it in the raw insert).
    async function seedAtsWebRawPayloadReference(
      c: Client,
      params: { id: string; source?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO ingestion."RawPayloadReference"
           (id, tenant_id, source, source_class, storage_ref, sha256, content_type,
            captured_at, created_at, updated_at)
         VALUES ($1,$2,$3,'SELF','seed://arrival',
                 '0000000000000000000000000000000000000000000000000000000000000000',
                 'application/json',NOW(),NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.source ?? 'talent_direct'],
      );
    }

    // PC-7b — settings-surface fixture ids + seed helpers (identity + settings).
    const ATSW_SITE_ID = '00000000-0000-7000-8000-51e000000001';
    const ATSW_SITE_CHILD_ID = '00000000-0000-7000-8000-51e000000002';
    const ATSW_SITE_INACTIVE_ID = '00000000-0000-7000-8000-51e000000003';

    // The tenant row every settings/profile/domain endpoint scopes to. Only
    // id+name are required; later Tenant columns are nullable/defaulted.
    async function seedAtsWebTenant(
      c: Client,
      params: {
        domainStatus?: string;
        token?: string | null;
        tokenIssuedAt?: string | null;
        allowedDomain?: string | null;
      } = {},
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."Tenant"
           (id, name, domain_verification_status, domain_verification_token,
            domain_token_issued_at, allowed_domain, updated_at)
         VALUES ($1,'Astre Consulting',$2,$3,$4,$5,NOW()) ON CONFLICT (id) DO NOTHING`,
        [
          TENANT_ID,
          params.domainStatus ?? 'UNVERIFIED',
          params.token ?? null,
          params.tokenIssuedAt ?? null,
          params.allowedDomain ?? null,
        ],
      );
    }

    async function seedAtsWebSite(
      c: Client,
      params: { id: string; name: string; isActive?: boolean; parentSiteId?: string | null },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."Site" (id, tenant_id, name, is_active, parent_site_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.name, params.isActive ?? true, params.parentSiteId ?? null],
      );
    }

    async function seedAtsWebIdentityAuditEvent(
      c: Client,
      params: { id: string; eventType: string; subjectId: string; createdAt?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."IdentityAuditEvent"
           (id, tenant_id, actor_type, actor_id, event_type, subject_id, event_payload, created_at)
         VALUES ($1,$2,'user',$3,$4,$5,'{}'::jsonb,$6) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          PACT_RECRUITER_ACTOR_ID,
          params.eventType,
          params.subjectId,
          params.createdAt ?? '2026-05-01T00:00:00.000Z',
        ],
      );
    }

    async function seedAtsWebTenantSetting(
      c: Client,
      params: { key: string; value: unknown },
    ): Promise<void> {
      await c.query(
        `INSERT INTO settings."TenantSetting" (tenant_id, key, value, updated_at)
         VALUES ($1,$2,$3::jsonb,NOW()) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [TENANT_ID, params.key, JSON.stringify(params.value)],
      );
    }

    // PC-7c — identity-admin fixture ids + seed helpers. Tables with @updatedAt
    // (User/Role/Membership/Team/Invitation) must supply updated_at.
    const ATSW_USER_A = '00000000-0000-7000-8000-05e100000001';
    const ATSW_USER_B = '00000000-0000-7000-8000-05e100000002';
    const ATSW_MEMBERSHIP_ID = '00000000-0000-7000-8000-33b000000001';
    const ATSW_ROLE_ID = '00000000-0000-7000-8000-401e00000001';
    const ATSW_ITEAM_ID = '00000000-0000-7000-8000-77ea00000001';
    const ATSW_TMEMBER_ID = '00000000-0000-7000-8000-77ee00000001';
    // PC-7d — import batch fixture id (list + failures target).
    const ATSW_IMPORT_BATCH_ID = '00000000-0000-7000-8000-1ba700000001';
    const ATSW_EDGE_ID = '00000000-0000-7000-8000-ed6e00000001';

    async function seedAtsWebUser(
      c: Client,
      params: { id: string; email: string; displayName?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."User" (id, email, display_name, updated_at)
         VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, params.email, params.displayName ?? null],
      );
    }
    async function seedAtsWebMembership(
      c: Client,
      params: { id: string; userId: string; isActive?: boolean; inviteStatus?: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."UserTenantMembership"
           (id, user_id, tenant_id, is_active, invite_status, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, params.userId, TENANT_ID, params.isActive ?? true, params.inviteStatus ?? 'ACTIVE'],
      );
    }
    async function seedAtsWebRole(
      c: Client,
      params: { id: string; key: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."Role" (id, key, updated_at)
         VALUES ($1,$2,NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, params.key],
      );
    }
    async function seedAtsWebMembershipRole(
      c: Client,
      params: { id: string; membershipId: string; roleId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id)
         VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [params.id, params.membershipId, params.roleId],
      );
    }
    async function seedAtsWebIdentityTeam(
      c: Client,
      params: { id: string; name: string; ownerUserId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."Team" (id, tenant_id, name, owner_user_id, updated_at)
         VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.name, params.ownerUserId],
      );
    }
    async function seedAtsWebTeamMembership(
      c: Client,
      params: { id: string; teamId: string; userId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."TeamMembership" (id, tenant_id, team_id, user_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.teamId, params.userId],
      );
    }
    async function seedAtsWebManagementEdge(
      c: Client,
      params: { id: string; managerUserId: string; reportUserId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO identity."ManagementEdge" (id, tenant_id, manager_user_id, report_user_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [params.id, TENANT_ID, params.managerUserId, params.reportUserId],
      );
    }
    async function seedAtsWebInvitation(
      c: Client,
      params: {
        id: string;
        userId: string;
        membershipId: string;
        tokenHash: string;
        // PC-7d — accept token-reason machine: `expired` stamps expires_at in
        // the past (→ 'expired'); revoked_at/accepted_at drive the other
        // reasons. All default to a valid, unconsumed invite.
        expired?: boolean;
      },
    ): Promise<void> {
      const expiresExpr = params.expired
        ? `NOW() - INTERVAL '1 day'`
        : `NOW() + INTERVAL '7 days'`;
      await c.query(
        `INSERT INTO identity."Invitation"
           (id, user_id, tenant_id, membership_id, token_hash, expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,${expiresExpr},NOW()) ON CONFLICT (id) DO NOTHING`,
        [params.id, params.userId, TENANT_ID, params.membershipId, params.tokenHash],
      );
    }
    // PC-7d — import batch/failure seeds (GET /v1/imports + :id/failures reads).
    async function seedAtsWebImportBatch(
      c: Client,
      params: {
        id: string;
        importedById: string;
        targetEntity: string;
        sourceFilename: string;
        rowCount?: number;
        successCount?: number;
        failureCount?: number;
        status?: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO import."ImportBatch"
           (id, tenant_id, site_id, imported_by_id, target_entity, source_filename,
            row_count, success_count, failure_count, status, created_at)
         VALUES ($1,$2,NULL,$3,$4::import."ImportTargetEntity",$5,$6,$7,$8,
                 $9::import."ImportBatchStatus",NOW()) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.importedById,
          params.targetEntity,
          params.sourceFilename,
          params.rowCount ?? 0,
          params.successCount ?? 0,
          params.failureCount ?? 0,
          params.status ?? 'pending',
        ],
      );
    }
    async function seedAtsWebImportFailure(
      c: Client,
      params: {
        id: string;
        importBatchId: string;
        rowNumber: number;
        failureReason: string;
        offendingFields: string[];
        originalRowData: Record<string, unknown>;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO import."ImportFailure"
           (id, tenant_id, import_batch_id, row_number, failure_reason,
            offending_fields, original_row_data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,NOW()) ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          TENANT_ID,
          params.importBatchId,
          params.rowNumber,
          params.failureReason,
          JSON.stringify(params.offendingFields),
          JSON.stringify(params.originalRowData),
        ],
      );
    }

    // COMPOSABLE (PC-3 reuse): seed requisition + talent + a tiered active
    // examination for (PACT_TALENT_ID, ATSW_SUB_JOB_ID).
    async function seedAtsWebExamination(
      c: Client,
      params: {
        examinationId: string;
        tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
        computedAt: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO job_domain."Job" (id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [ATSW_SUB_JOB_ID, TENANT_ID],
      );
      await c.query(
        `INSERT INTO job_domain."Requisition" (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1,$2,$3,$4,'active'::job_domain."RequisitionState") ON CONFLICT DO NOTHING`,
        [ATSW_SUB_REQ_ID, TENANT_ID, ATSW_SUB_JOB_ID, PACT_RECRUITER_ACTOR_ID],
      );
      await seedAtsWebTalentRecord(c, {
        id: PACT_TALENT_ID,
        firstName: 'Pact',
        lastName: 'Talent',
      });
      await c.query(
        `INSERT INTO examination."TalentJobExamination"
           (id, tenant_id, talent_id, job_id, golden_profile_id, trigger,
            tier, rank_ordinal, why_matched_sentence, match_summary,
            expanded_reasoning, skill_match, experience_match,
            constraint_checks, strengths, gaps, risk_flags,
            confidence_indicators, freshness_indicator, delta_to_entrustable,
            examination_version, model_version, taxonomy_version,
            computed_at, lifecycle_state)
         VALUES ($1,$2,$3,$4,$5,'initial_match'::examination."ExaminationTrigger",
                 $6::examination."ExaminationTier",$7,$8,$9,
                 $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,
                 $20,$21,$22,$23,'active'::examination."ExaminationLifecycleState")`,
        [
          params.examinationId,
          TENANT_ID,
          PACT_TALENT_ID,
          ATSW_SUB_JOB_ID,
          ATSW_SUB_GOLDEN_ID,
          params.tier,
          1,
          'Strong critical-skill coverage',
          'baseline match summary',
          JSON.stringify([]),
          JSON.stringify({ matched_count: 5, missing_count: 0, per_skill: [] }),
          JSON.stringify({ years: 7, summary: 'Strong overlap' }),
          JSON.stringify({}),
          JSON.stringify(['typescript-expertise']),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify({
            evidence_strength: { level: 'high', basis: 'ingested-evidence' },
            data_completeness: { level: 'high', basis: 'profile-complete' },
            constraint_confidence: { level: 'high', basis: 'verified' },
          }),
          JSON.stringify({ profile_age_days: 14 }),
          JSON.stringify(null),
          'v1',
          'v1',
          'v1',
          params.computedAt,
        ],
      );
    }

    // COMPOSABLE (PC-3 reuse): seed the immutable evidence package row,
    // back-linked to the submittal.
    async function seedAtsWebEvidencePackage(
      c: Client,
      params: { evidencePackageId: string; examinationId: string; submittalId: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO evidence."TalentJobEvidencePackage"
           (id, tenant_id, talent_id, job_id, examination_id, submittal_record_id,
            talent_identity, contact_summary, capability_summary,
            match_justification, recruiter_contribution, engagement_event_refs)
         VALUES ($1,$2,$3,$4,$5,$6,
                 $7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)`,
        [
          params.evidencePackageId,
          TENANT_ID,
          PACT_TALENT_ID,
          ATSW_SUB_JOB_ID,
          params.examinationId,
          params.submittalId,
          JSON.stringify({ full_name: 'Pact Talent', location: 'Remote (US)' }),
          JSON.stringify({ contact_available: true, channels_verified: ['email'] }),
          JSON.stringify({
            key_work_history: [{ employer_name: 'Acme', role_title: 'Senior Engineer' }],
          }),
          JSON.stringify({ why_this_talent: 'Pact-seeded sample.' }),
          JSON.stringify({
            conversation_summary: { recruiter_summary: 'Discussed.' },
            talent_confirmed: { spoken_to_recruiter: true },
          }),
          JSON.stringify([]),
        ],
      );
    }

    // Seed a submittal record in a given state, pinned to an examination.
    async function seedAtsWebSubmittal(
      c: Client,
      params: {
        submittalId: string;
        evidencePackageId: string;
        examinationId: string;
        state: string;
        justification?: string | null;
        fca?: ReadonlyArray<Record<string, unknown>> | null;
        confirmedAt?: string | null;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO engagement."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id,
            pinned_examination_id, state, created_by,
            justification, failed_criterion_acknowledgments, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::engagement."SubmittalState",$8,$9,$10::jsonb,$11)`,
        [
          params.submittalId,
          TENANT_ID,
          PACT_TALENT_ID,
          ATSW_SUB_JOB_ID,
          params.evidencePackageId,
          params.examinationId,
          params.state,
          PACT_RECRUITER_ACTOR_ID,
          params.justification ?? null,
          params.fca === undefined || params.fca === null ? null : JSON.stringify(params.fca),
          params.confirmedAt ?? null,
        ],
      );
    }

    // Orchestrate the full chain (examination + evidence + submittal) in a
    // given state/tier, with optional newer-examination (pinned-outdated).
    async function seedAtsWebSubmittalChain(
      c: Client,
      params: {
        submittalId: string;
        state: string;
        tier?: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
        justification?: string | null;
        seedNewer?: boolean;
      },
    ): Promise<void> {
      await seedAtsWebExamination(c, {
        examinationId: ATSW_SUB_EXAM_ID,
        tier: params.tier ?? 'ENTRUSTABLE',
        computedAt: '2026-05-22T09:00:00.000Z',
      });
      if (params.seedNewer === true) {
        // A newer examination for the same (talent, job) → confirm's
        // findLatestByTenantTalentJob != pinned → EXAMINATION_PINNED_OUTDATED.
        await seedAtsWebExamination(c, {
          examinationId: ATSW_SUB_EXAM_NEWER_ID,
          tier: 'ENTRUSTABLE',
          computedAt: '2026-05-23T09:00:00.000Z',
        });
      }
      await seedAtsWebEvidencePackage(c, {
        evidencePackageId: ATSW_SUB_EVIDENCE_ID,
        examinationId: ATSW_SUB_EXAM_ID,
        submittalId: params.submittalId,
      });
      // Ruling 6: submit-to-ats populates confirmed_at (NULL -> non-NULL);
      // it persists through 'confirmed'. A legitimately submitted_to_ats /
      // confirmed row therefore ALWAYS carries confirmed_at — seed it so
      // the confirm-ats happy-path response projects a real timestamp
      // (direct-seed without it returned confirmed_at='' → pact regex fail).
      const confirmedAt =
        params.state === 'submitted_to_ats' || params.state === 'confirmed'
          ? '2026-05-25T00:00:00.000Z'
          : null;
      await seedAtsWebSubmittal(c, {
        submittalId: params.submittalId,
        evidencePackageId: ATSW_SUB_EVIDENCE_ID,
        examinationId: ATSW_SUB_EXAM_ID,
        state: params.state,
        justification: params.justification ?? null,
        confirmedAt,
      });
    }





    async function insertExaminationRow(
      c: Client,
      opts: {
        id: string;
        talentId: string;
        jobId: string;
        goldenId: string;
        tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
        computedAt: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO examination."TalentJobExamination"
           (id, tenant_id, talent_id, job_id, golden_profile_id, trigger,
            tier, rank_ordinal, why_matched_sentence, match_summary,
            expanded_reasoning, skill_match, experience_match,
            constraint_checks, strengths, gaps, risk_flags,
            confidence_indicators, freshness_indicator, delta_to_entrustable,
            examination_version, model_version, taxonomy_version,
            computed_at, lifecycle_state)
         VALUES ($1,$2,$3,$4,$5,'initial_match'::examination."ExaminationTrigger",
                 $6::examination."ExaminationTier",$7,$8,$9,
                 $10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
                 $15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,
                 $20,$21,$22,$23,'active'::examination."ExaminationLifecycleState")`,
        [
          opts.id,
          TENANT_ID,
          opts.talentId,
          opts.jobId,
          opts.goldenId,
          opts.tier,
          1,
          'Strong critical-skill coverage',
          'baseline match summary',
          JSON.stringify([]),
          JSON.stringify({
            matched_count: 5,
            missing_count: 0,
            per_skill: [],
          }),
          JSON.stringify({ years: 7, summary: 'Strong overlap' }),
          JSON.stringify({}),
          JSON.stringify(['typescript-expertise']),
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify({
            evidence_strength: { level: 'high', basis: 'ingested-evidence' },
            data_completeness: { level: 'high', basis: 'profile-complete' },
            constraint_confidence: { level: 'high', basis: 'verified' },
          }),
          JSON.stringify({ profile_age_days: 14 }),
          JSON.stringify(null),
          'v1',
          'v1',
          'v1',
          opts.computedAt,
        ],
      );
    }

    // M4 PR-5 §4.10 — hashRowAsJson computes a deterministic content
    // hash of the TalentJobExamination row for state-isolation byte-
    // identity verification. Canonicalize JSON keys (sort) so any
    // ordering wobble from the Prisma adapter is normalized out, then
    // sha256 the result.
    function hashRowAsJson(row: Record<string, unknown>): string {
      const sortedKeys = Object.keys(row).sort();
      const canonical: Record<string, unknown> = {};
      for (const k of sortedKeys) {
        const v = row[k];
        // Date instances → ISO; everything else passes through. The
        // analytical jsonb columns come back as objects/arrays already.
        canonical[k] = v instanceof Date ? v.toISOString() : v;
      }
      const json = JSON.stringify(canonical);
      // Lazy require so the import surface above stays narrow.
      const { createHash } = require('node:crypto') as typeof import('node:crypto');
      return createHash('sha256').update(json).digest('hex');
    }

    // M4 PR-5 §4.10 — seed an examination + optional pre-execution row
    // hash for override state-isolation verification.
    //
    // params:
    //   - examinationExists: true → INSERT a TalentJobExamination row
    //     (used by the "happy" + "invalid type" interactions). false →
    //     no insert (used by the NOT_FOUND interaction).
    //   - examinationActive: true → lifecycle_state='active'. Only
    //     consulted when examinationExists=true.
    //
    // Returns the seeded examination_id (matching the consumer test's
    // path-param UUID) + tenant_id + the captured pre-execution hash
    // (when applicable). The hash is also recorded in the module-level
    // overrideStateIsolation.preHash map keyed by examination_id; the
    // afterEach hook re-reads + asserts byte-identity post-interaction.
    async function seedOverrideFixture(
      c: Client,
      params: {
        examinationExists: boolean;
        examinationActive: boolean;
        examinationId: string;
        talentId: string;
        jobId: string;
      },
    ): Promise<{
      examination_id: string;
      tenant_id: string;
      preExecutionExaminationHash?: string;
    }> {
      const result: {
        examination_id: string;
        tenant_id: string;
        preExecutionExaminationHash?: string;
      } = {
        examination_id: params.examinationId,
        tenant_id: TENANT_ID,
      };

      if (!params.examinationExists) {
        return result;
      }

      const goldenId = '55551111-0000-7000-8000-0000000000aa';
      const reqId = '55552222-0000-7000-8000-0000000000aa';
      await c.query(
        `INSERT INTO job_domain."Requisition"
           (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")
         ON CONFLICT DO NOTHING`,
        [reqId, TENANT_ID, params.jobId, RECRUITER_ID],
      );
      await insertExaminationRow(c, {
        id: params.examinationId,
        talentId: params.talentId,
        jobId: params.jobId,
        goldenId,
        tier: params.examinationActive ? 'ENTRUSTABLE' : 'ENTRUSTABLE',
        computedAt: '2026-05-23T09:00:00.000Z',
      });
      if (!params.examinationActive) {
        await c.query(
          `UPDATE examination."TalentJobExamination"
             SET lifecycle_state = 'archived'::examination."ExaminationLifecycleState",
                 archived_at = '2026-05-23T10:00:00.000Z'
           WHERE id = $1`,
          [params.examinationId],
        );
      }

      // Capture pre-execution hash for state-isolation verification.
      const { rows } = await c.query(
        `SELECT * FROM examination."TalentJobExamination" WHERE id = $1`,
        [params.examinationId],
      );
      if (rows.length === 1) {
        const hash = hashRowAsJson(rows[0] as Record<string, unknown>);
        overrideStateIsolation.preHash.set(params.examinationId, hash);
        result.preExecutionExaminationHash = hash;
      }
      return result;
    }

    // M4 PR-5 §4.10 — afterEach state-isolation check. Runs after every
    // verified interaction (Pact-JS proxy registerAfterHook). For each
    // examination_id where the state handler captured a pre-execution
    // hash, re-read the TalentJobExamination row + compute post-hash +
    // assert byte-identity. On mismatch, record an explicit violation
    // message that the it() block asserts-empty post-verification.
    async function checkOverrideStateIsolation(): Promise<void> {
      if (overrideStateIsolation.preHash.size === 0) return;
      await withClient(async (c) => {
        for (const [examId, preHash] of overrideStateIsolation.preHash) {
          const { rows } = await c.query(
            `SELECT * FROM examination."TalentJobExamination" WHERE id = $1`,
            [examId],
          );
          if (rows.length !== 1) {
            // Row vanished — that's also an isolation violation.
            overrideStateIsolation.violations.push(
              `State-isolation invariant violated: TalentJobExamination row mutated by override creation. Expected hash: ${preHash}; got: <row not found>.`,
            );
            continue;
          }
          const postHash = hashRowAsJson(rows[0] as Record<string, unknown>);
          if (postHash !== preHash) {
            overrideStateIsolation.violations.push(
              `State-isolation invariant violated: TalentJobExamination row mutated by override creation. Expected hash: ${preHash}; got: ${postHash}.`,
            );
          }
        }
      });
      overrideStateIsolation.preHash.clear();
    }

    // M4 PR-7 §4.9 — seed helper for submittal-revoke pact verification.
    //
    // Seeds Talent + TalentTenantOverlay + Requisition +
    // TalentJobEvidencePackage + TalentSubmittalRecord (when
    // submittalExists=true) at the requested submittalState. The
    // chain walks the canonical 5-state mainline (created ->
    // handoff_draft -> ready_for_review -> submitted_to_ats ->
    // confirmed) in order via raw SQL UPDATEs, each going through
    // the M5 PR-8b2-rewritten column-scoped trigger
    // (engagement.reject_submittal_record_update). For
    // submittalState='revoked', sibling-revoke fires directly from
    // 'created' (legal Q3 transition) with all three revoke columns
    // populated atomically.
    //
    // When submittalExists=true, the pre-execution
    // TalentJobEvidencePackage row hash is captured and pushed into
    // evidencePackageStateIsolation.preHashes (keyed by
    // evidence_package_id). The afterEach hook re-reads + asserts
    // byte-identity post-interaction, mirroring the
    // overrideStateIsolation pattern from M4 PR-5.
    // M5 PR-8b2 recovery — fast direct INSERT for state-handler seeding
    // of the 3 new endpoints (mark-ready / submit-to-ats / confirm-ats).
    // Unlike seedSubmittalRevokeFixture (which walks the full chain
    // including Requisition + Examination + EvidencePackage seeds), this
    // helper only INSERTs the TalentSubmittalRecord row directly at the
    // requested state. Justification: the new endpoints touch only
    // TalentSubmittalRecord (findById + canTransition + $transaction
    // update + appendEvent). No cross-schema FK traversal; no chain
    // walk needed. INSERT bypasses the UPDATE-only trigger (Ruling 7),
    // so the row can be inserted at any state directly.
    //
    // Confirmed_at is populated for submitted_to_ats/confirmed seed
    // states (preserving M4 column semantic per Ruling 6); NULL
    // otherwise. revoke columns stay NULL (no revoke pre-state seeded
    // by this helper; revoke pre-states use seedSubmittalRevokeFixture
    // for the state-isolation pre-hash capture).
    async function seedSubmittalRowFast(
      c: Client,
      opts: {
        submittalId: string;
        evidencePackageId: string;
        examinationId: string;
        talentId: string;
        jobId: string;
        state: 'created' | 'handoff_draft' | 'ready_for_review' | 'submitted_to_ats' | 'confirmed';
      },
    ): Promise<void> {
      const confirmedAt =
        opts.state === 'submitted_to_ats' || opts.state === 'confirmed'
          ? "'2026-05-22T13:00:00Z'::timestamptz"
          : 'NULL';
      await c.query(
        `INSERT INTO engagement."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id,
            pinned_examination_id, state, created_by,
            justification, failed_criterion_acknowledgments,
            confirmed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, $7::engagement."SubmittalState", $8::uuid,
                 NULL, NULL, ${confirmedAt})`,
        [
          opts.submittalId,
          TENANT_ID,
          opts.talentId,
          opts.jobId,
          opts.evidencePackageId,
          opts.examinationId,
          opts.state,
          RECRUITER_ID,
        ],
      );
    }


    // M4 PR-7 §4.9 — afterEach state-isolation check for evidence
    // packages. For each evidence_package_id where the state handler
    // captured a pre-execution hash, re-read the row + compute the
    // post-hash + assert byte-identity. On mismatch, record an
    // explicit violation message that the it() block asserts-empty
    // post-verification. Mirrors checkOverrideStateIsolation exactly.
    async function checkEvidencePackageStateIsolation(): Promise<void> {
      if (evidencePackageStateIsolation.preHashes.size === 0) return;
      await withClient(async (c) => {
        for (const [pkgId, preHash] of evidencePackageStateIsolation.preHashes) {
          const { rows } = await c.query(
            `SELECT * FROM evidence."TalentJobEvidencePackage" WHERE id = $1`,
            [pkgId],
          );
          if (rows.length !== 1) {
            evidencePackageStateIsolation.violations.push(
              `State-isolation invariant violated: TalentJobEvidencePackage row mutated by submittal revoke. Expected hash: ${preHash}; got: <row not found>.`,
            );
            continue;
          }
          const postHash = hashRowAsJson(rows[0] as Record<string, unknown>);
          if (postHash !== preHash) {
            evidencePackageStateIsolation.violations.push(
              `State-isolation invariant violated: TalentJobEvidencePackage row mutated by submittal revoke. Expected hash: ${preHash}; got: ${postHash}.`,
            );
          }
        }
      });
      evidencePackageStateIsolation.preHashes.clear();
    }

    async function seedIdempotencyKey(
      c: Client,
      opts: {
        id: string;
        key: string;
        requestHash: string;
        // M5 PR-9 §4.2 — optional response status + body so replay
        // state-handlers can seed an actual prior response that the
        // controller's idempotency.lookup returns verbatim. Defaults
        // preserve M3 PR-2 / M4 PR-3 / M5 PR-3 conflict-test callsites
        // (status=201, body={pact_seeded:true}) where only the
        // existence + request_hash matter (controller throws 409 on
        // hash mismatch before reading the cached body).
        responseStatus?: number;
        responseBody?: unknown;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO consent."IdempotencyKey"
           (id, tenant_id, key, request_hash, response_status, response_body)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          opts.id,
          TENANT_ID,
          opts.key,
          opts.requestHash,
          opts.responseStatus ?? 201,
          JSON.stringify(opts.responseBody ?? { pact_seeded: true }),
        ],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      dbUrl = url;

      // Apply consent + ingestion migrations via raw SQL. Prisma 7 uses
      // driver adapters (PR-2 precedent surfaced) and its constructor
      // signature differs from the legacy datasourceUrl shape; using
      // node-postgres directly here keeps the migration apply small and
      // dependency-free of the consent module's PrismaService wrapper.
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const migrationPath of [
        CONSENT_MIGRATION,
        CONSENT_REKEY_MIGRATION,
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
        INGESTION_T2_ADDITIVE_MIGRATION,
        INGESTION_4B_ADDITIVE_MIGRATION,
        INGESTION_FS2_ADDITIVE_MIGRATION,
        INGESTION_FS2_DROP_MIGRATION,
        INGESTION_EXTRACTION_MARKER_MIGRATION,
        INGESTION_SOURCE_CLASS_MIGRATION,
        INGESTION_DECLARED_NAME_MIGRATION,
        INGESTION_CONFIRMED_METHOD_MIGRATION,
        EXAMINATION_INIT_MIGRATION,
        EXAMINATION_LIVE_LIST_MIGRATION,
        // M4 PR-5 §4.10 — ExaminationOverride table + immutability trigger
        // (applied after the prior examination migrations so the schema
        // search path is set up).
        EXAMINATION_OVERRIDE_MIGRATION,
        JOB_DOMAIN_INIT_MIGRATION,
        // 4e-engagement-key — talent_record schema (engagement.talent_id).
        ...TALENT_RECORD_MIGRATIONS,
        // M4 PR-3 §4.8 — evidence + talent-evidence + submittal
        // migrations applied so the submittal-create pact verification
        // can build the evidence package + persist the workflow record.
        TALENT_EVIDENCE_INIT_MIGRATION,
        TALENT_EVIDENCE_TR7_MIGRATION,
        EVIDENCE_INIT_MIGRATION,
        SUBMITTAL_INIT_MIGRATION,
        // M4 PR-7 §4.9 — submittal-revoke schema extension (enum +
        // columns + Transition B trigger). Applied AFTER the submittal
        // init migration so the ALTER TYPE / ALTER TABLE statements
        // hit the existing enum/table.
        SUBMITTAL_REVOKE_MIGRATION,
        // M5 PR-8b1 §4.9 — TalentSubmittalEvent event-log substrate.
        // Applied after the submittal init + revoke migrations so the
        // intra-schema FK on TalentSubmittalRecord resolves.
        SUBMITTAL_EVENT_LOG_MIGRATION,
        // M5 PR-8b2 §4.13 — submittal canonical rename + cutover.
        // Applied AFTER event-log substrate so the pre-rename event
        // log row integrity is preserved through the enum rename
        // (Postgres ALTER TYPE RENAME VALUE migrates by OID, so
        // existing event_payload JSON strings referencing M4 names
        // would not auto-rewrite — at this point in the pact-verify
        // sequence no rows exist yet, so the rename is clean).
        SUBMITTAL_RENAME_MIGRATION,
        // M6 PR-2 §3 — submittal schema OutboxEvent. Applied LAST in
        // the submittal sequence because it CREATEs the new `submittal`
        // PG namespace alongside its OutboxEvent table.
        SUBMITTAL_OUTBOX_MIGRATION,
        // M5 PR-4 — engagement schema + event log for engagement-*
        // pact verification.
        ENGAGEMENT_INIT_MIGRATION,
        ENGAGEMENT_EVENT_LOG_MIGRATION,
        // M6 PR-2 §3 — engagement schema OutboxEvent. Applied after
        // the event-log substrate so the OutboxEvent table is in the
        // same `engagement` namespace as the prior tables.
        ENGAGEMENT_OUTBOX_MIGRATION,
        // Outreach Draft/Preview Amendment v1.1 §3 — the outreach_drafted
        // enum value (the draft + send pact split).
        ENGAGEMENT_OUTREACH_DRAFTED_MIGRATION,
        // TR-2a-B3b — the four immutability reconcile-re-key amendments (applied
        // AFTER each schema's trigger-defining migrations; CREATE OR REPLACE FUNCTION
        // redefines the final trigger fn — GUC-off behaviour is unchanged).
        ENGAGEMENT_RECONCILE_REKEY_MIGRATION,
        EXAMINATION_RECONCILE_REKEY_MIGRATION,
        SUBMITTAL_RECONCILE_REKEY_MIGRATION,
        EVIDENCE_RECONCILE_REKEY_MIGRATION,
        // M5 PR-6 §4.14 — ai-draft schema for outreach-send state
        // handlers. AiDraftService writes audit-event rows even when
        // the DraftProvider is mocked at AppModule bootstrap.
        AI_DRAFT_INIT_MIGRATION,
        // PR-A1b §4 — entitlement schema for the portal-thin pact
        // interactions; @RequireCapability('portal') on PortalController
        // requires the tenant to be entitled before RolesGuard runs.
        ENTITLEMENT_INIT_MIGRATION,
        // PR-A1c §4 — metering schema (in-tx UsageEvent INSERT in every
        // engagement + submittal state-transition write method).
        METERING_INIT_MIGRATION,
        // Settings S1 — additive substrate for the GET /v1/tenant/settings
        // endpoint AppModule wires post-S1. No current consumer pact targets
        // /v1/tenant/settings; the migration applies harmlessly and keeps
        // the verifier ready for future settings-touching consumer pacts
        // (the S2 pricing-model write, S3 user-management, etc.).
        // PC-7b — full identity chain (Tenant + Site + IdentityAuditEvent +
        // all Tenant-column additions the Prisma client SELECTs).
        IDENTITY_INIT_MIGRATION,
        IDENTITY_SITE_AXIS_MIGRATION,
        IDENTITY_AUTHZ_TEAM_MIGRATION,
        IDENTITY_TENANT_PROFILE_MIGRATION,
        IDENTITY_SITE_HIERARCHY_MIGRATION,
        IDENTITY_INVITATION_MIGRATION,
        IDENTITY_ALLOWED_DOMAIN_MIGRATION,
        IDENTITY_DOMAIN_VERIFICATION_MIGRATION,
        IDENTITY_TENANT_SLUG_MIGRATION,
        IDENTITY_IDP_MIGRATION, IDENTITY_IDP_MIGRATION_LC,
        SETTINGS_INIT_MIGRATION,
        // PC-4 — activity + pipeline for the talent-records enrichment reads.
        ACTIVITY_INIT_MIGRATION,
        PIPELINE_INIT_MIGRATION,
        // PC-5a — company + contact desk. Company init CREATEs the schema +
        // Company + CompanyDepartment; the authz migration adds the two D4a
        // join tables (UserClientAssignment, TeamClientOwnership); the field-
        // expansion / address-place-ref / off-limits ALTERs add the columns
        // CompanyView + the paged facets read. Contact init CREATEs the schema
        // + Contact; the list-surface migration adds relationship_role /
        // preference / last_activity_at. Search PR-1 (pg_trgm) omitted (index-
        // only; no ?q= path contracted).
        COMPANY_INIT_MIGRATION,
        COMPANY_IMPORT_BATCH_MIGRATION,
        COMPANY_AUTHZ_MIGRATION,
        COMPANY_FIELD_EXPANSION_MIGRATION,
        COMPANY_ADDRESS_PLACE_REF_MIGRATION,
        COMPANY_OFF_LIMITS_MIGRATION,
        CONTACT_INIT_MIGRATION,
        CONTACT_IMPORT_BATCH_MIGRATION,
        CONTACT_LIST_SURFACE_MIGRATION,
        // PC-5b — requisition spine (Requisition + RequisitionAssignment +
        // the comp/job-module/rate-type columns RequisitionView reads). init
        // CREATEs the schema + enum; all FKs intra-schema. job_domain (for
        // profile-confirm's Job/GoldenProfile/Requisition writes) is already
        // applied above. Search PR-1 (pg_trgm) omitted (index-only; no ?q=).
        REQUISITION_INIT_MIGRATION,
        REQUISITION_IMPORT_BATCH_MIGRATION,
        REQUISITION_COMPENSATION_MIGRATION,
        REQUISITION_JOB_MODULE_MIGRATION,
        REQUISITION_DROP_LEGACY_COMP_MIGRATION,
        REQUISITION_RATE_TYPE_MIGRATION,
        // PC-5d — task + attachment (final desk increment). task init +
        // workspace-fields (enum extension + source column); attachment init.
        // All self-contained (CREATE SCHEMA in init), no FK.
        TASK_INIT_MIGRATION,
        TASK_WORKSPACE_MIGRATION,
        ATTACHMENT_INIT_MIGRATION,
        // PC-4b — talent_trust L2 substrate (11) + saved_list write-closure (2).
        TALENT_TRUST_INIT_MIGRATION,
        TALENT_TRUST_ANCHOR_MIGRATION,
        TALENT_TRUST_ADVISORY_MIGRATION,
        TALENT_TRUST_ADVISORY_RESOLUTION_MIGRATION,
        TALENT_TRUST_WATERMARK_MIGRATION,
        // TR-6 B1 — last_matched_at (client SELECTs it on every subject read).
        TALENT_TRUST_TR6_LAST_MATCHED_MIGRATION,
        TALENT_TRUST_ATS_REF_UNIQUE_MIGRATION,
        TALENT_TRUST_POOL_KEYSET_MIGRATION,
        TALENT_TRUST_B1_SOURCE_CLASS_MIGRATION,
        TALENT_TRUST_B1_SOURCE_CLASS_UNIQUE_MIGRATION,
        TALENT_TRUST_B2_REOPEN_MIGRATION,
        TALENT_TRUST_B3B_MERGE_OP_MIGRATION,
        // TR-6 B1 — SubjectMergeOperation.kind/actor/reason (the reverse-happy
        // advisory state's unmergeSubjects persists a DIRECT_UNMERGE row).
        TALENT_TRUST_TR6_MERGE_OP_KIND_MIGRATION,
        // TR-3 B2 — VerificationRequest (the email-verification confirm/request
        // provider states seed + write it).
        TALENT_TRUST_TR3_VERIFICATION_REQUEST_MIGRATION,
        // TR-4 B1 — EvidenceLink semantic uniqueness (additive index).
        TALENT_TRUST_TR4_LINK_UNIQUE_MIGRATION,
        // TR-4 B3 — last_consistency_at watermark (regenerated client SELECTs it).
        TALENT_TRUST_TR4_CONSISTENCY_WATERMARK_MIGRATION,
        // TR-5 B2 — TrustState thinness flags (regenerated client SELECTs them).
        TALENT_TRUST_TR5_THINNESS_FLAGS_MIGRATION,
        // TR-8 D2 — TrustState.verified_control_stale (regenerated client SELECTs it).
        TALENT_TRUST_TR8_VERIFIED_STALE_MIGRATION,
        // TR-12 B1 — the VerificationProposal table (regenerated client knows it).
        TALENT_TRUST_TR12_PROPOSAL_MIGRATION,
        SAVED_LIST_INIT_MIGRATION,
        SAVED_LIST_LIST_KIND_MIGRATION,
        IMPORT_INIT_MIGRATION,
        CALENDAR_INIT_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }

      // PR-A1b §4 — seed the pact-verifier tenant with the `portal`
      // capability. The migration's default-posture INSERT seeds only
      // SEED_IDS.tenant (01900000-...001); this verifier uses TENANT_ID
      // (11111111-...111), so an explicit row is required for the
      // portal-thin pact interactions to traverse EntitlementGuard.
      await setup.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'portal') ON CONFLICT DO NOTHING`,
        [TENANT_ID],
      );
      // PC-4 — the 'ats' capability so TENANT_ID traverses EntitlementGuard
      // on the talent-record controller's @RequireCapability('ats'). Additive
      // (mirrors the 'portal' seed above); the engagement/submittal/examination
      // interactions don't use EntitlementGuard, so this is inert for them.
      await setup.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats') ON CONFLICT DO NOTHING`,
        [TENANT_ID],
      );
      // PC-4b — the 'core' capability so TENANT_ID traverses EntitlementGuard
      // on the sourcing + advisory-resolution controllers'
      // @RequireCapability('core'). Additive; inert for prior interactions.
      await setup.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`,
        [TENANT_ID],
      );
      await setup.end();

      // Inline JWT signing per Amendment §2.2 — production issuer
      // 'Aramo Core Auth' so JwtAuthGuard accepts the token. Mirrors
      // libs/consent/src/tests/cookie-auth.integration.spec.ts.
      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        MAILER_PROVIDER: process.env['MAILER_PROVIDER'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      // TR-3 B2 — pin the STUB mailer so the email-verification request state's
      // MAILER_PORT.send is a no-op (never SES). MailerModule's useFactory reads
      // MAILER_PORT at binding; AppModule already imports it (via IdentityModule
      // and now directly for the verification flow), so this env must resolve.
      process.env['MAILER_PROVIDER'] = 'stub';

      // PR-A1a §6 — recruiter accessJwt carries 'submittal:create'.
      // PR-A1a-2 §3 — adds 'submittal:approve' for the 5 newly-guarded
      // confirm/revoke/mark-ready/submit-to-ats/confirm-ats routes that
      // the retired thin-consumer pacts exercised. The 'ingestion:write'
      // entry is preserved for the legacy ingestion-typed interactions
      // that still assert this scope shape. Recruiter role in the
      // PR-A1a-2 seed catalog carries the full operational scope set; the
      // provider mint reflects the subset those pacts required.
      accessJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        // AUTHZ-D4b: pact-provider verifies the API CONTRACT (response
        // shapes / status codes), not visibility scoping. Add the
        // requisition:read:all bit so the D4b cascade short-circuits on
        // GET /v1/submittals/:id (otherwise the recruiter — no D4a
        // UserClientAssignment seeded in the pact state — gets 404 on
        // the visibility cascade). Same escalation pattern as the
        // submittal-get / submittal-evidence-package negative-shape
        // specs (D4b commit-plan §2 ruling 5 — vocab/contract tests).
        scopes: [
          'ingestion:write',
          'submittal:create',
          'submittal:approve',
          'requisition:read:all',
          // R7 BE-prereq: engagement endpoints now scope-gated.
          // requisition:read:all is already present above and bypasses
          // the D4b visibility check on engagement endpoints (provider
          // tests verify the API contract, not visibility scoping).
          'engagement:read',
          'engagement:write',
          'engagement:outreach',
          // PC-4 — talent-record CRUD scopes (RolesGuard @RequireScopes on
          // libs/talent-record/src/lib/talent-record.controller.ts). Additive;
          // existing interactions check their own scopes, so extra scopes are
          // inert for them (non-regression = 61 green in CI).
          'talent:read',
          'talent:create',
          'talent:edit',
          // PC-5a — Gate-2a desk (company + contact + D4a) RolesGuard
          // @RequireScopes. company:read:all additionally short-circuits the
          // VisibilityInterceptor resolver to zero reads on the company/
          // contact CRUD reads (contracts pin shapes, not the visibility-
          // restricted path — Gate-5 Q4 ruling). company:assign gates the
          // per-company assignment routes; team:manage gates the team-client
          // ownership routes. Additive; inert for prior interactions.
          'company:read',
          'company:read:all',
          'company:search',
          'company:create',
          'company:edit',
          'company:delete',
          'company:assign',
          'contact:read',
          'contact:search',
          'contact:create',
          'contact:edit',
          'team:manage',
          // PC-5b — requisition spine RolesGuard @RequireScopes. read:all
          // (already present above) short-circuits visibility; requisition:read
          // satisfies the GET routes' scope check; edit gates PATCH (the in-
          // service status/comp gate resolves 'edit' for a non-comp field like
          // is_hot); profile:generate gates profile-confirm; assign gates the
          // assignment routes. No compensation:view:*/requisition:view:
          // financials scopes — the masked comp/financial keys stay stripped
          // (contracts pin the non-commercial shape).
          'requisition:read',
          'requisition:create',
          'requisition:edit',
          'requisition:profile:generate',
          'requisition:assign',
          // PC-5c — pipeline state machine + activity RolesGuard
          // @RequireScopes. pipeline:change-status gates the transition
          // endpoint (the state machine); pipeline:remove omitted (DELETE is
          // EXCLUDE-R2). Visibility (resolveVisibleRequisitionIds /
          // resolveVisiblePipelineIds) short-circuits to zero reads under the
          // company:read:all / requisition:read:all bits already present.
          'pipeline:read',
          'pipeline:add',
          'pipeline:change-status',
          'activity:read',
          'activity:create',
          // PC-5d — task + attachment RolesGuard @RequireScopes. task:write
          // gates create/patch/delete; attachment:create gates upload;
          // attachment:delete omitted (DELETE is EXCLUDE-R2). Task/attachment
          // visibility short-circuits (task) or is owner-scoped (attachment).
          'task:read',
          'task:write',
          'attachment:read',
          'attachment:create',
          // PC-4b — sourcing (talent:source) + advisory-resolution
          // (identity:resolve) RolesGuard scopes. talent:read (detail) already
          // present above. Sourcing/advisory are @RequireCapability('core')
          // (entitlement seeded above).
          'talent:source',
          'identity:resolve',
          // PC-7b — settings surface (@RequireCapability('core') seeded; these
          // 6 route scopes gate tenant settings/profile/roles/audit/domain/sites).
          'tenant:admin:settings',
          'tenant:admin:profile',
          'tenant:admin:user-manage',
          'audit:read',
          'tenant:admin:domain',
          'tenant:admin:sites',
          // PC-7c — identity-admin (tenant-users directory/assignable reads +
          // management edges). tenant:admin:user-manage + team:manage already
          // present above.
          'tenant:user:read:directory',
          'tenant:user:read:assignable',
          'org:manage',
          // PC-7d — reporting + export + import reads. @RequireCapability('ats')
          // ('ats' entitlement already seeded); /me needs 'core' + no scope;
          // POST /v1/invitations/accept is PUBLIC (no guard, no cookie).
          'dashboard:read',
          'report:read',
          'export:read',
          'import:read',
        ],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      // M3 PR-8 §4.7 — portal-consumer JWT (rejects on the recruiter-only
      // match-list endpoint with 403). M3 PR-9 §4.8 updates sub from
      // RECRUITER_ID to PORTAL_TALENT_ID: the portal session embodies the
      // talent (per directive Ruling 5), and PR-9's portal endpoints
      // derive talent_id from authContext.sub. The PR-8 match-list 403
      // test is unaffected (the controller rejects at consumer_type
      // before the sub value is consulted).
      // PR-A1a-2 §3 — portalJwt now carries portal:profile:read +
      // portal:consent:read so the RolesGuard at the newly-guarded
      // GET /v1/portal/profile and GET /v1/portal/consent routes passes
      // for the portal-thin 200 happy-path pact interactions. The
      // recruiter→portal and ingestion→portal 403 interactions use
      // accessJwt/ingestionJwt (which lack the portal scopes); RolesGuard
      // rejects with 403 INSUFFICIENT_PERMISSIONS — same contract surface
      // as the pre-A1a-2 consumer_type-check rejection.
      portalJwt = await new SignJWT({
        sub: PORTAL_TALENT_ID,
        consumer_type: 'portal',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: ['portal:profile:read', 'portal:consent:read'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      // M3 PR-9 §4.8 — ingestion-typed JWT for the portal-thin 403 test
      // (an ingestion consumer hitting /v1/portal/consent — controller's
      // consumer_type check rejects with 403). Sub doesn't matter (the
      // rejection happens before sub is consulted), so RECRUITER_ID is
      // reused as an arbitrary user UUID.
      ingestionJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'ingestion',
        actor_kind: 'service_account',
        tenant_id: TENANT_ID,
        scopes: ['ingestion:write'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      // M5 PR-6 §4.14 — mock DraftProvider + DeliveryProvider canned
      // results. The outreach-send happy-path interaction asserts
      // model_used + token counts + delivery_channel + delivery_id —
      // these fixtures must match the consumer pact body shape.
      // PC-6 — the draft-provider fake now branches (cycle-law-2: outreach
      // stays byte-identical). intake/profile system_messages carry
      // 'golden_profile' / 'nice_to_have_skills'; both completion parsers are
      // JSON-tolerant, so ONE merged JSON satisfies parseIntakeCompletion
      // (fields/jd_text/required_skills/nice_to_have_skills) AND
      // parseProfileCompletion (jd_text/golden_profile). Anything else (the
      // engagement outreach draft) falls through to the original prose.
      const PACT_DRAFT_JSON = JSON.stringify({
        fields: {},
        jd_text: 'Senior Engineer — pact draft.',
        required_skills: [{ name: 'TypeScript' }],
        nice_to_have_skills: [{ name: 'GraphQL' }],
        golden_profile: {
          jd_text: 'Senior Engineer — pact draft.',
          required_skills: [{ name: 'TypeScript' }],
          preferred_skills: [{ name: 'GraphQL' }],
          critical_skills: [],
          experience: { industries: [] },
          constraints: {},
        },
      });
      const mockDraftProvider = {
        generate: async (input?: { system_message?: string }): Promise<{
          completion: string;
          model_used: string;
          input_tokens: number;
          output_tokens: number;
          provider_request_id: string;
        }> => {
          const sys = input?.system_message ?? '';
          const isStructuredDraft =
            sys.includes('golden_profile') || sys.includes('nice_to_have_skills');
          return {
            completion: isStructuredDraft
              ? PACT_DRAFT_JSON
              : 'Mocked outreach draft for pact verification.',
            model_used: 'claude-sonnet-mock',
            input_tokens: 10,
            output_tokens: 20,
            provider_request_id: 'pact-mock-provider-request-id',
          };
        },
      };
      // PC-6 — resume backends (deterministic; controllers map these to the
      // wire shape). Overriding ResumeParserService wholesale bypasses its
      // internal ObjectStorageService.createPresignedGet + real fetch.
      const mockObjectStorage = {
        createResumePresignedPut: async () => ({
          storage_key: 'resumes/pact-seed.pdf',
          presigned_url: 'https://mock-storage.local/put/pact-seed',
          expires_at: '2026-05-25T00:05:00.000Z',
        }),
      };
      const mockResumeParser = {
        parseFromStorageKey: async () => ({
          prefill: {
            first_name: 'Grace',
            last_name: 'Hopper',
            email1: 'grace@example.com',
          },
          parse_status: 'parsed' as const,
        }),
      };
      const mockDeliveryProvider = {
        deliver: async (): Promise<{
          delivered: true;
          delivered_at: Date;
          delivery_id: string;
          delivery_channel: 'email';
        }> => ({
          delivered: true,
          delivered_at: new Date('2026-05-25T10:01:00.000Z'),
          delivery_id: '00000000-0000-7000-8000-ffff0d000001',
          delivery_channel: 'email',
        }),
      };
      // PC-7c — tenant-user lifecycle backends (deterministic; controllers +
      // DB stay live-verified). Cognito adminCreateUser returns a fixed sub;
      // disable/enable/delete are void. audit-gate pins the gated-ON shapes
      // (isFinancialsAuditEnabled → true). MAILER_PORT (string token) send
      // returns a fixed message_id.
      const mockTenantCognito = {
        adminCreateUser: async () => ({
          cognito_sub: '00000000-0000-7000-8000-c09000000001',
        }),
        adminDeleteUser: async () => undefined,
        adminDisableUser: async () => undefined,
        adminEnableUser: async () => undefined,
      };
      const mockAuditFinancialsGate = {
        isFinancialsAuditEnabled: async () => true,
      };
      const mockMailer = {
        send: async () => ({ message_id: 'pact-mock-message-id' }),
      };

      module = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(PACT_DRAFT_PROVIDER_TOKEN)
        .useValue(mockDraftProvider)
        .overrideProvider(PACT_DELIVERY_PROVIDER_TOKEN)
        .useValue(mockDeliveryProvider)
        // PC-6 — resume mock-infra (backends only).
        .overrideProvider(ObjectStorageService)
        .useValue(mockObjectStorage)
        .overrideProvider(ResumeParserService)
        .useValue(mockResumeParser)
        // PC-7c — tenant-user lifecycle backends (Symbol + string tokens).
        .overrideProvider(TENANT_COGNITO_PORT)
        .useValue(mockTenantCognito)
        .overrideProvider(AUDIT_FINANCIALS_GATE)
        .useValue(mockAuditFinancialsGate)
        .overrideProvider('MAILER_PORT')
        .useValue(mockMailer)
        .compile();

      app = module.createNestApplication();
      // Mirror apps/api/src/main.ts: cookieParser() before ValidationPipe
      // so JwtAuthGuard sees request.cookies and class-validator runs at
      // the controller boundary with the same whitelist + transform
      // settings as production.
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // State handlers for the live consumer pacts (ingestion, portal-thin,
    // prohibited-source-type, ats-web). The retired thin-consumer dead
    // handlers were removed in the backlog-item-2 prune (see file header);
    // the retired tenant-console-consumer's exclusive handlers were removed
    // in the console retirement (its two shared given-states survive below,
    // driven by ats-web).
    // Each handler:
    //   1. Begins by truncating every table the pacts touch (resetAllRows),
    //      ensuring no prior interaction's rows leak forward.
    //   2. Seeds the rows the state name describes.
    //
    // Ordering note: the named-given strings below are the EXACT given()
    // arguments from the consumer tests. The PR-15 vocabulary rule
    // (§8.1-B token-free state-handler strings) is satisfied because none
    // of these strings are introduced by this harness — they ship with the
    // consumer pacts (no token-free re-authoring needed beyond what the
    // consumer tests already produced).
    const stateHandlers: Record<string, () => Promise<void>> = {
      // ===== PR-14 ingestion pacts =====
      'a recruiter session and a prohibited source value at the wire':
        async () => {
          await withClient((c) => resetAllRows(c));
        },
      'an ingestion session with no prior payload matching the submitted sha256':
        async () => {
          await withClient((c) => resetAllRows(c));
        },
      'an ingestion session and a talent record with no prior indeed shortlist for the submitted sha256':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      // ===== consent given-states (PR-15 §4.2 origin; ats-web-driven since
      // PC-7a — the tenant-console-consumer suite is retired) =====
      'a recruiter session and a talent with decision-log entries': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          // One grant audit row; the controller returns it as the sole
          // entries[] element with next_cursor=null (default limit=50).
          await seedAuditEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { scope: 'profile_storage' },
            createdAt: '2026-04-29T00:00:00.000Z',
          });
        });
      },
      // PC-7a — 2 consent events so that a ?limit=1 read returns 1 event AND a
      // non-null next_cursor: the cursor-opacity pin (the FE passes it back
      // verbatim, never parsed). Uses the live seedConsentEvent.
      'an ats-web recruiter and a talent with multiple consent history events':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedConsentEvent(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1b01',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-04-29T00:00:00.000Z',
              createdAt: '2026-04-29T00:00:00.000Z',
              expiresAt: null,
            });
            await seedConsentEvent(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1b02',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-04-30T00:00:00.000Z',
              createdAt: '2026-04-30T00:00:00.000Z',
              expiresAt: null,
            });
          });
        },
      'a recruiter session and a talent with consent state': async () => {
        // §4.2 #4 — seed profile_storage + resume_processing grants; the
        // remaining 3 scopes return no_grant by Decision D (always-5-scopes
        // shape). The pact asserts scopes[0]=profile_storage granted,
        // scopes[1]=resume_processing granted, scopes[2..4]=other 3 scopes.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a10',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a11',
            scope: 'resume_processing',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'no valid token': async () => {
        // §4.3 — Bearer 'not-a-jwt' bypasses the rewriting filter so
        // JwtAuthGuard returns INVALID_TOKEN 401.
        await withClient((c) => resetAllRows(c));
      },
      // ===== M5 PR-9 §4.2 — idempotency replay + conflict state-handlers =====
      // Per Plan v1.5 §M5 Track B item 2 + doc/01 §11 anchor. Each replay
      // handler computes the same hashCanonicalizedBody value the controller
      // will compute from the Pact-shipped request body, seeds an
      // IdempotencyKey row carrying that hash + the cached response_body,
      // and the controller's idempotencyService.lookup returns the cached
      // body without touching the repository. Each conflict handler seeds
      // a known-different hash so the lookup throws IDEMPOTENCY_KEY_CONFLICT
      // 409 before touching the repository. Resource seeds (submittal,
      // engagement, examination rows) are NOT required because the
      // controller short-circuits on idempotency hit/conflict before any
      // findById call.
      //
      // --- POST /v1/submittals (create) ---
      'an idempotency key has been recorded with a prior create-submittal response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f80',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f02',
              requestHash: hashCanonicalizedBody({
                talent_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
                examination_id: '11110000-0000-7000-8000-0000000e0001',
                talent_identity: {
                  full_name: 'Sample Talent',
                  preferred_name: 'Sam',
                  location: 'Remote (US)',
                },
                contact_summary: {
                  contact_available: true,
                  channels_verified: ['email'],
                },
                capability_summary_overrides: {
                  key_work_history: [
                    {
                      employer_name: 'Acme Corp',
                      role_title: 'Senior Engineer',
                      start_date: '2021-01-01',
                    },
                  ],
                  certifications: ['AWS Solutions Architect'],
                },
                recruiter_contribution: {
                  screening_notes: 'Spoke 2026-05-22.',
                  conversation_summary: {
                    recruiter_summary: 'Discussed role, fit, and timing.',
                  },
                  talent_confirmed: { spoken_to_recruiter: true },
                },
              }),
              responseStatus: 201,
              responseBody: { submittal: { id: '99990000-0000-7000-8000-000000000d01', state: 'created' } },
            });
          });
        },
      'an idempotency key has been recorded with a different create-submittal body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f81',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f03',
              requestHash: 'pact-pr9-conflict-hash-create-submittal',
            });
          });
        },

      // --- POST /v1/submittals/:id/confirm ---
      'an idempotency key has been recorded with a prior submittal-confirm response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f82',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f15',
              requestHash: hashCanonicalizedBody({
                attestations: {
                  talent_evidence_reviewed: true,
                  constraints_reviewed: true,
                  submittal_risk_acknowledged: true,
                },
              }),
              responseStatus: 200,
              responseBody: { submittal: { id: '99990000-0000-7000-8000-000000000901', state: 'handoff_draft' } },
            });
          });
        },
      'an idempotency key has been recorded with a different submittal-confirm body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f83',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f16',
              requestHash: 'pact-pr9-conflict-hash-submittal-confirm',
            });
          });
        },

      // --- POST /v1/submittals/:id/revoke ---
      'an idempotency key has been recorded with a prior submittal-revoke response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f84',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7110',
              requestHash: hashCanonicalizedBody({
                revocation_justification: 'Position has been put on hold by the hiring manager; revoking the submittal until the requisition resumes.',
              }),
              responseStatus: 200,
              responseBody: {
                submittal: { id: '99990000-0000-7000-8000-000000000931', state: 'revoked' },
                evidence_package_mutated: false,
              },
            });
          });
        },
      'an idempotency key has been recorded with a different submittal-revoke body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f85',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b7111',
              requestHash: 'pact-pr9-conflict-hash-submittal-revoke',
            });
          });
        },

      // --- POST /v1/submittals/:id/mark-ready ---
      'an idempotency key has been recorded with a prior submittal-mark-ready response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f86',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8110',
              requestHash: hashCanonicalizedBody({ _placeholder: true }),
              responseStatus: 200,
              responseBody: { submittal: { id: '99990000-0000-7000-8000-000000000951', state: 'ready_for_review' } },
            });
          });
        },
      'an idempotency key has been recorded with a different submittal-mark-ready body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f87',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8111',
              requestHash: 'pact-pr9-conflict-hash-submittal-mark-ready',
            });
          });
        },

      // --- POST /v1/submittals/:id/submit-to-ats ---
      'an idempotency key has been recorded with a prior submittal-submit-to-ats response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f88',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8210',
              requestHash: hashCanonicalizedBody({ _placeholder: true }),
              responseStatus: 200,
              responseBody: { submittal: { id: '99990000-0000-7000-8000-000000000961', state: 'submitted_to_ats' } },
            });
          });
        },
      'an idempotency key has been recorded with a different submittal-submit-to-ats body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f89',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8211',
              requestHash: 'pact-pr9-conflict-hash-submittal-submit-to-ats',
            });
          });
        },

      // --- POST /v1/submittals/:id/confirm-ats ---
      'an idempotency key has been recorded with a prior submittal-confirm-ats response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8a',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8310',
              requestHash: hashCanonicalizedBody({ _placeholder: true }),
              responseStatus: 200,
              responseBody: { submittal: { id: '99990000-0000-7000-8000-000000000971', state: 'confirmed' } },
            });
          });
        },
      'an idempotency key has been recorded with a different submittal-confirm-ats body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8b',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b8311',
              requestHash: 'pact-pr9-conflict-hash-submittal-confirm-ats',
            });
          });
        },

      // --- POST /v1/engagements (create) ---
      'an idempotency key has been recorded with a prior engagement-create response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8c',
              key: '0190d5a4-7e01-7e2a-a4d3-cccc00000c20',
              requestHash: hashCanonicalizedBody({
                talent_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                requisition_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              }),
              responseStatus: 201,
              responseBody: { engagement: { id: '00000000-0000-7000-8000-cccc00000c01', state: 'surfaced' } },
            });
          });
        },
      'an idempotency key has been recorded with a different engagement-create body (PR-9)':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8d',
              key: '0190d5a4-7e01-7e2a-a4d3-cccc00000c21',
              requestHash: 'pact-pr9-conflict-hash-engagement-create',
            });
          });
        },

      // --- POST /v1/engagements/:id/transitions ---
      'an idempotency key has been recorded with a prior engagement-transition response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8e',
              key: '0190d5a4-7e01-7e2a-a4d3-dddd00000d20',
              requestHash: hashCanonicalizedBody({
                to_state: 'evaluated',
                event_id: '00000000-0000-7000-8000-dddd0e0000e1',
              }),
              responseStatus: 200,
              responseBody: { engagement: { id: '00000000-0000-7000-8000-dddd00000d01', state: 'evaluated' } },
            });
          });
        },
      'an idempotency key has been recorded with a different engagement-transition body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f8f',
              key: '0190d5a4-7e01-7e2a-a4d3-dddd00000d21',
              requestHash: 'pact-pr9-conflict-hash-engagement-transition',
            });
          });
        },

      // --- POST /v1/engagements/:id/outreach ---
      'an idempotency key has been recorded with a prior outreach-send response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f90',
              key: '0190d5a4-7e01-7e2a-a4d3-ffff00000f20',
              requestHash: hashCanonicalizedBody({ prompt: 'Reach out to talent about the role.' }),
              responseStatus: 200,
              responseBody: { engagement: { id: '00000000-0000-7000-8000-ffff00000f01', state: 'awaiting_response' } },
            });
          });
        },
      'an idempotency key has been recorded with a different outreach-send body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f91',
              key: '0190d5a4-7e01-7e2a-a4d3-ffff00000f21',
              requestHash: 'pact-pr9-conflict-hash-outreach-send',
            });
          });
        },

      // --- POST /v1/engagements/:id/response ---
      'an idempotency key has been recorded with a prior response-received response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            // PL-71: body shape mirrors RecordResponseRequestDto (no response_event_id).
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f92',
              key: '0190d5a4-7e01-7e2a-a4d3-eeee00000e20',
              requestHash: hashCanonicalizedBody({
                response_received_at: '2026-05-25T11:00:00.000Z',
                outreach_event_ref_id: '00000000-0000-7000-8000-eeee0e000001',
              }),
              responseStatus: 200,
              responseBody: { engagement: { id: '00000000-0000-7000-8000-eeee00000e01', state: 'responded' } },
            });
          });
        },
      'an idempotency key has been recorded with a different response-received body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f93',
              key: '0190d5a4-7e01-7e2a-a4d3-eeee00000e21',
              requestHash: 'pact-pr9-conflict-hash-response-received',
            });
          });
        },

      // --- POST /v1/engagements/:id/conversation ---
      'an idempotency key has been recorded with a prior conversation-started response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            // PL-71: body shape mirrors RecordConversationStartedRequestDto (single field).
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f94',
              key: '0190d5a4-7e01-7e2a-a4d3-cccc00000c20',
              requestHash: hashCanonicalizedBody({
                conversation_started_at: '2026-05-25T12:00:00.000Z',
              }),
              responseStatus: 200,
              responseBody: { engagement: { id: '00000000-0000-7000-8000-eeee00000e02', state: 'in_conversation' } },
            });
          });
        },
      'an idempotency key has been recorded with a different conversation-started body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f95',
              key: '0190d5a4-7e01-7e2a-a4d3-cccc00000c21',
              requestHash: 'pact-pr9-conflict-hash-conversation-started',
            });
          });
        },

      // --- POST /v1/examinations/:id/overrides ---
      'an idempotency key has been recorded with a prior override-create response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            // PL-71: body shape mirrors CreateOverrideRequestDto + VALID_TIER_BODY
            // from override-create.consumer.test.ts.
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f96',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1510',
              requestHash: hashCanonicalizedBody({
                override_type: 'tier',
                target_field: 'tier',
                justification:
                  'Recruiter judgment: talent work history supports a higher entrustment than the system-assigned tier.',
              }),
              responseStatus: 201,
              responseBody: {
                override: { examination_id: '55550000-0000-7000-8000-0000000f0001' },
                examination_mutated: false,
              },
            });
          });
        },
      'an idempotency key has been recorded with a different override-create body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f97',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1511',
              requestHash: 'pact-pr9-conflict-hash-override-create',
            });
          });
        },

      // --- POST /v1/consent/grant (formal replay) ---
      'an idempotency key has been recorded with a prior consent-grant response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f98',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d30',
              requestHash: hashCanonicalizedBody({
                talent_record_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                scope: 'contacting',
                captured_method: 'recruiter_capture',
                consent_version: 'v1',
                occurred_at: '2026-05-25T10:00:00.000Z',
              }),
              responseStatus: 201,
              responseBody: { event: { talent_record_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', scope: 'contacting' } },
            });
          });
        },

      // --- POST /v1/consent/revoke (formal replay) ---
      'an idempotency key has been recorded with a prior consent-revoke response':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedIdempotencyKey(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f99',
              key: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d31',
              requestHash: hashCanonicalizedBody({
                talent_record_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                scope: 'contacting',
                captured_method: 'recruiter_capture',
                consent_version: 'v1',
                occurred_at: '2026-05-25T11:00:00.000Z',
              }),
              responseStatus: 201,
              responseBody: { event: { talent_record_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', scope: 'contacting' } },
            });
          });
        },

      // ===== END M5 PR-9 §4.2 state-handlers =====

      // -- /v1/consent/state ---------------------------------------------
      'a talent with 4 consent scopes granted; cross_tenant_visibility not granted':
        async () => {
          // §4.3 + Amendment v1.1 §2.4 (Class D) — seed one grant per
          // scope EXCEPT cross_tenant_visibility. Decision D returns
          // granted for the 4 seeded scopes; cross_tenant_visibility
          // returns no_grant (no events) per the always-5-scopes shape.
          // computed_at + scopes[0..3].granted_at are matchered (regex);
          // scopes[4] is exact-match for the no_grant + null pattern.
          await withClient(async (c) => {
            await resetAllRows(c);
            const scopes = [
              'profile_storage',
              'resume_processing',
              'matching',
              'contacting',
            ] as const;
            let idx = 0;
            for (const scope of scopes) {
              idx += 1;
              await seedConsentEvent(c, {
                id: `0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f0${idx}`,
                scope,
                action: 'granted',
                occurredAt: '2026-04-01T10:00:00.000Z',
                expiresAt: null,
              });
            }
          });
        },
      'a recruiter token': async () => {
        // PR-8 §4.7 — pre-DB validation path (malformed job_id → 400
        // INVALID_REQUEST). The recruiter JWT injected by requestFilter
        // satisfies JwtAuthGuard + the consumer_type check; the UUID
        // assertion fires before any repository call.
        await withClient((c) => resetAllRows(c));
      },
      // ===== M3 PR-9 §4.8 portal-thin (5 interactions) =====
      'a portal talent with profile P exists': async () => {
        // PR-9 §4.8 — happy /v1/portal/profile interaction. 4e-rest-b: seed a
        // TalentRecord so the re-homed findSelfProfile returns a projection.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedPortalTalentFixture(c);
        });
      },
      'a portal talent with consent grants G exists': async () => {
        // PR-9 §4.8 — happy /v1/portal/consent interaction. 4e-rest-b: seed a
        // TalentRecord AND a grant for each of the 5 ConsentScope values so
        // every scope in the always-5-scopes response (PR-5 Decision D)
        // carries a non-null granted_at. The consumer pact uses
        // eachLike() with a date-string matcher on granted_at; if any
        // scope's granted_at is null the matcher rejects the array.
        // Mirrors the consent-read "a recruiter session and
        // a talent with consent state" handler's per-scope-grant pattern.
        const SCOPES = [
          'profile_storage',
          'resume_processing',
          'matching',
          'contacting',
          'cross_tenant_visibility',
        ] as const;
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedPortalTalentFixture(c);
          for (let i = 0; i < SCOPES.length; i++) {
            await seedConsentEvent(c, {
              id: `00000000-0000-7000-8000-0000000000a${i + 1}`,
              scope: SCOPES[i] as string,
              action: 'granted',
              occurredAt: '2026-04-01T10:00:00.000Z',
              expiresAt: null,
            });
          }
        });
      },
      'a recruiter token (non-portal consumer)': async () => {
        // PR-9 §4.8 — 403 INSUFFICIENT_PERMISSIONS via recruiter token
        // hitting portal endpoint. No data seeding required; the
        // controller's per-route check rejects before any service call.
        await withClient((c) => resetAllRows(c));
      },
      'an ingestion-consumer token (non-portal)': async () => {
        // PR-9 §4.8 — same as above, ingestion variant. The request
        // filter rewrites 'Bearer eyJfake.ingestion.token' to ingestionJwt.
        await withClient((c) => resetAllRows(c));
      },
      'a portal-consumer token (not recruiter)': async () => {
        // PR-8 §4.7 — the request-filter rewrites the literal
        // 'Bearer eyJfake.portal.token' to portalJwt (consumer_type=portal);
        // the controller's per-route check returns 403
        // INSUFFICIENT_PERMISSIONS before any repository call.
        await withClient((c) => resetAllRows(c));
      },
      // ===== M4 PR-5 §4.10 override-create (3 interactions) =====
      'a recruiter has authenticated and an active examination exists': async () => {
        // PR-5 §4.10 — happy + invalid-type interactions share this
        // state. Seed an active TalentJobExamination matching the
        // consumer test's EXAM_ID_ACTIVE constant and capture the
        // pre-execution row hash for state-isolation verification in
        // afterEach.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedOverrideFixture(c, {
            examinationExists: true,
            examinationActive: true,
            examinationId: '55550000-0000-7000-8000-0000000f0001',
            talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
            jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
          });
        });
      },
      'a recruiter has authenticated': async () => {
        // PR-5 §4.10 — NOT_FOUND interaction. No examination seeded;
        // the controller's repository call into createOverride finds
        // null and refuses with 404 NOT_FOUND. No pre-hash captured
        // (the row doesn't exist, so state-isolation is trivially
        // satisfied).
        await withClient((c) => resetAllRows(c));
      },
      // ===== M5 PR-8b2 §4.12 + recovery (3 new endpoints × 3 interactions = 9) =====
      // Pact consumer interactions for /mark-ready, /submit-to-ats, /confirm-ats
      // use these `given(...)` strings. Each handler does a fast direct
      // INSERT of TalentSubmittalRecord rows in the requested pre-state
      // (no chain walks, no Requisition/Examination/EvidencePackage
      // seeds — these endpoints don't traverse cross-schema FKs).
      // The "in created state" key is shared across 3 invalid-state
      // interactions (mark-ready/submit-to-ats/confirm-ats invalid-
      // state tests); the handler seeds all 3 expected submittal_ids.
      'a recruiter has authenticated and a TalentSubmittalRecord in created state exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000952',
              evidencePackageId: '99990000-0000-7000-8000-000000001052',
              examinationId: '11110000-0000-7000-8000-0000000e00b2',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7052',
              jobId: 'cccccccc-0000-7000-8000-0000000c7052',
              state: 'created',
            });
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000962',
              evidencePackageId: '99990000-0000-7000-8000-000000001062',
              examinationId: '11110000-0000-7000-8000-0000000e00b3',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7062',
              jobId: 'cccccccc-0000-7000-8000-0000000c7062',
              state: 'created',
            });
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000972',
              evidencePackageId: '99990000-0000-7000-8000-000000001072',
              examinationId: '11110000-0000-7000-8000-0000000e00b4',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7072',
              jobId: 'cccccccc-0000-7000-8000-0000000c7072',
              state: 'created',
            });
          });
        },
      'a recruiter has authenticated and a TalentSubmittalRecord in handoff_draft state exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000951',
              evidencePackageId: '99990000-0000-7000-8000-000000001051',
              examinationId: '11110000-0000-7000-8000-0000000e00a1',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7051',
              jobId: 'cccccccc-0000-7000-8000-0000000c7051',
              state: 'handoff_draft',
            });
          });
        },
      'a recruiter has authenticated and the submittal-mark-ready target does not exist for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
          });
        },
      'a recruiter has authenticated and a TalentSubmittalRecord in ready_for_review state exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000961',
              evidencePackageId: '99990000-0000-7000-8000-000000001061',
              examinationId: '11110000-0000-7000-8000-0000000e00a2',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7061',
              jobId: 'cccccccc-0000-7000-8000-0000000c7061',
              state: 'ready_for_review',
            });
          });
        },
      'a recruiter has authenticated and the submittal-submit-to-ats target does not exist for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
          });
        },
      'a recruiter has authenticated and a TalentSubmittalRecord in submitted_to_ats state exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRowFast(c, {
              submittalId: '99990000-0000-7000-8000-000000000971',
              evidencePackageId: '99990000-0000-7000-8000-000000001071',
              examinationId: '11110000-0000-7000-8000-0000000e00a3',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7071',
              jobId: 'cccccccc-0000-7000-8000-0000000c7071',
              state: 'submitted_to_ats',
            });
          });
        },
      'a recruiter has authenticated and the submittal-confirm-ats target does not exist for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
          });
        },
      'a talent with profile granted and contacting revoked': async () => {
        // §4.3 — profile_storage granted (status: granted); contacting
        // granted then revoked (Decision D: revoked). Remaining 3 scopes
        // return no_grant by Decision D.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f10',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-01T10:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f11',
            scope: 'contacting',
            action: 'granted',
            occurredAt: '2026-04-01T11:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f12',
            scope: 'contacting',
            action: 'revoked',
            occurredAt: '2026-04-15T14:22:00.000Z',
            expiresAt: null,
          });
        });
      },

      // ===============================================================
      // PC-1 — ats-web engagement domain state handlers (17). NEW live
      // handlers; the dead ats-thin engagement handlers above are left
      // untouched (distinct given strings → they stay unexercised).
      // ===============================================================

      // -- shared read/mutate fixture: engagement in surfaced state.
      // Serves: list-happy, get-happy, transitions-happy (surfaced ->
      // evaluated), transitions-illegal (surfaced -> engaged), draft-
      // illegal + send-illegal (surfaced cannot reach awaiting_response).
      'an ats-web recruiter and an engagement in surfaced state exist for the talent':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_SURFACED_ID, state: 'surfaced' });
          });
        },

      // -- engagement in responded state + prior outreach_sent event.
      // Serves: conversation-happy (responded -> in_conversation) and
      // response-illegal (ref resolves, then state guard 422s because
      // responded cannot -> responded).
      'an ats-web recruiter and an engagement in responded state with a prior outreach_sent event exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_RESPONDED_ID, state: 'responded' });
            await seedAtsWebEngagementEvent(c, {
              id: ATSW_OUTREACH_SENT_EVENT_ID,
              engagementId: ATSW_RESPONDED_ID,
              eventType: 'outreach_sent',
              payload: ATSW_SENT_PAYLOAD,
            });
          });
        },

      // -- engagement in engaged state (conversation-illegal: engaged is
      // not responded → 422).
      'an ats-web recruiter and an engagement in engaged state exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_ENGAGED_ID, state: 'engaged' });
          });
        },

      // -- engagement in awaiting_response + prior outreach_sent event
      // (response-happy: awaiting_response -> responded, ref resolves).
      'an ats-web recruiter and an engagement in awaiting_response state with a prior outreach_sent event exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_AWAITING_ID, state: 'awaiting_response' });
            await seedAtsWebEngagementEvent(c, {
              id: ATSW_OUTREACH_SENT_EVENT_ID,
              engagementId: ATSW_AWAITING_ID,
              eventType: 'outreach_sent',
              payload: ATSW_SENT_PAYLOAD,
            });
          });
        },

      // -- engagement with a recorded event (events-happy).
      'an ats-web recruiter and an engagement with a recorded event exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_EVENTS_ID, state: 'awaiting_response' });
            await seedAtsWebEngagementEvent(c, {
              id: '00000000-0000-7000-8000-b00000000004',
              engagementId: ATSW_EVENTS_ID,
              eventType: 'outreach_sent',
              payload: ATSW_SENT_PAYLOAD,
            });
          });
        },

      // -- engagement in engaged state + contacting consent (draft-happy:
      // soft consent check passes, no consent_warning).
      'an ats-web recruiter and an engagement in engaged state with contacting consent granted exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_ENGAGED_DRAFT_ID, state: 'engaged' });
            await seedAtsWebContactingConsent(c);
          });
        },

      // -- engagement in engaged state + prior outreach_drafted event +
      // contacting consent (send-happy: state gate + ref resolve +
      // binding consent gate all pass).
      'an ats-web recruiter and an engagement in engaged state with a prior outreach_drafted event and contacting consent granted exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, { id: ATSW_ENGAGED_SEND_ID, state: 'engaged' });
            await seedAtsWebContactingConsent(c);
            await seedAtsWebEngagementEvent(c, {
              id: ATSW_OUTREACH_DRAFTED_EVENT_ID,
              engagementId: ATSW_ENGAGED_SEND_ID,
              eventType: 'outreach_drafted',
              payload: ATSW_DRAFTED_PAYLOAD,
            });
          });
        },

      // -- engaged + drafted event but contacting consent NOT granted
      // (send consent-403: state gate + ref resolve pass, then the binding
      // consent gate denies → 403 CONSENT_NOT_GRANTED_AT_SEND). Note the
      // ledger is non-empty (profile_storage + matching granted) so the
      // check returns 'denied', not the empty-ledger Decision K 'error'.
      'an ats-web recruiter and an engagement in engaged state with a prior outreach_drafted event but contacting consent not granted exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebEngagementBasics(c);
            await seedAtsWebEngagement(c, {
              id: ATSW_ENGAGED_SEND_NO_CONSENT_ID,
              state: 'engaged',
            });
            await seedAtsWebNoContactingConsent(c);
            await seedAtsWebEngagementEvent(c, {
              id: ATSW_OUTREACH_DRAFTED_EVENT_ID,
              engagementId: ATSW_ENGAGED_SEND_NO_CONSENT_ID,
              eventType: 'outreach_drafted',
              payload: ATSW_DRAFTED_PAYLOAD,
            });
          });
        },

      // -- idempotency replay/conflict pairs (5 endpoints × 2). Replay
      // seeds a request_hash matching the consumer body + a cached body
      // the controller returns verbatim; conflict seeds a non-matching
      // request_hash so idempotency.lookup throws 409.
      'a prior engagement-transition response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000091',
              key: ATSW_K_TRANSITION_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_TRANSITION_BODY),
              responseStatus: 200,
              responseBody: { engagement: atswEngagementBody(ATSW_SURFACED_ID, 'evaluated') },
            });
          });
        },
      'an Idempotency-Key was used with a different engagement-transition body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000092',
              key: ATSW_K_TRANSITION_CONFLICT,
              requestHash: 'pact-pc1-conflict-hash-transition',
            });
          });
        },

      'a prior response-received response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000093',
              key: ATSW_K_RESPONSE_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_RESPONSE_BODY),
              responseStatus: 200,
              responseBody: {
                engagement: atswEngagementBody(ATSW_AWAITING_ID, 'responded'),
                response_event: atswEventBody(
                  '00000000-0000-7000-8000-b00000000021',
                  ATSW_AWAITING_ID,
                  'response_received',
                ),
              },
            });
          });
        },
      'an Idempotency-Key was used with a different response-received body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000094',
              key: ATSW_K_RESPONSE_CONFLICT,
              requestHash: 'pact-pc1-conflict-hash-response',
            });
          });
        },

      'a prior conversation-started response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000095',
              key: ATSW_K_CONVERSATION_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_CONVERSATION_BODY),
              responseStatus: 200,
              responseBody: {
                engagement: atswEngagementBody(ATSW_RESPONDED_ID, 'in_conversation'),
                conversation_event: atswEventBody(
                  '00000000-0000-7000-8000-b00000000031',
                  ATSW_RESPONDED_ID,
                  'conversation_started',
                ),
              },
            });
          });
        },
      'an Idempotency-Key was used with a different conversation-started body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000096',
              key: ATSW_K_CONVERSATION_CONFLICT,
              requestHash: 'pact-pc1-conflict-hash-conversation',
            });
          });
        },

      'a prior outreach-draft response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000097',
              key: ATSW_K_DRAFT_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_DRAFT_BODY),
              responseStatus: 200,
              responseBody: {
                draft_event_id: '00000000-0000-7000-8000-b00000000041',
                draft_text: 'Mocked outreach draft for pact verification.',
                ai_draft_audit_record_id: '00000000-0000-7000-8000-b00000000042',
              },
            });
          });
        },
      'an Idempotency-Key was used with a different outreach-draft body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000098',
              key: ATSW_K_DRAFT_CONFLICT,
              requestHash: 'pact-pc1-conflict-hash-draft',
            });
          });
        },

      'a prior outreach-send response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c00000000099',
              key: ATSW_K_SEND_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SEND_BODY),
              responseStatus: 200,
              responseBody: {
                engagement: atswEngagementBody(ATSW_ENGAGED_SEND_ID, 'awaiting_response'),
                outreach_event: atswEventBody(
                  '00000000-0000-7000-8000-b00000000051',
                  ATSW_ENGAGED_SEND_ID,
                  'outreach_sent',
                ),
                delivery_id: '00000000-0000-7000-8000-b00000000052',
              },
            });
          });
        },
      'an Idempotency-Key was used with a different outreach-send body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c0000000009a',
              key: ATSW_K_SEND_CONFLICT,
              requestHash: 'pact-pc1-conflict-hash-send',
            });
          });
        },

      // ===============================================================
      // PC-2 — ats-web submittal domain state handlers (22). Dead
      // ats-thin submittal handlers above left untouched (distinct given
      // strings → they stay unexercised).
      // ===============================================================

      // -- create-happy: an entrustable examination, no submittal yet.
      'an ats-web recruiter and an entrustable examination ready for a new submittal exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebExamination(c, {
              examinationId: ATSW_SUB_EXAM_ID,
              tier: 'ENTRUSTABLE',
              computedAt: '2026-05-22T09:00:00.000Z',
            });
          });
        },

      // -- the created-state fixture (entrustable, latest, with evidence).
      // Serves: find, get, evidence-package, confirm-happy, revoke-happy,
      // attestation-missing, and the mark-ready/submit-to-ats/confirm-ats
      // illegal-state cases (all 422 from 'created').
      'an ats-web recruiter and a created submittal with a current entrustable examination and evidence package exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebSubmittalChain(c, {
              submittalId: ATSW_SUB_CREATED_ID,
              state: 'created',
              tier: 'ENTRUSTABLE',
            });
          });
        },

      // -- get NOT_FOUND: no submittal seeded.
      'an ats-web recruiter and no submittal for the id exist': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- handoff_draft fixture (mark-ready-happy + confirm already-confirmed).
      'an ats-web recruiter and a handoff_draft submittal exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebSubmittalChain(c, {
            submittalId: ATSW_SUB_HANDOFF_ID,
            state: 'handoff_draft',
          });
        });
      },

      // -- ready_for_review fixture (submit-to-ats-happy + confirm-illegal).
      'an ats-web recruiter and a ready_for_review submittal exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebSubmittalChain(c, {
            submittalId: ATSW_SUB_READY_ID,
            state: 'ready_for_review',
          });
        });
      },

      // -- submitted_to_ats fixture (confirm-ats-happy).
      'an ats-web recruiter and a submitted_to_ats submittal exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebSubmittalChain(c, {
            submittalId: ATSW_SUB_SUBMITTED_ID,
            state: 'submitted_to_ats',
          });
        });
      },

      // -- confirmed fixture (revoke-not-allowed: terminal).
      'an ats-web recruiter and a confirmed submittal exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebSubmittalChain(c, {
            submittalId: ATSW_SUB_CONFIRMED_ID,
            state: 'confirmed',
          });
        });
      },

      // -- stretch-tier fixture (confirm STRETCH_BLOCKED).
      'an ats-web recruiter and a created submittal pinned to a stretch-tier examination exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebSubmittalChain(c, {
              submittalId: ATSW_SUB_STRETCH_ID,
              state: 'created',
              tier: 'STRETCH',
            });
          });
        },

      // -- worth-considering-without-justification fixture (JUSTIFICATION_REQUIRED).
      'an ats-web recruiter and a created worth-considering submittal without justification exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebSubmittalChain(c, {
              submittalId: ATSW_SUB_WORTH_ID,
              state: 'created',
              tier: 'WORTH_CONSIDERING',
              justification: null,
            });
          });
        },

      // -- pinned-outdated fixture (a newer examination supersedes the pinned).
      'an ats-web recruiter and a created submittal whose pinned examination has been superseded by a newer one exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebSubmittalChain(c, {
              submittalId: ATSW_SUB_OUTDATED_ID,
              state: 'created',
              tier: 'ENTRUSTABLE',
              seedNewer: true,
            });
          });
        },

      // -- submittal idempotency replay/conflict pairs (6 endpoints × 2).
      'a prior submittal-create response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c101',
              key: ATSW_SUB_K_CREATE_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_CREATE_BODY),
              responseStatus: 201,
              responseBody: { submittal: atswSubmittalBody(ATSW_SUB_CREATED_ID, 'created') },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-create body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c102',
              key: ATSW_SUB_K_CREATE_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-create',
            });
          });
        },
      'a prior submittal-mark-ready response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c201',
              key: ATSW_SUB_K_MARKREADY_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_EMPTY_BODY),
              responseStatus: 200,
              responseBody: { submittal: atswSubmittalBody(ATSW_SUB_HANDOFF_ID, 'ready_for_review') },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-mark-ready body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c202',
              key: ATSW_SUB_K_MARKREADY_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-mark-ready',
            });
          });
        },
      'a prior submittal-submit-to-ats response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c301',
              key: ATSW_SUB_K_SUBMIT_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_EMPTY_BODY),
              responseStatus: 200,
              responseBody: {
                submittal: atswSubmittalBody(ATSW_SUB_READY_ID, 'submitted_to_ats', {
                  confirmedAt: true,
                }),
              },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-submit-to-ats body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c302',
              key: ATSW_SUB_K_SUBMIT_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-submit-to-ats',
            });
          });
        },
      'a prior submittal-confirm response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c401',
              key: ATSW_SUB_K_CONFIRM_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_ATTEST_OK),
              responseStatus: 200,
              responseBody: { submittal: atswSubmittalBody(ATSW_SUB_CREATED_ID, 'handoff_draft') },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-confirm body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c402',
              key: ATSW_SUB_K_CONFIRM_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-confirm',
            });
          });
        },
      'a prior submittal-confirm-ats response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c501',
              key: ATSW_SUB_K_CONFIRMATS_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_EMPTY_BODY),
              responseStatus: 200,
              responseBody: {
                submittal: atswSubmittalBody(ATSW_SUB_SUBMITTED_ID, 'confirmed', {
                  confirmedAt: true,
                }),
              },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-confirm-ats body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c502',
              key: ATSW_SUB_K_CONFIRMATS_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-confirm-ats',
            });
          });
        },
      'a prior submittal-revoke response is cached under an Idempotency-Key':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c601',
              key: ATSW_SUB_K_REVOKE_REPLAY,
              requestHash: hashCanonicalizedBody(ATSW_SUB_REVOKE_BODY),
              responseStatus: 200,
              responseBody: {
                submittal: atswSubmittalBody(ATSW_SUB_CREATED_ID, 'revoked', { revoked: true }),
                evidence_package_mutated: false,
              },
            });
          });
        },
      'an Idempotency-Key was used with a different submittal-revoke body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebIdempotencyKey(c, {
              id: '00000000-0000-7000-8000-c1000000c602',
              key: ATSW_SUB_K_REVOKE_CONFLICT,
              requestHash: 'pact-pc2-conflict-hash-revoke',
            });
          });
        },

      // ===============================================================
      // PC-3 — ats-web examination domain (GET /v1/jobs/:job_id/matches).
      // Reuses seedAtsWebExamination as-is (cycle law 3, no extension).
      // ===============================================================

      // -- match-list happy (with results): active requisition
      // (job_id=ATSW_SUB_JOB_ID) + one active ranked examination →
      // findActiveReqLiveList returns a 1-row summary list.
      'an ats-web recruiter and an active requisition with a ranked examination exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebExamination(c, {
              examinationId: ATSW_SUB_EXAM_ID,
              tier: 'ENTRUSTABLE',
              computedAt: '2026-05-22T09:00:00.000Z',
            });
          });
        },

      // -- match-list empty-list (no active requisition → 200 empty) AND
      // malformed-job_id 400 (validates pre-repo). Both need only a
      // recruiter session over an empty match substrate.
      'an ats-web recruiter and no seeded matches exist': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // ===============================================================
      // PC-4 — ats-web talent-record domain (stable CRUD subset).
      // ===============================================================

      // -- a seeded talent-record (list, paged-search, update:id target).
      'an ats-web recruiter and a talent record exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_TALENT_ID,
            firstName: 'Ada',
            lastName: 'Lovelace',
            tenantStatus: 'active',
            sourceChannel: 'recruiter_capture',
          });
        });
      },

      // -- create: no pre-existing record (the endpoint mints it). The 'ats'
      // entitlement + talent:create scope are set at bootstrap.
      'an ats-web recruiter can create talent records': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // ===============================================================
      // PC-5a — ats-web Gate-2a desk (company + contact CRUD + D4a).
      // ===============================================================

      // -- a seeded company (list, paged-facet list, get:id, patch target;
      // also the parent for department-create, POST assignment, POST team-
      // client, and contact-create).
      'an ats-web recruiter and a company exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebCompany(c, { id: ATSW_COMPANY_ID, name: 'Acme Corp' });
        });
      },

      // -- company + one department (department-list, department-delete).
      'an ats-web recruiter and a company with a department exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebCompany(c, { id: ATSW_COMPANY_ID, name: 'Acme Corp' });
          await seedAtsWebCompanyDepartment(c, {
            id: ATSW_DEPT_ID,
            companyId: ATSW_COMPANY_ID,
            name: 'Engineering',
          });
        });
      },

      // -- create: no pre-existing company (the endpoint mints it).
      'an ats-web recruiter can create companies': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- address-lookup with the external provider unconfigured/failing:
      // the controller swallows to a 200 degraded body ({suggestions:[]} /
      // {details:null}), never a 5xx. No seed — the AppModule boots the
      // provider disabled (no API key), so degraded is the ambient state.
      'the address-lookup provider is in degraded mode': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- company + one user-client assignment (assignments-list, team read,
      // assignment-delete). getTeamForCompany derives member_user_ids from
      // this assignment and owner_id from the (unset) company.owner_id → null.
      'an ats-web recruiter and a company with a user assignment exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebCompany(c, {
              id: ATSW_COMPANY_ID,
              name: 'Acme Corp',
            });
            await seedAtsWebUserClientAssignment(c, {
              id: ATSW_ASSIGNMENT_ID,
              userId: ATSW_ASSIGN_USER_ID,
              companyId: ATSW_COMPANY_ID,
            });
          });
        },

      // -- company + one team-client ownership (team-clients-list, team-
      // client-delete). team_id is a logical ref (no identity.Team seed).
      'an ats-web recruiter and a team with a client ownership exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebCompany(c, {
              id: ATSW_COMPANY_ID,
              name: 'Acme Corp',
            });
            await seedAtsWebTeamClientOwnership(c, {
              id: ATSW_OWNERSHIP_ID,
              teamId: ATSW_TEAM_ID,
              companyId: ATSW_COMPANY_ID,
            });
          });
        },

      // -- a seeded contact under a company (list, paged-facet list, get:id,
      // patch target). The company is seeded so the paged company_name
      // enrichment resolves.
      'an ats-web recruiter and a contact exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebCompany(c, { id: ATSW_COMPANY_ID, name: 'Acme Corp' });
          await seedAtsWebContact(c, {
            id: ATSW_CONTACT_ID,
            companyId: ATSW_COMPANY_ID,
            firstName: 'Ada',
            lastName: 'Byron',
          });
        });
      },

      // ===============================================================
      // PC-5b — ats-web Gate-2a desk (requisition spine + profile-confirm
      // + assignments).
      // ===============================================================

      // -- a seeded profile-less requisition (list, get:id, patch, profile-
      // read [empty DTO], profile-confirm [stamps golden_profile_id], and the
      // parent for POST assignment).
      'an ats-web recruiter and a requisition exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebRequisition(c, {
            id: ATSW_REQ_ID,
            title: 'Senior Engineer',
            companyId: ATSW_REQ_COMPANY_ID,
          });
        });
      },

      // -- create: no pre-existing requisition (the endpoint mints it).
      'an ats-web recruiter can create requisitions': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- requisition + one assignment (assignments-list, assignment-delete).
      'an ats-web recruiter and a requisition with an assignment exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebRequisition(c, {
              id: ATSW_REQ_ID,
              title: 'Senior Engineer',
              companyId: ATSW_REQ_COMPANY_ID,
            });
            await seedAtsWebRequisitionAssignment(c, {
              id: ATSW_REQ_ASSIGNMENT_ID,
              requisitionId: ATSW_REQ_ID,
              userId: ATSW_REQ_ASSIGN_USER_ID,
            });
          });
        },

      // ===============================================================
      // PC-5c — ats-web Gate-2a desk (pipeline state machine + activity).
      // ===============================================================

      // -- a seeded pipeline at the create-state no_contact (list; the happy
      // transition no_contact->contacted; the illegal transition
      // no_contact->placed [INVALID_PIPELINE_TRANSITION 422]).
      'an ats-web recruiter and a pipeline exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebPipeline(c, {
            id: ATSW_PIPE_ID,
            talentRecordId: ATSW_PIPE_TALENT_ID,
            requisitionId: ATSW_PIPE_REQ_ID,
          });
        });
      },

      // -- a pipeline with one status-history entry (create() writes no
      // history, so the row is seeded directly for the history read).
      'an ats-web recruiter and a pipeline with a status history entry exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebPipeline(c, {
              id: ATSW_PIPE_ID,
              talentRecordId: ATSW_PIPE_TALENT_ID,
              requisitionId: ATSW_PIPE_REQ_ID,
            });
            await seedAtsWebPipelineHistory(c, {
              id: ATSW_PIPE_HISTORY_ID,
              pipelineId: ATSW_PIPE_ID,
              statusFrom: 'no_contact',
              statusTo: 'contacted',
            });
          });
        },

      // -- create: no pre-existing pipeline (the endpoint mints it at
      // no_contact). talent_record_id/requisition_id are logical refs.
      'an ats-web recruiter can create pipelines': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- a pipeline at 'offered' whose linked requisition has zero available
      // openings: offered->placed is legal but the placement decrement matches
      // no rows -> REQUISITION_NO_OPENINGS 409.
      'an ats-web recruiter and a pipeline in offered state with no requisition openings exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebRequisition(c, {
              id: ATSW_PIPE_FULL_REQ_ID,
              title: 'Fully Placed Role',
              companyId: ATSW_REQ_COMPANY_ID,
            });
            await c.query(
              `UPDATE requisition."Requisition" SET openings_available = 0 WHERE id = $1`,
              [ATSW_PIPE_FULL_REQ_ID],
            );
            await seedAtsWebPipeline(c, {
              id: ATSW_PIPE_OFFERED_ID,
              talentRecordId: ATSW_PIPE_TALENT_ID,
              requisitionId: ATSW_PIPE_FULL_REQ_ID,
              status: 'offered',
            });
          });
        },

      // -- a seeded activity (activities list).
      'an ats-web recruiter and an activity exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebActivity(c, {
            id: ATSW_ACTIVITY_ID,
            type: 'note',
            subjectType: 'requisition',
            subjectId: ATSW_REQ_ID,
            notes: 'Kickoff call notes.',
          });
        });
      },

      // -- create: no pre-existing activity (the endpoint mints it).
      'an ats-web recruiter can create activities': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // ===============================================================
      // PC-5d — ats-web Gate-2a desk (task + attachment, final increment).
      // ===============================================================

      // -- a seeded task assigned to the recruiter (my-tasks list, patch,
      // delete). assignee_id = RECRUITER_ID so the my-tasks branch (keyed to
      // authContext.sub) returns it; owner is a requisition (logical ref).
      'an ats-web recruiter and a task exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTask(c, {
            id: ATSW_TASK_ID,
            title: 'Call the lead',
            ownerType: 'requisition',
            ownerId: ATSW_TASK_OWNER_REQ_ID,
          });
        });
      },

      // -- create: no pre-existing task (the endpoint mints it). The owner
      // (requisition) is visible under requisition:read:all short-circuit.
      'an ats-web recruiter can create tasks': async () => {
        await withClient((c) => resetAllRows(c));
      },

      // -- a seeded attachment on a talent owner (list). The talent_record
      // owner row is seeded so the shape mirrors a real upload.
      'an ats-web recruiter and an attachment exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_ATT_TALENT_ID,
            firstName: 'Owner',
            lastName: 'Talent',
          });
          await seedAtsWebAttachment(c, {
            id: ATSW_ATT_ID,
            ownerType: 'talent',
            ownerId: ATSW_ATT_TALENT_ID,
            fileName: 'resume.pdf',
            mime: 'application/pdf',
            sizeBytes: 1024,
            storageKey: 's3://bucket/resume.pdf',
          });
        });
      },

      // -- create: the talent owner must exist (validateOwner('talent') 404s
      // otherwise); no pre-existing attachment (the endpoint mints it).
      'an ats-web recruiter can create attachments': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_ATT_TALENT_ID,
            firstName: 'Owner',
            lastName: 'Talent',
          });
        });
      },

      // ===============================================================
      // PC-4b — Promotion / Advisory / Sourcing (post-B3). talent_trust L2.
      // ===============================================================

      // -- detail: a live talent record (record_status='live', supersession
      // fields null).
      'an ats-web recruiter and a live talent record exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_DETAIL_LIVE_ID,
            firstName: 'Ada',
            lastName: 'Lovelace',
          });
        });
      },

      // -- detail: a superseded talent record (DDR-3 — record_status=
      // 'superseded', superseded_by_record_id + superseded_at non-null).
      'an ats-web recruiter and a superseded talent record exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_DETAIL_SUPERSEDED_ID,
            firstName: 'Ada',
            lastName: 'Lovelace',
          });
          await c.query(
            `UPDATE talent_record."TalentRecord"
               SET record_status = 'superseded', superseded_by_record_id = $2, superseded_at = NOW()
             WHERE id = $1`,
            [ATSW_DETAIL_SUPERSEDED_ID, ATSW_SUPERSEDED_BY_ID],
          );
        });
      },

      // TR-3 B2 — email-verification REQUEST happy: a live record (id =
      // PACT_TALENT_ID, the consumer's URL id) with a stored email1 + the full
      // contacting-consent chain granted → the request gate passes and mails the
      // stored slot (stub mailer). resolveOrCreateSubject materializes the
      // subject; the VerificationRequest is written by the flow.
      'an ats-web recruiter and a live talent record with a stored email and consent granted':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebTalentRecord(c, {
              id: PACT_TALENT_ID,
              firstName: 'Ada',
              lastName: 'Lovelace',
            });
            await c.query(
              `UPDATE talent_record."TalentRecord" SET email1 = $2 WHERE id = $1`,
              [PACT_TALENT_ID, 'ada@example.com'],
            );
            await seedAtsWebContactingConsent(c);
          });
        },

      // TR-3 B2 — email-verification REQUEST refused: the same live record with a
      // non-empty ledger but contacting UN-granted → the consent check returns
      // `denied`, which the verification gate maps to 403
      // VERIFICATION_CONSENT_REQUIRED (the ruled divergence).
      'an ats-web recruiter and a live talent record with consent NOT granted':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebTalentRecord(c, {
              id: PACT_TALENT_ID,
              firstName: 'Ada',
              lastName: 'Lovelace',
            });
            await c.query(
              `UPDATE talent_record."TalentRecord" SET email1 = $2 WHERE id = $1`,
              [PACT_TALENT_ID, 'ada@example.com'],
            );
            await seedAtsWebNoContactingConsent(c);
          });
        },

      // TR-3 B2 — public confirm happy: a PENDING VerificationRequest whose
      // token_hash = sha256(the consumer's example token).base64url, pointing at
      // a seeded ACTIVE subject. The confirm consumes it + mints the
      // PLATFORM_VERIFIED anchor + recomputes → 200 VERIFIED.
      'a pending email-verification token exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          const subjectId = '00000000-0000-7000-8000-7e0000000001';
          await seedAtsWebResolutionSubject(c, { id: subjectId });
          const { createHash } =
            require('node:crypto') as typeof import('node:crypto');
          const tokenHash = createHash('sha256')
            .update('a-valid-raw-token')
            .digest('base64url');
          await c.query(
            `INSERT INTO talent_trust."VerificationRequest"
               (id, tenant_id, talent_record_id, subject_id, anchor_kind,
                normalized_value, token_hash, status, created_by, expires_at)
             VALUES ($1,$2,$3,$4,'EMAIL','confirm@example.com',$5,'PENDING',
                     'pact-seed', NOW() + INTERVAL '72 hours')`,
            [
              '00000000-0000-7000-8000-7e0000000002',
              TENANT_ID,
              PACT_TALENT_ID,
              subjectId,
              tokenHash,
            ],
          );
        });
      },

      // TR-3 B2 — public confirm not-found: an empty VerificationRequest floor
      // (resetAllRows truncates it) → any token misses → the ONE oracle-resistant
      // 404 NOT_FOUND.
      'no matching email-verification token exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
        });
      },

      // -- sourcing pool + subject-detail: one sourced ACTIVE subject (SOURCED
      // ref, no ATS ref) with a TrustState (bands), FULL_NAME + EMAIL evidence
      // (display), and a PENDING advisory (subject-detail open_identity_
      // advisories). subject_b has no SOURCED ref -> stays out of the pool.
      'an ats-web recruiter and a sourced subject with trust and a pending advisory exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebResolutionSubject(c, { id: ATSW_POOL_SUBJECT_ID });
            await seedAtsWebResolutionSubject(c, { id: ATSW_POOL_SUBJECT_B_ID });
            await seedAtsWebResolutionSubjectRef(c, {
              id: ATSW_POOL_SOURCED_REF_ID,
              subjectId: ATSW_POOL_SUBJECT_ID,
              refType: 'SOURCED_TALENT',
              refId: ATSW_MINT_ARRIVAL_ID,
            });
            await seedAtsWebTrustState(c, {
              subjectId: ATSW_POOL_SUBJECT_ID,
              identityBand: 'CORROBORATED',
              claimsBand: 'SELF_ASSERTED',
              continuityBand: 'NOT_ESTABLISHED',
              eligibilityBand: 'NOT_ESTABLISHED',
              openContradictionCount: 0,
            });
            await seedAtsWebEvidenceRecord(c, {
              id: '00000000-0000-7000-8000-e00000000001',
              subjectId: ATSW_POOL_SUBJECT_ID,
              assertionType: 'FULL_NAME',
              assertionPayload: { first_name: 'Grace', last_name: 'Hopper' },
            });
            await seedAtsWebEvidenceRecord(c, {
              id: '00000000-0000-7000-8000-e00000000002',
              subjectId: ATSW_POOL_SUBJECT_ID,
              assertionType: 'EMAIL',
              assertionPayload: { normalized_value: 'grace@example.com' },
            });
            await seedAtsWebSubjectMatchAdvisory(c, {
              id: ATSW_POOL_ADVISORY_ID,
              subjectA: ATSW_POOL_SUBJECT_ID,
              subjectB: ATSW_POOL_SUBJECT_B_ID,
              adviseBand: 'ADVISE_WEAK',
              status: 'PENDING_REVIEW',
            });
          });
        },

      // -- TR-14 B2 dossier: a talent record whose ATS_TALENT_RECORD ref resolves
      // to a subject with a TrustState (bands), a CLAIMS evidence row + its CREATED
      // event (the timeline). ledger_established:true; the collections are empty
      // (no contradiction/anchor/merge seeded) — the dossier head pins them loosely.
      'a talent record with a trust dossier exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_DOSSIER_SUBJECT_ID });
          await seedAtsWebResolutionSubjectRef(c, {
            id: ATSW_DOSSIER_REF_ID,
            subjectId: ATSW_DOSSIER_SUBJECT_ID,
            refType: 'ATS_TALENT_RECORD',
            refId: ATSW_DOSSIER_RECORD_ID,
          });
          await seedAtsWebTrustState(c, {
            subjectId: ATSW_DOSSIER_SUBJECT_ID,
            identityBand: 'CORROBORATED',
            claimsBand: 'SELF_ASSERTED',
            continuityBand: 'NOT_ESTABLISHED',
            eligibilityBand: 'NOT_ESTABLISHED',
            openContradictionCount: 0,
          });
          await seedAtsWebEvidenceRecord(c, {
            id: ATSW_DOSSIER_EVIDENCE_ID,
            subjectId: ATSW_DOSSIER_SUBJECT_ID,
            assertionType: 'EMPLOYMENT',
            dimension: 'CLAIMS',
            assertionPayload: { employer_norm: 'acme', start_date: '2020-01-01', end_date: '2021-01-01' },
          });
          await seedAtsWebEvidenceEvent(c, {
            id: ATSW_DOSSIER_EVENT_ID,
            evidenceId: ATSW_DOSSIER_EVIDENCE_ID,
            eventType: 'CREATED',
          });
        });
      },

      // -- TR-14 B2 dossier: a record with NO subject (the honest add-talent edge).
      // The dossier head returns the uniform ledger_established:false shape.
      'a talent record with no evidence ledger exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
        });
      },

      // -- TR-14 B2 resolve (the deferred TR-4 interaction): a subject with a
      // standing CONTRADICTED evidence row — POST .../resolve flips it to VALID.
      'a talent record with a standing contradiction exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_CONTRA_SUBJECT_ID });
          await seedAtsWebResolutionSubjectRef(c, {
            id: ATSW_CONTRA_REF_ID,
            subjectId: ATSW_CONTRA_SUBJECT_ID,
            refType: 'ATS_TALENT_RECORD',
            refId: ATSW_CONTRA_RECORD_ID,
          });
          await seedAtsWebEvidenceRecord(c, {
            id: ATSW_CONTRA_EVIDENCE_ID,
            subjectId: ATSW_CONTRA_SUBJECT_ID,
            assertionType: 'EMPLOYMENT',
            dimension: 'CLAIMS',
            currentStatus: 'CONTRADICTED',
            assertionPayload: { employer_norm: 'acme' },
          });
        });
      },

      // -- TR-12 B2: an OPEN trust proposal (list / dismiss / mark-acted happy).
      // Subject + ATS_TALENT_RECORD ref (so the list enriches the record pointer)
      // + a RESOLVE_CONTRADICTION proposal in OPEN. The value never seeds a wire
      // field — record_id/basis_kinds only.
      'an open trust proposal exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_PROP_SUBJECT_ID });
          await seedAtsWebResolutionSubjectRef(c, {
            id: ATSW_PROP_REF_ID,
            subjectId: ATSW_PROP_SUBJECT_ID,
            refType: 'ATS_TALENT_RECORD',
            refId: ATSW_PROP_RECORD_ID,
          });
          await seedAtsWebVerificationProposal(c, {
            id: ATSW_PROP_OPEN_ID,
            subjectId: ATSW_PROP_SUBJECT_ID,
            status: 'OPEN',
          });
        });
      },

      // -- TR-12 B2: a TERMINAL (DISMISSED) trust proposal — the OPEN-only guard
      // refuses dismiss/act with PROPOSAL_NOT_OPEN 409.
      'a terminal trust proposal exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_PROP_SUBJECT_ID });
          await seedAtsWebResolutionSubjectRef(c, {
            id: ATSW_PROP_REF_ID,
            subjectId: ATSW_PROP_SUBJECT_ID,
            refType: 'ATS_TALENT_RECORD',
            refId: ATSW_PROP_RECORD_ID,
          });
          await seedAtsWebVerificationProposal(c, {
            id: ATSW_PROP_TERMINAL_ID,
            subjectId: ATSW_PROP_SUBJECT_ID,
            status: 'DISMISSED',
          });
        });
      },

      // -- promote fresh-mint: sourced ACTIVE subject + SOURCED ref + VALID
      // FULL_NAME evidence + the L1 arrival (talent_direct = consent source);
      // no ATS ref, no PENDING advisory -> promoteSubject returns 'promoted'.
      'an ats-web recruiter and a promotable sourced subject exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_MINT_SUBJECT_ID });
          await seedAtsWebResolutionSubjectRef(c, {
            id: '00000000-0000-7000-8000-50c000000002',
            subjectId: ATSW_MINT_SUBJECT_ID,
            refType: 'SOURCED_TALENT',
            refId: ATSW_MINT_ARRIVAL_ID,
          });
          await seedAtsWebEvidenceRecord(c, {
            id: '00000000-0000-7000-8000-e00000000003',
            subjectId: ATSW_MINT_SUBJECT_ID,
            assertionType: 'FULL_NAME',
            assertionPayload: { first_name: 'Grace', last_name: 'Hopper' },
          });
          await seedAtsWebRawPayloadReference(c, {
            id: ATSW_MINT_ARRIVAL_ID,
            source: 'talent_direct',
          });
        });
      },

      // -- promote already_promoted: sourced subject that already carries an
      // ATS_TALENT_RECORD ref -> step-2 returns 'already_promoted'.
      'an ats-web recruiter and an already-promoted sourced subject exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebResolutionSubject(c, { id: ATSW_PROMOTED_SUBJECT_ID });
            await seedAtsWebResolutionSubjectRef(c, {
              id: '00000000-0000-7000-8000-50c000000003',
              subjectId: ATSW_PROMOTED_SUBJECT_ID,
              refType: 'SOURCED_TALENT',
              refId: ATSW_PROMOTED_ARRIVAL_ID,
            });
            await seedAtsWebResolutionSubjectRef(c, {
              id: '00000000-0000-7000-8000-50c000000004',
              subjectId: ATSW_PROMOTED_SUBJECT_ID,
              refType: 'ATS_TALENT_RECORD',
              refId: ATSW_PROMOTED_TALENT_ID,
            });
            await seedAtsWebTalentRecord(c, {
              id: ATSW_PROMOTED_TALENT_ID,
              firstName: 'Grace',
              lastName: 'Hopper',
            });
          });
        },

      // -- promote advisory-gate defer: sourced subject with a PENDING advisory
      // -> step-2.5 returns 'deferred_unresolved_identity' (200).
      'an ats-web recruiter and a sourced subject with a pending identity advisory exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebResolutionSubject(c, { id: ATSW_DEFER_SUBJECT_ID });
            await seedAtsWebResolutionSubject(c, { id: ATSW_DEFER_SUBJECT_B_ID });
            await seedAtsWebResolutionSubjectRef(c, {
              id: '00000000-0000-7000-8000-50c000000005',
              subjectId: ATSW_DEFER_SUBJECT_ID,
              refType: 'SOURCED_TALENT',
              refId: ATSW_DEFER_ARRIVAL_ID,
            });
            await seedAtsWebSubjectMatchAdvisory(c, {
              id: ATSW_DEFER_ADVISORY_ID,
              subjectA: ATSW_DEFER_SUBJECT_ID,
              subjectB: ATSW_DEFER_SUBJECT_B_ID,
              adviseBand: 'ADVISE_STRONG',
              status: 'PENDING_REVIEW',
            });
          });
        },

      // -- advisory approve-happy / dismiss-happy / reverse-not-MERGED-409: a
      // PENDING advisory (no contradiction) over two ACTIVE subjects.
      'an ats-web recruiter and a pending advisory without contradiction exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebResolutionSubject(c, { id: ATSW_ADV_SUBJECT_A_ID });
            await seedAtsWebResolutionSubject(c, { id: ATSW_ADV_SUBJECT_B_ID });
            await seedAtsWebSubjectMatchAdvisory(c, {
              id: ATSW_ADV_PENDING_ID,
              subjectA: ATSW_ADV_SUBJECT_A_ID,
              subjectB: ATSW_ADV_SUBJECT_B_ID,
              adviseBand: 'ADVISE_STRONG',
              status: 'PENDING_REVIEW',
            });
          });
        },

      // -- advisory reverse-happy / reversal_justification-400 / approve-
      // already-resolved-409: a MERGED advisory (subject_b merged into a).
      'an ats-web recruiter and a merged advisory exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebResolutionSubject(c, { id: ATSW_ADV_SUBJECT_A_ID });
          await seedAtsWebResolutionSubject(c, {
            id: ATSW_ADV_SUBJECT_B_ID,
            status: 'MERGED',
            mergedIntoSubjectId: ATSW_ADV_SUBJECT_A_ID,
          });
          await seedAtsWebSubjectMatchAdvisory(c, {
            id: ATSW_ADV_MERGED_ID,
            subjectA: ATSW_ADV_SUBJECT_A_ID,
            subjectB: ATSW_ADV_SUBJECT_B_ID,
            adviseBand: 'ADVISE_STRONG',
            status: 'MERGED',
            survivingSubjectId: ATSW_ADV_SUBJECT_A_ID,
            mergedSubjectId: ATSW_ADV_SUBJECT_B_ID,
          });
        });
      },

      // -- advisory approve-contradiction-400: a PENDING advisory with
      // has_contradiction=true -> approve without override 400.
      'an ats-web recruiter and a pending advisory with a contradiction exist':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedAtsWebResolutionSubject(c, { id: ATSW_ADV_SUBJECT_A_ID });
            await seedAtsWebResolutionSubject(c, { id: ATSW_ADV_SUBJECT_B_ID });
            await seedAtsWebSubjectMatchAdvisory(c, {
              id: ATSW_ADV_CONTRADICTION_ID,
              subjectA: ATSW_ADV_SUBJECT_A_ID,
              subjectB: ATSW_ADV_SUBJECT_B_ID,
              adviseBand: 'ADVISE_STRONG',
              status: 'PENDING_REVIEW',
              hasContradiction: true,
            });
          });
        },

      // ===============================================================
      // PC-6 — mock-infra (resume + ai-draft). Backends mocked; no seed for
      // the mocked-only paths; profile/draft needs a visible requisition.
      // ===============================================================
      'an ats-web recruiter can start a resume flow': async () => {
        await withClient((c) => resetAllRows(c));
      },
      'an ats-web recruiter can draft a requisition from intake': async () => {
        await withClient((c) => resetAllRows(c));
      },
      'an ats-web recruiter and a requisition for drafting exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebRequisition(c, {
            id: ATSW_REQ_ID,
            title: 'Senior Engineer',
            companyId: ATSW_REQ_COMPANY_ID,
          });
        });
      },

      // ===============================================================
      // PC-7b — settings surface (tenant settings/profile/roles/audit/
      // domain/sites). @RequireCapability('core') + tenant:admin:* scopes.
      // ===============================================================
      'an ats-web admin and a tenant exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
        });
      },
      'an ats-web admin and tenant settings exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebTenantSetting(c, {
            key: 'compensation.display_default',
            value: 'both',
          });
          await seedAtsWebTenantSetting(c, {
            key: 'audit.financials_enabled',
            value: true,
          });
        });
      },
      'an ats-web admin and an allowed domain exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c, { allowedDomain: 'astre.example' });
        });
      },
      'an ats-web admin and audit events exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebIdentityAuditEvent(c, {
            id: '00000000-0000-7000-8000-a0d100000001',
            eventType: 'tenant.setting.updated',
            subjectId: '00000000-0000-7000-8000-000000000abc',
            createdAt: '2026-05-01T00:00:00.000Z',
          });
          await seedAtsWebIdentityAuditEvent(c, {
            id: '00000000-0000-7000-8000-a0d100000002',
            eventType: 'tenant.site.created',
            subjectId: ATSW_SITE_ID,
            createdAt: '2026-05-02T00:00:00.000Z',
          });
        });
      },
      'an ats-web admin and a site exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebSite(c, { id: ATSW_SITE_ID, name: 'Headquarters' });
        });
      },
      'an ats-web admin and an inactive site exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebSite(c, {
            id: ATSW_SITE_INACTIVE_ID,
            name: 'Closed Office',
            isActive: false,
          });
        });
      },
      'an ats-web admin and a site with a child exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebSite(c, { id: ATSW_SITE_ID, name: 'Headquarters' });
          await seedAtsWebSite(c, {
            id: ATSW_SITE_CHILD_ID,
            name: 'West Wing',
            parentSiteId: ATSW_SITE_ID,
          });
        });
      },

      // ===============================================================
      // PC-7c — identity-admin (tenant-users / teams / management-edges).
      // ===============================================================
      'an ats-web admin and a tenant user with a role exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebMembership(c, { id: ATSW_MEMBERSHIP_ID, userId: ATSW_USER_A });
          await seedAtsWebRole(c, { id: ATSW_ROLE_ID, key: 'recruiter' });
          await seedAtsWebMembershipRole(c, {
            id: '00000000-0000-7000-8000-401e0000000a',
            membershipId: ATSW_MEMBERSHIP_ID,
            roleId: ATSW_ROLE_ID,
          });
        });
      },
      'an ats-web admin can invite a tenant user': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebRole(c, { id: ATSW_ROLE_ID, key: 'recruiter' });
        });
      },
      'an ats-web admin and an inactive tenant user exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebMembership(c, { id: ATSW_MEMBERSHIP_ID, userId: ATSW_USER_A, isActive: false });
        });
      },
      'an ats-web admin and a pending-invite tenant user exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebMembership(c, {
            id: ATSW_MEMBERSHIP_ID,
            userId: ATSW_USER_A,
            isActive: true,
            inviteStatus: 'INVITED',
          });
          await seedAtsWebInvitation(c, {
            id: '00000000-0000-7000-8000-19f100000001',
            userId: ATSW_USER_A,
            membershipId: ATSW_MEMBERSHIP_ID,
            tokenHash: 'pact-invite-token-hash-pending',
          });
        });
      },
      'an ats-web admin and a failed-invite tenant user exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebMembership(c, {
            id: ATSW_MEMBERSHIP_ID,
            userId: ATSW_USER_A,
            isActive: true,
            inviteStatus: 'FAILED',
          });
          await seedAtsWebInvitation(c, {
            id: '00000000-0000-7000-8000-19f100000002',
            userId: ATSW_USER_A,
            membershipId: ATSW_MEMBERSHIP_ID,
            tokenHash: 'pact-invite-token-hash-failed',
          });
        });
      },
      'an ats-web admin and two users exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebUser(c, { id: ATSW_USER_B, email: 'grace@astre.example', displayName: 'Grace Hopper' });
        });
      },
      'an ats-web admin and a management edge exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebUser(c, { id: ATSW_USER_B, email: 'grace@astre.example', displayName: 'Grace Hopper' });
          await seedAtsWebManagementEdge(c, { id: ATSW_EDGE_ID, managerUserId: ATSW_USER_A, reportUserId: ATSW_USER_B });
        });
      },
      'an ats-web admin and a team exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebUser(c, { id: ATSW_USER_B, email: 'grace@astre.example', displayName: 'Grace Hopper' });
          await seedAtsWebIdentityTeam(c, { id: ATSW_ITEAM_ID, name: 'Alpha Pod', ownerUserId: ATSW_USER_A });
        });
      },
      'an ats-web admin and a team with a member exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'ada@astre.example', displayName: 'Ada Lovelace' });
          await seedAtsWebUser(c, { id: ATSW_USER_B, email: 'grace@astre.example', displayName: 'Grace Hopper' });
          await seedAtsWebIdentityTeam(c, { id: ATSW_ITEAM_ID, name: 'Alpha Pod', ownerUserId: ATSW_USER_A });
          await seedAtsWebTeamMembership(c, { id: ATSW_TMEMBER_ID, teamId: ATSW_ITEAM_ID, userId: ATSW_USER_B });
        });
      },

      // ===============================================================
      // PC-7d — reporting + me + export + import + public invitation-accept.
      // Reporting/export/import: @RequireCapability('ats') + report/dashboard/
      // export/import:read (+ RequireSiteMatch). /me: @RequireCapability('core'),
      // no scope. POST /v1/invitations/accept: PUBLIC (no guard).
      // ===============================================================

      // Reporting reads: one tenant + a company (→ one company-metrics row +
      // non-zero dashboard tenant_counts) + a talent. recruiter-metrics always
      // returns its 4 fixed keys; company-placements has no placement → empty.
      'an ats-web recruiter and tenant reporting data exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebCompany(c, { id: ATSW_COMPANY_ID, name: 'Acme Corp' });
          await seedAtsWebTalentRecord(c, {
            id: ATSW_TALENT_ID,
            firstName: 'Ada',
            lastName: 'Lovelace',
            tenantStatus: 'active',
            sourceChannel: 'recruiter_added',
          });
        });
      },

      // /me — the authenticated recruiter (sub = RECRUITER_ID) resolves via
      // UserTenantMembership(user_id, tenant_id) → user + active roles + tenant.
      'an ats-web user with a membership and a role exist': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, {
            id: RECRUITER_ID,
            email: 'recruiter@astre.example',
            displayName: 'Rita Recruiter',
          });
          await seedAtsWebMembership(c, {
            id: '00000000-0000-7000-8000-33b0000000bb',
            userId: RECRUITER_ID,
            isActive: true,
            inviteStatus: 'ACTIVE',
          });
          await seedAtsWebRole(c, { id: ATSW_ROLE_ID, key: 'recruiter' });
          await seedAtsWebMembershipRole(c, {
            id: '00000000-0000-7000-8000-4a0000000bb1',
            membershipId: '00000000-0000-7000-8000-33b0000000bb',
            roleId: ATSW_ROLE_ID,
          });
        });
      },

      // Export — text/csv of the talent_record entity. One seeded row → a
      // header + at least one data line (the pin matches the envelope, not rows).
      'an ats-web talent record exists for export': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebTalentRecord(c, {
            id: ATSW_TALENT_ID,
            firstName: 'Ada',
            lastName: 'Lovelace',
            tenantStatus: 'active',
            sourceChannel: 'recruiter_added',
          });
        });
      },

      // Import — a committed batch (GET /v1/imports list read).
      'an ats-web import batch exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebImportBatch(c, {
            id: ATSW_IMPORT_BATCH_ID,
            importedById: RECRUITER_ID,
            targetEntity: 'talent_record',
            sourceFilename: 'talent-2026-05.csv',
            rowCount: 3,
            successCount: 2,
            failureCount: 1,
            status: 'partially_committed',
          });
        });
      },

      // Import failures — a batch with one row-level failure.
      'an ats-web import batch with a failure exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebImportBatch(c, {
            id: ATSW_IMPORT_BATCH_ID,
            importedById: RECRUITER_ID,
            targetEntity: 'talent_record',
            sourceFilename: 'talent-2026-05.csv',
            rowCount: 3,
            successCount: 2,
            failureCount: 1,
            status: 'partially_committed',
          });
          await seedAtsWebImportFailure(c, {
            id: '00000000-0000-7000-8000-1fa100000001',
            importBatchId: ATSW_IMPORT_BATCH_ID,
            rowNumber: 2,
            failureReason: 'invalid email',
            offendingFields: ['email'],
            originalRowData: { first_name: 'No', last_name: 'Email', email: 'not-an-email' },
          });
        });
      },

      // Invitation-accept happy — a pending INVITED membership + an unconsumed
      // invitation whose token_hash = sha256(the consumer's raw token).base64url.
      'an ats-web pending invitation with a known token exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'newhire@astre.example', displayName: 'New Hire' });
          await seedAtsWebMembership(c, {
            id: ATSW_MEMBERSHIP_ID,
            userId: ATSW_USER_A,
            isActive: true,
            inviteStatus: 'INVITED',
          });
          const { createHash } =
            require('node:crypto') as typeof import('node:crypto');
          await seedAtsWebInvitation(c, {
            id: '00000000-0000-7000-8000-19f100000010',
            userId: ATSW_USER_A,
            membershipId: ATSW_MEMBERSHIP_ID,
            tokenHash: createHash('sha256').update('pact-accept-raw-token').digest('base64url'),
          });
        });
      },

      // Invitation-accept invalid — an empty Invitation table: any token misses
      // the hash lookup → 400 VALIDATION_ERROR details.reason = 'invalid_token'.
      'no ats-web invitation matches the token': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
        });
      },

      // Invitation-accept expired — an unconsumed invitation past expires_at →
      // 400 VALIDATION_ERROR details.reason = 'expired'.
      'an ats-web expired invitation with a known token exists': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAtsWebTenant(c);
          await seedAtsWebUser(c, { id: ATSW_USER_A, email: 'newhire@astre.example', displayName: 'New Hire' });
          await seedAtsWebMembership(c, {
            id: ATSW_MEMBERSHIP_ID,
            userId: ATSW_USER_A,
            isActive: true,
            inviteStatus: 'INVITED',
          });
          const { createHash } =
            require('node:crypto') as typeof import('node:crypto');
          await seedAtsWebInvitation(c, {
            id: '00000000-0000-7000-8000-19f100000011',
            userId: ATSW_USER_A,
            membershipId: ATSW_MEMBERSHIP_ID,
            tokenHash: createHash('sha256').update('pact-expired-raw-token').digest('base64url'),
            expired: true,
          });
        });
      },
    };

    // Request filter — rewrites the literal fake credentials the
    // consumer pacts ship into the real signed JWT, then forwards.
    //
    //   - ats-web ships `Cookie: aramo_access_token=eyJfake.access.token`
    //     → rewrite the cookie value to the production-issuer JWT.
    //   - the retired thin consumer shipped `Authorization: Bearer
    //     eyJfake.token` → rewrite to `Bearer <real JWT>`; the literal
    //     `Bearer not-a-jwt` (the 401-INVALID_TOKEN interaction) was
    //     intentionally bypassed so JwtAuthGuard rejects it. Both
    //     branches are now unexercised.
    //   - interactions that ship NO Cookie header (the PUBLIC
    //     invitation-accept + email-verification confirms) — the cookie
    //     branch is conditional on the literal substring, so it's a
    //     no-op for those.
    function requestFilter(
      req: { headers: Record<string, string | string[] | undefined> },
      _res: unknown,
      next: () => void,
    ): void {
      const cookieHeader = req.headers['cookie'] ?? req.headers['Cookie'];
      if (
        typeof cookieHeader === 'string' &&
        cookieHeader.includes('aramo_access_token=')
      ) {
        req.headers['cookie'] = `aramo_access_token=${accessJwt}`;
      }
      const authHeader =
        req.headers['authorization'] ?? req.headers['Authorization'];
      if (
        typeof authHeader === 'string' &&
        authHeader === 'Bearer eyJfake.token'
      ) {
        req.headers['authorization'] = `Bearer ${accessJwt}`;
      } else if (
        typeof authHeader === 'string' &&
        authHeader === 'Bearer eyJfake.portal.token'
      ) {
        // M3 PR-8 §4.7 — the match-list 403 interaction ships a literal
        // portal-consumer fake token. Rewrite to a real JWT signed with
        // consumer_type='portal' so JwtAuthGuard accepts the token and the
        // controller's per-route check returns 403 INSUFFICIENT_PERMISSIONS.
        // M3 PR-9 §4.8 — also used for portal-thin happy-path interactions
        // (the controller derives talent_id from portal JWT's sub).
        req.headers['authorization'] = `Bearer ${portalJwt}`;
      } else if (
        typeof authHeader === 'string' &&
        authHeader === 'Bearer eyJfake.recruiter.token'
      ) {
        // M3 PR-9 §4.8 — portal-thin 403 interaction (recruiter token
        // hitting /v1/portal/profile). Same rewrite target as
        // 'Bearer eyJfake.token' (the canonical recruiter JWT). The
        // retired thin-consumer interactions used 'Bearer eyJfake.token'
        // via the first branch, which is now unexercised.
        req.headers['authorization'] = `Bearer ${accessJwt}`;
      } else if (
        typeof authHeader === 'string' &&
        authHeader === 'Bearer eyJfake.ingestion.token'
      ) {
        // M3 PR-9 §4.8 — portal-thin 403 interaction (ingestion token
        // hitting /v1/portal/consent).
        req.headers['authorization'] = `Bearer ${ingestionJwt}`;
      }
      next();
    }

    it(
      'verifies all interactions from the 4 aramo-core pacts',
      async () => {
        const verifier = new Verifier({
          providerBaseUrl: `http://127.0.0.1:${port}`,
          pactUrls: [
            INGESTION_PACT,
            PROHIBITED_PACT,
            PORTAL_THIN_PACT,
            ATS_WEB_PACT,
          ],
          stateHandlers,
          requestFilter: requestFilter as never,
          // M4 PR-5 §4.10 + M4 PR-7 §4.9 — composed state-isolation
          // invariant check. Runs after every interaction:
          //   1. checkOverrideStateIsolation — for any examination_id
          //      whose pre-execution hash was captured at state-handler
          //      setup time, re-read + assert byte-identity. Mismatches
          //      collected as overrideStateIsolation.violations.
          //   2. checkEvidencePackageStateIsolation — same pattern for
          //      TalentJobEvidencePackage rows seeded by the submittal-
          //      revoke state handlers (Ruling 6 refined: applies to
          //      all 4 PR-7 interactions, success + 3 refusals).
          // The composed wrapper runs both checks sequentially so a
          // single afterEach hook covers both collections.
          afterEach: async () => {
            await checkOverrideStateIsolation();
            await checkEvidencePackageStateIsolation();
          },
          logLevel: 'warn',
        });
        await verifier.verifyProvider();
        // After all interactions verify, neither state-isolation
        // collection may carry a violation. These assertions fail the
        // Pact verification explicitly on any override-induced
        // TalentJobExamination mutation OR any revoke-induced
        // TalentJobEvidencePackage mutation.
        if (overrideStateIsolation.violations.length > 0) {
          throw new Error(overrideStateIsolation.violations.join('\n'));
        }
        if (evidencePackageStateIsolation.violations.length > 0) {
          throw new Error(evidencePackageStateIsolation.violations.join('\n'));
        }
      },
      600_000,
    );
  },
);
