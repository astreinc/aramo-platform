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
//   - PR-15 §4.2 (F10): tenant-console-consumer (5 consent interactions)
//   - (retired) the thin recruiter consumer formerly contributed 23
//     consent + 4 match-list interactions plus the engagement / submittal
//     / examination / outreach surface. Its pact was removed in the
//     Architecture-Realignment thin-consumer retirement; the state
//     handlers it drove remain below as now-unexercised dead code
//     (pact-js never invokes a handler whose pact is unloaded). Pruning
//     them is a follow-up.
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
//   - tenant-console-consumer pacts ship Cookie: aramo_access_token=
//     eyJfake.access.token — rewritten to the real JWT cookie.
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
const INGESTION_PACT = resolve(
  ROOT,
  'pact/pacts/ingestion-consumer-aramo-core.json',
);
const PROHIBITED_PACT = resolve(
  ROOT,
  'pact/pacts/prohibited-source-type-aramo-core.json',
);
const TENANT_CONSOLE_PACT = resolve(
  ROOT,
  'pact/pacts/tenant-console-consumer-aramo-core.json',
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

// Constants used by the tenant-console pacts (and formerly the retired
// thin consumer). The talent uuid matches the value the consumer tests
// use; the recruiter actor uuid matches the audit-row value the pacts
// assert with a regex matcher.
const PACT_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PACT_RECRUITER_ACTOR_ID = '00000000-0000-7000-8000-000000000bb1';

// Cursor anchor used by the regenerated tenant-console-consumer pact #3
// (PR-15 §4.1). c is the keyset's
// created_at edge; e is the keyset's event_id. Page-2 seeded rows must
// have created_at strictly older than CURSOR_C so the predicate
// (created_at, id) < (CURSOR_C, CURSOR_E) returns them.
const CURSOR_C = '2026-04-15T12:00:00.000Z';
const CURSOR_E = '00000000-0000-7000-8000-000000000a01';

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
      await c.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, created_at, updated_at)
         VALUES ($1,$2,'Pact','Talent',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        [PACT_TALENT_ID, TENANT_ID],
      );
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
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO engagement."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id,
            pinned_examination_id, state, created_by,
            justification, failed_criterion_acknowledgments)
         VALUES ($1,$2,$3,$4,$5,$6,$7::engagement."SubmittalState",$8,$9,$10::jsonb)`,
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
      await seedAtsWebSubmittal(c, {
        submittalId: params.submittalId,
        evidencePackageId: ATSW_SUB_EVIDENCE_ID,
        examinationId: ATSW_SUB_EXAM_ID,
        state: params.state,
        justification: params.justification ?? null,
      });
    }

    // M3 PR-8 §4.7 — seed the active Requisition + N ranked Summary
    // examinations that the match-list state handlers describe. Mirrors
    // the live-list integration spec's seeding pattern (raw SQL because
    // the verifier harness uses node-postgres directly, not the
    // ExaminationRepository surface).
    async function seedMatchListFixture(
      c: Client,
      opts: { jobId: string; reqId: string; examIds: readonly string[] },
    ): Promise<void> {
      await c.query(
        `INSERT INTO job_domain."Requisition"
           (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [opts.reqId, TENANT_ID, opts.jobId, RECRUITER_ID],
      );
      const goldenId = '11111111-0000-7000-8000-0000000000aa';
      const tiers = ['ENTRUSTABLE', 'WORTH_CONSIDERING', 'STRETCH'] as const;
      for (let i = 0; i < opts.examIds.length; i++) {
        const tier = tiers[i] ?? 'STRETCH';
        const exam = opts.examIds[i];
        if (exam === undefined) continue;
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
            exam,
            TENANT_ID,
            'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
            opts.jobId,
            goldenId,
            tier,
            i + 1,
            'matched on skills X and Y',
            'baseline match',
            JSON.stringify([]),
            JSON.stringify({
              matched_count: 1,
              missing_count: 0,
              per_skill: [
                { name: 'TypeScript', evidence_count: 1, has_ingested_evidence: true },
              ],
            }),
            JSON.stringify({}),
            JSON.stringify({}),
            JSON.stringify(['baseline']),
            JSON.stringify([]),
            JSON.stringify([]),
            JSON.stringify({
              evidence_strength: { level: 'medium', basis: 'evidence_count' },
              data_completeness: { level: 'high', basis: 'fields_present' },
              constraint_confidence: { level: 'medium', basis: 'rate_overlap' },
            }),
            JSON.stringify({ profile_age_days: 14 }),
            JSON.stringify(null),
            'v1',
            'v1',
            'v1',
            '2026-05-01T12:00:00.000Z',
          ],
        );
      }
    }

    // M4 PR-3 §4.8 — seed the substrate the submittal-create pact
    // interactions rely on. The submittal create endpoint reads the
    // referenced examination (via PR-2's EvidenceRepository.buildPackage
    // path) and refuses Stretch tier with 422 SUBMITTAL_STRETCH_BLOCKED.
    // The helper seeds one TalentJobExamination with the tier the test
    // requires; the controller then writes its own evidence package +
    // submittal record at request time.
    //
    // M4 PR-4 §4.9 — extended with two optional knobs the submittal-
    // confirm interactions need:
    //   - precreateDraftSubmittal: when true, after seeding the
    //     examination, INSERT a TalentSubmittalRecord row in 'draft'
    //     pinned to the seeded examination (plus a minimal evidence
    //     package row for FK-style referential parity).
    //   - seedNewerExamination: when true, also INSERT a second
    //     TalentJobExamination for the same (tenant, talent, job) with a
    //     later computed_at — the "newer" snapshot the confirm flow
    //     compares the pin against.
    async function seedSubmittalFixture(
      c: Client,
      opts: {
        examinationId: string;
        talentId: string;
        jobId: string;
        tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
        precreateDraftSubmittal?: {
          submittalId: string;
          evidencePackageId: string;
          justification?: string | null;
          failed_criterion_acknowledgments?: ReadonlyArray<Record<string, unknown>>;
        };
        seedNewerExamination?: {
          examinationId: string;
          tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
        };
      },
    ): Promise<void> {
      const goldenId = '22221111-0000-7000-8000-0000000000aa';
      // Seed the active Requisition so any code path that resolves
      // (tenant, job) → requisition (post-PR-7 / PR-8 pattern) succeeds.
      const reqId = '22222222-0000-7000-8000-0000000000aa';
      await c.query(
        `INSERT INTO job_domain."Requisition"
           (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")
         ON CONFLICT DO NOTHING`,
        [reqId, TENANT_ID, opts.jobId, RECRUITER_ID],
      );
      // Seed the examination at the requested tier; lifecycle='active'
      // so the builder's lifecycle cross-check passes.
      await insertExaminationRow(c, {
        id: opts.examinationId,
        talentId: opts.talentId,
        jobId: opts.jobId,
        goldenId,
        tier: opts.tier,
        computedAt: '2026-05-22T09:00:00.000Z',
      });

      // M4 PR-4 §4.9 — optional newer examination (same triple, later
      // computed_at). The confirm flow's findLatestByTenantTalentJob
      // returns this row; comparing against the pinned id mismatches and
      // raises EXAMINATION_PINNED_OUTDATED 409.
      if (opts.seedNewerExamination !== undefined) {
        await insertExaminationRow(c, {
          id: opts.seedNewerExamination.examinationId,
          talentId: opts.talentId,
          jobId: opts.jobId,
          goldenId,
          tier: opts.seedNewerExamination.tier,
          computedAt: '2026-05-23T09:00:00.000Z',
        });
      }

      // M4 PR-4 §4.9 — optional pre-created draft submittal so the
      // confirm endpoint has a row to load by id. Mirrors what
      // SubmittalRepository.createSubmittal would write, minus the
      // orchestration: a minimal TalentJobEvidencePackage row (FK-style
      // referential parity) and a TalentSubmittalRecord in 'draft' state
      // pinned to the seeded examination.
      if (opts.precreateDraftSubmittal !== undefined) {
        // Package insert includes submittal_record_id back-link so the
        // PR-6 get-evidence-package interaction observes the linked
        // submittal at the response surface. The package row is
        // immutable post-INSERT (whole-row UPDATE-rejection trigger),
        // so the back-link must be set here. Pre-PR-6 callers
        // (submittal-confirm, override-create pacts) don't observe
        // this column at their response surfaces — back-fill is
        // harmless.
        await c.query(
          `INSERT INTO evidence."TalentJobEvidencePackage"
             (id, tenant_id, talent_id, job_id, examination_id,
              submittal_record_id,
              talent_identity, contact_summary, capability_summary,
              match_justification, recruiter_contribution,
              engagement_event_refs)
           VALUES ($1,$2,$3,$4,$5,$12,
                   $6::jsonb,$7::jsonb,$8::jsonb,
                   $9::jsonb,$10::jsonb,$11::jsonb)`,
          [
            opts.precreateDraftSubmittal.evidencePackageId,
            TENANT_ID,
            opts.talentId,
            opts.jobId,
            opts.examinationId,
            JSON.stringify({
              full_name: 'Pact Talent',
              location: 'Remote (US)',
            }),
            JSON.stringify({
              contact_available: true,
              channels_verified: ['email'],
            }),
            JSON.stringify({
              key_work_history: [
                {
                  employer_name: 'Acme',
                  role_title: 'Senior Engineer',
                },
              ],
            }),
            JSON.stringify({
              why_this_talent: 'Pact-seeded sample.',
            }),
            JSON.stringify({
              conversation_summary: {
                recruiter_summary: 'Discussed.',
              },
              talent_confirmed: { spoken_to_recruiter: true },
            }),
            JSON.stringify([]),
            opts.precreateDraftSubmittal.submittalId,
          ],
        );
        const fca = opts.precreateDraftSubmittal.failed_criterion_acknowledgments;
        await c.query(
          `INSERT INTO engagement."TalentSubmittalRecord"
             (id, tenant_id, talent_id, job_id, evidence_package_id,
              pinned_examination_id, state, created_by,
              justification, failed_criterion_acknowledgments)
           VALUES ($1,$2,$3,$4,$5,$6,'created'::engagement."SubmittalState",$7,
                   $8, $9::jsonb)`,
          [
            opts.precreateDraftSubmittal.submittalId,
            TENANT_ID,
            opts.talentId,
            opts.jobId,
            opts.precreateDraftSubmittal.evidencePackageId,
            opts.examinationId,
            RECRUITER_ID,
            opts.precreateDraftSubmittal.justification ?? null,
            fca === undefined ? null : JSON.stringify(fca),
          ],
        );
      }
    }

    // M4 PR-6 §4.6 — seed helper for GET /v1/submittals/{id}. Seeds a
    // full chain (Requisition + Examination + Evidence Package +
    // Submittal Record) when params.submittalExists=true, so the
    // controller's findById succeeds. When false, only the upstream
    // (Requisition + Examination) are seeded so that the route
    // legitimately returns NOT_FOUND.
    async function seedSubmittalForGetFixture(
      c: Client,
      params: { submittalExists: boolean },
    ): Promise<{ submittal_id: string; tenant_id: string }> {
      const submittalId = '99990000-0000-7000-8000-000000000906';
      const evidencePackageId = '99990000-0000-7000-8000-0000000010a6';
      const examinationId = '11110000-0000-7000-8000-0000000e0006';
      const talentId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      const jobId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
      if (params.submittalExists) {
        await seedSubmittalFixture(c, {
          examinationId,
          talentId,
          jobId,
          tier: 'ENTRUSTABLE',
          precreateDraftSubmittal: {
            submittalId,
            evidencePackageId,
          },
        });
      } else {
        // No-op: route legitimately returns NOT_FOUND.
      }
      return { submittal_id: submittalId, tenant_id: TENANT_ID };
    }

    // M4 PR-6 §4.6 — seed helper for GET /v1/submittals/{id}/evidence-
    // package. Supports both branches (success + chain-break) plus the
    // missing-submittal NOT_FOUND branch. The evidencePackageExists flag
    // is reserved for a future chain-break interaction; PR-6 only ships
    // the success + missing-submittal pair (§4.5 directive scope).
    async function seedSubmittalForEvidencePackageFixture(
      c: Client,
      params: {
        submittalExists: boolean;
        evidencePackageExists: boolean;
      },
    ): Promise<{
      submittal_id: string;
      tenant_id: string;
      evidence_package_id?: string;
    }> {
      const submittalId = '99990000-0000-7000-8000-000000000907';
      const evidencePackageId = '99990000-0000-7000-8000-0000000010a7';
      const examinationId = '11110000-0000-7000-8000-0000000e0007';
      const talentId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      const jobId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
      if (params.submittalExists) {
        // seedSubmittalFixture sets package.submittal_record_id → submittal.id
        // at INSERT time (the package row is immutable post-INSERT per the
        // §4.2 trigger), so the bidirectional link is observable at the
        // get-evidence-package response surface without further work.
        await seedSubmittalFixture(c, {
          examinationId,
          talentId,
          jobId,
          tier: 'ENTRUSTABLE',
          precreateDraftSubmittal: {
            submittalId,
            evidencePackageId,
          },
        });
        if (!params.evidencePackageExists) {
          // Chain-break: delete the just-seeded evidence-package row so
          // the controller's second findById returns null → 404.
          await c.query(
            `DELETE FROM evidence."TalentJobEvidencePackage" WHERE id = $1`,
            [evidencePackageId],
          );
        }
        return {
          submittal_id: submittalId,
          tenant_id: TENANT_ID,
          evidence_package_id: evidencePackageId,
        };
      }
      // No-op: route legitimately returns NOT_FOUND on the first lookup.
      return { submittal_id: submittalId, tenant_id: TENANT_ID };
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

    async function seedSubmittalRevokeFixture(
      c: Client,
      params: {
        submittalExists: boolean;
        submittalState: 'created' | 'handoff_draft' | 'ready_for_review' | 'submitted_to_ats' | 'confirmed' | 'revoked';
        submittalId: string;
        evidencePackageId: string;
        examinationId: string;
        talentId: string;
        jobId: string;
      },
    ): Promise<{
      submittal_id: string;
      tenant_id: string;
      evidence_package_id: string;
      preExecutionEvidencePackageHash?: string;
    }> {
      const result: {
        submittal_id: string;
        tenant_id: string;
        evidence_package_id: string;
        preExecutionEvidencePackageHash?: string;
      } = {
        submittal_id: params.submittalId,
        tenant_id: TENANT_ID,
        evidence_package_id: params.evidencePackageId,
      };

      if (!params.submittalExists) {
        return result;
      }

      // Seed the chain (Requisition + Examination + Evidence Package +
      // Submittal Record at draft state) via seedSubmittalFixture so
      // the row identifiers + JSONB payloads match the PR-3 substrate.
      await seedSubmittalFixture(c, {
        examinationId: params.examinationId,
        talentId: params.talentId,
        jobId: params.jobId,
        tier: 'ENTRUSTABLE',
        precreateDraftSubmittal: {
          submittalId: params.submittalId,
          evidencePackageId: params.evidencePackageId,
        },
      });

      // Advance state per params.submittalState. The column-scoped
      // trigger (engagement.reject_submittal_record_update; rewritten
      // at M5 PR-8b2 to encode the canonical 5-state matrix)
      // validates each transition; the raw SQL writes go THROUGH the
      // trigger (only state + the named transition-companion columns
      // move). Seeds walk the canonical chain in order from the seed
      // baseline 'created':
      //   created -> handoff_draft -> ready_for_review ->
      //   submitted_to_ats (populates confirmed_at) -> confirmed
      // or sibling-revoke at any non-terminal step.
      //
      // M4 fixture migration (per directive §4.13): legacy params
      // value 'submitted' renames to canonical 'submitted_to_ats'
      // (M4's 'submitted' meant 'submitted to ATS'). 'revoked'
      // unchanged.
      const targetState = params.submittalState;
      const chainStates: ReadonlyArray<string> = [
        'handoff_draft',
        'ready_for_review',
        'submitted_to_ats',
        'confirmed',
      ];
      const chainIndex = chainStates.indexOf(targetState);
      // Walk mainline transitions in order. The confirmed_at stamp
      // populates at the ready_for_review -> submitted_to_ats step
      // per Ruling 6.
      if (chainIndex >= 0) {
        // Transition 1 — created -> handoff_draft.
        await c.query(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'handoff_draft'::engagement."SubmittalState"
           WHERE id = $1`,
          [params.submittalId],
        );
        if (chainIndex >= 1) {
          // Transition 2 — handoff_draft -> ready_for_review.
          await c.query(
            `UPDATE engagement."TalentSubmittalRecord"
               SET state = 'ready_for_review'::engagement."SubmittalState"
             WHERE id = $1`,
            [params.submittalId],
          );
        }
        if (chainIndex >= 2) {
          // Transition 3 — ready_for_review -> submitted_to_ats;
          // confirmed_at populates atomically (Ruling 6).
          await c.query(
            `UPDATE engagement."TalentSubmittalRecord"
               SET state = 'submitted_to_ats'::engagement."SubmittalState",
                   confirmed_at = '2026-05-22T13:00:00Z'::timestamptz
             WHERE id = $1`,
            [params.submittalId],
          );
        }
        if (chainIndex >= 3) {
          // Transition 4 — submitted_to_ats -> confirmed (terminal).
          await c.query(
            `UPDATE engagement."TalentSubmittalRecord"
               SET state = 'confirmed'::engagement."SubmittalState"
             WHERE id = $1`,
            [params.submittalId],
          );
        }
      }
      if (targetState === 'revoked') {
        // Sibling-revoke (Q3 + Ruling 5). The seed walks no mainline
        // first — the revoke fires directly from 'created' (a legal
        // sibling-revoke from-state). All three revoke columns
        // populate atomically; the trigger's sibling-revoke branch
        // validates the move.
        const revokerId = '00000000-0000-7000-8000-000000000bb2';
        await c.query(
          `UPDATE engagement."TalentSubmittalRecord"
             SET state = 'revoked'::engagement."SubmittalState",
                 revoked_at = '2026-05-23T15:00:00Z'::timestamptz,
                 revoked_by = $2::uuid,
                 revocation_justification = $3
           WHERE id = $1`,
          [
            params.submittalId,
            revokerId,
            'Seeded already-revoked fixture for submittal-revoke pact.',
          ],
        );
      }

      // Capture pre-execution evidence-package hash for state-isolation
      // verification. Ruling 6 (refined): applies to all 4 interactions
      // (success + refusal) so the byte-identity invariant is enforced
      // regardless of whether the route mutates state.
      const { rows } = await c.query(
        `SELECT * FROM evidence."TalentJobEvidencePackage" WHERE id = $1`,
        [params.evidencePackageId],
      );
      if (rows.length === 1) {
        const hash = hashRowAsJson(rows[0] as Record<string, unknown>);
        evidencePackageStateIsolation.preHashes.set(
          params.evidencePackageId,
          hash,
        );
        result.preExecutionEvidencePackageHash = hash;
      }
      return result;
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
        SETTINGS_INIT_MIGRATION,
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
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

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
      const mockDraftProvider = {
        generate: async (): Promise<{
          completion: string;
          model_used: string;
          input_tokens: number;
          output_tokens: number;
          provider_request_id: string;
        }> => ({
          completion: 'Mocked outreach draft for pact verification.',
          model_used: 'claude-sonnet-mock',
          input_tokens: 10,
          output_tokens: 20,
          provider_request_id: 'pact-mock-provider-request-id',
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

      module = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(PACT_DRAFT_PROVIDER_TOKEN)
        .useValue(mockDraftProvider)
        .overrideProvider(PACT_DELIVERY_PROVIDER_TOKEN)
        .useValue(mockDeliveryProvider)
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

    // State handlers for the 3 ingestion-pact + 5 tenant-console + 5
    // portal-thin interactions, plus the now-unexercised handlers the
    // retired thin recruiter consumer drove (kept as dead code; see the
    // file header). Each handler:
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

      // ===== PR-15 §4.2 tenant-console (5 interactions) =====
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
      'a recruiter session and a talent with consent history': async () => {
        // §4.2 #2 — seed 1 granted TalentConsentEvent. The pact response
        // shape is events:[1 element] with next_cursor=like(CURSOR). The
        // controller returns events:[1] with next_cursor=null when only
        // one row exists under the default limit.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a recruiter session and a talent with consent history (page 2 final)':
        async () => {
          // §4.2 #3 — seed 1 revoked TalentConsentEvent with created_at
          // strictly earlier than CURSOR_C, so the keyset predicate
          // (created_at, id) < (CURSOR_C, CURSOR_E) returns exactly this
          // row. With one row returned under default limit, hasMore=false
          // and next_cursor=null (matches the pact's exact-null assertion).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedConsentEvent(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
              scope: 'profile_storage',
              action: 'revoked',
              occurredAt: '2026-04-14T08:00:00.000Z',
              createdAt: '2026-04-14T08:00:00.000Z',
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
      'no setup required': async () => {
        // §4.2 #5 — no seed. The requestFilter intentionally does NOT
        // inject a cookie for this interaction (its request has no
        // Cookie header), so JwtAuthGuard returns INVALID_TOKEN 401.
        await withClient((c) => resetAllRows(c));
      },

      // ===== (retired) thin recruiter consumer — 18 unique state
      // handlers that formerly covered its 23 consent interactions
      // (duplicates of 'a valid recruiter token' / 'a talent with no
      // consent events' / 'no valid token' handled by a single entry
      // each). Now-unexercised dead code after its pact was removed;
      // retained pending a follow-up prune. =====

      // -- /v1/consent/check ----------------------------------------------
      'a talent with contacting consent older than 12 months': async () => {
        // §4.3 — seed profile_storage + matching (recent, satisfy
        // dependency chain) + contacting grant occurred_at > 12 months
        // ago. Decision F (contacting + stale) returns
        // reason_code=stale_consent.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c02',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c03',
            scope: 'contacting',
            action: 'granted',
            occurredAt: '2024-01-01T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with profile_storage but no matching consent': async () => {
        // §4.3 — seed profile_storage only; contacting check's dependency
        // chain (profile_storage + matching) fails on matching → 422
        // INVALID_SCOPE_COMBINATION with reason_code=scope_dependency_unmet
        // and denied_scopes=['matching'].
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a valid recruiter token': async () => {
        // §4.3 — pre-DB validation paths (missing field, missing header,
        // path-param format) and recruiter-token-only writes. Reset only;
        // the JWT injection happens in requestFilter.
        await withClient((c) => resetAllRows(c));
      },
      'a talent with all required scopes granted for matching': async () => {
        // §4.3 — seed profile_storage + matching grants; check operation=
        // matching returns result=allowed, scope=matching.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1e01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1e02',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with no consent events': async () => {
        // §4.3 — empty ledger. Used by check (Decision K → result=error,
        // reason_code=consent_state_unknown), history (events=[]), state
        // (all 5 scopes no_grant).
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/grant ----------------------------------------------
      'a valid recruiter token and an ungranted talent': async () => {
        // §4.3 — recruiter-session write; no pre-existing grant on the
        // talent for the requested scope (Decision Z grant for ungranted
        // talent path).
        await withClient((c) => resetAllRows(c));
      },
      'no valid token': async () => {
        // §4.3 — Bearer 'not-a-jwt' bypasses the rewriting filter so
        // JwtAuthGuard returns INVALID_TOKEN 401.
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/revoke --------------------------------------------
      'a valid recruiter token and a prior grant for talent+scope': async () => {
        // §4.3 — seed a prior matching grant so Decision A (revoke
        // references the prior grant id) fires; revoked_event_id is a
        // UUID matching the regex matcher.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a valid recruiter token and no prior grant for talent+scope': async () => {
        // §4.3 — no prior grant; revoke succeeds with revoked_event_id
        // null (Decision D).
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/decision-log --------------------------------------
      'a talent with one consent grant audit entry': async () => {
        // §4.3 — single audit row for a grant. entries[0] returns with
        // actor_type=recruiter and event_payload={event_id, scope}.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a01',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'inner-event-id', scope: 'matching' },
            createdAt: '2026-04-15T12:00:00.000Z',
          });
        });
      },
      'a talent with no audit entries': async () => {
        // §4.3 — empty audit. entries=[], next_cursor=null.
        await withClient((c) => resetAllRows(c));
      },
      'a talent with 5 audit entries; cursor at end of first page': async () => {
        // §4.3 — 5 audit rows; the cursor (CURSOR_C, CURSOR_E) sits at
        // page-1's edge, so the page-2 query with limit=2 returns rows
        // created_at < CURSOR_C. Need >2 older rows so hasMore=true and
        // next_cursor is a non-null encoded string.
        //
        // Row layout (newest → oldest by created_at):
        //   #1 (page 1)      created_at=2026-04-17, any type
        //   #2 (page 1 end)  created_at=CURSOR_C    id=CURSOR_E (cursor anchor)
        //   #3 (page 2 row1) created_at=2026-04-14T08:00:00Z  revoke entry
        //   #4 (page 2 row2) created_at=2026-04-13T15:30:00Z  check entry
        //   #5 (page 3)      created_at=2026-04-12, triggers hasMore=true
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000aa1',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-page1', scope: 'matching' },
            createdAt: '2026-04-17T10:00:00.000Z',
          });
          await seedAuditEvent(c, {
            id: CURSOR_E,
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-cursor', scope: 'matching' },
            createdAt: CURSOR_C,
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a02',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.revoke.recorded',
            payload: {
              event_id: 'inner-revoke-id',
              revoked_event_id: 'inner-grant-id',
              scope: 'matching',
            },
            createdAt: '2026-04-14T08:00:00.000Z',
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a03',
            actorId: null,
            actorType: 'system',
            eventType: 'consent.check.decision',
            payload: {
              decision_id: 'inner-decision-id',
              reason_code: 'consent_revoked',
              result: 'denied',
            },
            createdAt: '2026-04-13T15:30:00.000Z',
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000aa5',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-page3', scope: 'matching' },
            createdAt: '2026-04-12T10:00:00.000Z',
          });
        });
      },

      // -- /v1/consent/history -------------------------------------------
      'a talent with one consent grant event': async () => {
        // §4.3 — single grant event. events=[1], next_cursor=null.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a01',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-15T12:00:00.000Z',
            createdAt: '2026-04-15T12:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with 5 consent events; cursor at end of first page': async () => {
        // §4.3 — 5 consent rows, cursor at end of page 1 (CURSOR_C,
        // CURSOR_E). Page-2 query with limit=2 returns 2 rows; >2 older
        // rows exist so next_cursor is a non-null encoded string.
        //
        // Row layout (newest → oldest by created_at):
        //   #1  page-1            created_at=2026-04-17  any
        //   #2  page-1 end        created_at=CURSOR_C  id=CURSOR_E (anchor)
        //   #3  page-2 row1       created_at=2026-04-14T08:00Z granted profile_storage
        //   #4  page-2 row2       created_at=2026-04-13T15:30Z revoked contacting
        //   #5  page-3            created_at=2026-04-12  any  → hasMore=true
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000ab1',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-17T10:00:00.000Z',
            createdAt: '2026-04-17T10:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: CURSOR_E,
            scope: 'matching',
            action: 'granted',
            occurredAt: CURSOR_C,
            createdAt: CURSOR_C,
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a02',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-14T08:00:00.000Z',
            createdAt: '2026-04-14T08:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a03',
            scope: 'contacting',
            action: 'revoked',
            occurredAt: '2026-04-13T15:30:00.000Z',
            createdAt: '2026-04-13T15:30:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000ab5',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-12T10:00:00.000Z',
            createdAt: '2026-04-12T10:00:00.000Z',
            expiresAt: null,
          });
        });
      },

      // -- /v1/consent/grant + /revoke — idempotency conflicts ----------
      'an idempotency key already used with a different body': async () => {
        // §4.3 — seed an IdempotencyKey row with a request_hash that
        // cannot collide with what the controller computes from the
        // pact-shipped body. Conflict resolves with IDEMPOTENCY_KEY_CONFLICT
        // 409 regardless of the grant route the consumer hits.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedIdempotencyKey(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d18',
            key: 'd2d7a0f0-0000-7000-8000-000000000001',
            requestHash: 'pact-seeded-conflict-hash-grant',
          });
        });
      },
      'a revoke idempotency key already used with a different body': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedIdempotencyKey(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d19',
            key: 'd2d7a0f0-0000-7000-8000-000000000097',
            requestHash: 'pact-seeded-conflict-hash-revoke',
          });
        });
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
      // ===== M3 PR-8 §4.7 match-list (4 interactions) =====
      'a recruiter token, an active requisition with id REQ, and three ranked Summary examinations':
        async () => {
          // PR-8 §4.7 — seed active Requisition (matching JOB_ID in the
          // consumer test) and 3 ranked Summary examinations across the
          // three tiers. The match-list endpoint returns them via
          // findActiveReqLiveList; the Pact strict jsonBody asserts the
          // Summary contract.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedMatchListFixture(c, {
              jobId: '22222222-2222-7222-8222-222222222222',
              reqId: '33333333-3333-7333-8333-333333333333',
              examIds: [
                'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
                'dddddddd-dddd-7ddd-8ddd-dddddddddddd',
                'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee',
              ],
            });
          });
        },
      'a recruiter token and no active requisition for the job': async () => {
        // PR-8 §4.7 — no seed; the controller returns 200 with empty
        // data[] when findActiveRequisitionByJobId returns null.
        await withClient((c) => resetAllRows(c));
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
        // Mirrors the tenant-console-consumer "a recruiter session and
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
      // ===== M4 PR-3 §4.8 submittal-create (2 interactions) =====
      'a recruiter has authenticated and there is an Entrustable examination for the talent and job':
        async () => {
          // PR-3 §4.8 — seed a single ENTRUSTABLE examination matching
          // the consumer body's talent_id + job_id + examination_id.
          // The SubmittalController + SubmittalRepository.createSubmittal
          // path then builds the evidence package and persists the
          // workflow row at request time.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalFixture(c, {
              examinationId: '11110000-0000-7000-8000-0000000e0001',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              tier: 'ENTRUSTABLE',
            });
          });
        },
      'a recruiter has authenticated and there is a STRETCH examination for the talent and job':
        async () => {
          // PR-3 §4.8 — STRETCH tier; the builder refuses with
          // SUBMITTAL_STRETCH_BLOCKED before any submittal row is written.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalFixture(c, {
              examinationId: '33330000-0000-7000-8000-0000000a0001',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              tier: 'STRETCH',
            });
          });
        },
      // ===== M4 PR-4 §4.9 submittal-confirm (4 interactions) =====
      'a recruiter has authenticated, an Entrustable examination exists, and a draft submittal exists pinned to that examination':
        async () => {
          // PR-4 §4.9 — happy + ATTESTATION_MISSING share this state.
          // Seed Entrustable examination at examinationId matching
          // the consumer body's pinned_examination_id; pre-create a
          // draft submittal at the consumer-known submittal_id
          // (SUBMITTAL_ID_HAPPY in submittal-confirm.consumer.test.ts).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalFixture(c, {
              examinationId: '11110000-0000-7000-8000-0000000e0002',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              tier: 'ENTRUSTABLE',
              precreateDraftSubmittal: {
                submittalId: '99990000-0000-7000-8000-000000000901',
                evidencePackageId: '99990000-0000-7000-8000-0000000010a1',
              },
            });
          });
        },
      'a recruiter has authenticated, a draft submittal exists, and a newer examination has been generated for the same talent/job after the pinning':
        async () => {
          // PR-4 §4.9 — EXAMINATION_PINNED_OUTDATED. Seed the pinned
          // (older) examination, pre-create the draft submittal pinned
          // to it, and ALSO seed a newer examination for the same
          // (tenant, talent, job) triple with a later computed_at so
          // findLatestByTenantTalentJob returns the newer row.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalFixture(c, {
              examinationId: '44440000-0000-7000-8000-0000000d0002',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              tier: 'ENTRUSTABLE',
              precreateDraftSubmittal: {
                submittalId: '99990000-0000-7000-8000-000000000902',
                evidencePackageId: '99990000-0000-7000-8000-0000000010a2',
              },
              seedNewerExamination: {
                examinationId: '44440000-0000-7000-8000-0000000d0099',
                tier: 'ENTRUSTABLE',
              },
            });
          });
        },
      'a recruiter has authenticated, a Worth Considering examination exists, and a draft submittal exists without justification':
        async () => {
          // PR-4 §4.9 — JUSTIFICATION_REQUIRED. Seed a WORTH_CONSIDERING
          // examination + a draft submittal pinned to it with no
          // justification and no failed_criterion_acknowledgments. The
          // confirm flow's tier branch refuses with 422.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalFixture(c, {
              examinationId: '22220000-0000-7000-8000-0000000c0002',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
              tier: 'WORTH_CONSIDERING',
              precreateDraftSubmittal: {
                submittalId: '99990000-0000-7000-8000-000000000903',
                evidencePackageId: '99990000-0000-7000-8000-0000000010a3',
                justification: null,
              },
            });
          });
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
      // ===== M4 PR-6 §4.6 submittal-get + evidence-package (2 new givens) =====
      'a recruiter has authenticated and a TalentSubmittalRecord exists for the tenant':
        async () => {
          // PR-6 §4.6 — happy path for GET /v1/submittals/{id}. Seed an
          // Entrustable examination + the linked submittal + evidence
          // package at the consumer-known UUIDs (SUBMITTAL_ID_HAPPY +
          // EVIDENCE_PKG_ID in submittal-get.consumer.test.ts).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalForGetFixture(c, { submittalExists: true });
          });
        },
      'a recruiter has authenticated and a TalentSubmittalRecord + linked TalentJobEvidencePackage exist for the tenant':
        async () => {
          // PR-6 §4.6 — happy path for GET /v1/submittals/{id}/evidence-
          // package. Seed the full chain at the consumer-known UUIDs.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalForEvidencePackageFixture(c, {
              submittalExists: true,
              evidencePackageExists: true,
            });
          });
        },
      // ===== M4 PR-7 §4.9 + M5 PR-8b2 submittal-revoke (4 interactions) =====
      // Per directive §4.13 fixture migration: M4 'submitted' renames
      // to canonical 'submitted_to_ats'; M4 'draft' renames to
      // canonical 'created'. Provider state-handler seeds use the
      // canonical names post-rename.
      'a recruiter has authenticated and a submitted TalentSubmittalRecord exists for the tenant':
        async () => {
          // PR-7 §4.9 #1 — happy path. Seed a submittal advanced to
          // the canonical 'submitted_to_ats' state (walks the
          // mainline chain via raw SQL UPDATEs through the
          // M5 PR-8b2 rewritten 5-state trigger) and capture pre-
          // execution evidence-package hash; the afterEach hook
          // verifies byte-identity post-revoke.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRevokeFixture(c, {
              submittalExists: true,
              submittalState: 'submitted_to_ats',
              submittalId: '99990000-0000-7000-8000-000000000931',
              evidencePackageId: '99990000-0000-7000-8000-000000001031',
              examinationId: '11110000-0000-7000-8000-0000000e0007',
              talentId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
              jobId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
            });
          });
        },
      'a recruiter has authenticated and a draft TalentSubmittalRecord exists for the tenant':
        async () => {
          // PR-7 §4.9 #2 — sibling-revoke from canonical 'created'.
          // Post-PR-8b2 Q3 expansion this is a legal sibling-revoke
          // transition (NOT a refusal): the controller's canTransition
          // guard returns true for created -> revoked. The interaction
          // is preserved here for state-isolation byte-identity
          // assertion across the now-valid revoke. Provider state
          // string is canonical 'created' (M4 'draft' renamed).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRevokeFixture(c, {
              submittalExists: true,
              submittalState: 'created',
              submittalId: '99990000-0000-7000-8000-000000000932',
              evidencePackageId: '99990000-0000-7000-8000-000000001032',
              examinationId: '11110000-0000-7000-8000-0000000e0008',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7002',
              jobId: 'cccccccc-0000-7000-8000-0000000c7002',
            });
          });
        },
      'a recruiter has authenticated and an already-revoked TalentSubmittalRecord exists for the tenant':
        async () => {
          // PR-7 §4.9 #3 — REVOKE_NOT_ALLOWED on already-revoked. Seed
          // a submittal already in 'revoked' state (sibling-revoke
          // from 'created' via raw SQL through the M5 PR-8b2
          // rewritten trigger). Capture evidence-package hash; the
          // route refuses with REVOKE_NOT_ALLOWED and byte-identity
          // must still hold.
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRevokeFixture(c, {
              submittalExists: true,
              submittalState: 'revoked',
              submittalId: '99990000-0000-7000-8000-000000000933',
              evidencePackageId: '99990000-0000-7000-8000-000000001033',
              examinationId: '11110000-0000-7000-8000-0000000e0009',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a7003',
              jobId: 'cccccccc-0000-7000-8000-0000000c7003',
            });
          });
        },
      'a recruiter has authenticated and the submittal-revoke target does not exist for the tenant':
        async () => {
          // PR-7 §4.9 #4 — NOT_FOUND. No submittal seeded; no
          // pre-execution hash captured (the row doesn't exist so
          // state-isolation is trivially satisfied). Canonical
          // 'submitted_to_ats' chosen as the target-state placeholder
          // (per M4 fixture migration).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedSubmittalRevokeFixture(c, {
              submittalExists: false,
              submittalState: 'submitted_to_ats',
              submittalId: '99990000-0000-7000-8000-0000000009ff',
              evidencePackageId: '99990000-0000-7000-8000-00000000103f',
              examinationId: '11110000-0000-7000-8000-0000000e00ff',
              talentId: 'aaaaaaaa-0000-7000-8000-0000000a70ff',
              jobId: 'cccccccc-0000-7000-8000-0000000c70ff',
            });
          });
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

      // ===== M5 PR-4 engagement-* pacts (14 interactions) =====
      //
      // engagement-create: 4 interactions.
      // engagement-transition: 4 interactions.
      // engagement-reads (GET /v1/engagements/{id} + .../events): 6 interactions.
      //
      // All state-seeding helpers below truncate first (resetAllRows) and
      // then seed the minimum substrate needed for each interaction to
      // produce the contracted response when the AppModule replays the
      // request.

      'a recruiter has authenticated and a Talent + overlay + Requisition exist in tenant for engagement creation':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
          });
        },

      'a recruiter has authenticated but the talent has no overlay in tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            // 4e-engagement-key: seed the happy-path TalentRecord +
            // Requisition, but the interaction references a GHOST talent_id
            // (no matching TalentRecord in tenant). The controller's Pattern C
            // validator (talentRecordRepository.findById) returns null → 422
            // ENGAGEMENT_REFERENCE_NOT_FOUND.
            await seedEngagementBasics(c);
          });
        },

      'a portal user has authenticated against the engagement-create endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      'an idempotency key has been used for a prior engagement-create with a different body':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            // Pre-seed an IdempotencyKey with the same key the consumer
            // sends + a different request_hash → controller's
            // idempotency.lookup throws IDEMPOTENCY_KEY_CONFLICT 409.
            await c.query(
              `INSERT INTO consent."IdempotencyKey"
                 (id, tenant_id, key, request_hash, response_status, response_body, created_at)
               VALUES ($1, $2, $3, $4, 201, $5::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-cccc00000c20',
                TENANT_ID,
                '0190d5a4-7e01-7e2a-a4d3-cccc00000c14',
                'sha256-of-some-other-body',
                '{}',
              ],
            );
          });
        },

      'a recruiter has authenticated and an engagement exists in surfaced state for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-dddd00000d01',
              state: 'surfaced',
            });
          });
        },

      'a recruiter has authenticated but the engagement does not exist for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            // Engagement intentionally not seeded.
          });
        },

      'a portal user has authenticated against the engagement-transition endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      'a recruiter has authenticated and an engagement exists for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-eeee00000e01',
              state: 'surfaced',
            });
          });
        },

      'a portal user has authenticated against the engagement-read endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      'a recruiter has authenticated and an engagement with at least one event exists for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-eeee00000e01',
              state: 'surfaced',
            });
            await c.query(
              `INSERT INTO engagement."TalentEngagementEvent"
                 (id, tenant_id, engagement_id, event_type, event_payload, created_at)
               VALUES ($1, $2, $3, 'state_transition'::engagement."EngagementEventType", $4::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-eeee0e0000e1',
                TENANT_ID,
                '00000000-0000-7000-8000-eeee00000e01',
                JSON.stringify({ from_state: null, to_state: 'surfaced' }),
              ],
            );
          });
        },

      'a portal user has authenticated against the engagement-events endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      // ===== M5 PR-6 outreach-send pacts (4 interactions) =====
      // The DraftProvider + DeliveryProvider are overridden at module
      // bootstrap time (see overrideProvider above) with canned mocks,
      // so the only Postgres seeding required is the engagement row
      // (engaged state for the happy path; surfaced for the illegal-
      // transition refusal). The portal-JWT refusal does not seed an
      // engagement (the consumer_type check fires before any read).

      'a recruiter has authenticated and an engagement exists in engaged state for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-ffff00000f01',
              state: 'engaged',
            });
            // M5 PR-9b — Step 5.5 runs runtime consent-at-send check.
            // The resolver enforces the SCOPE_DEPENDENCY_CHAIN (contacting
            // requires profile_storage + matching granted first; missing
            // dep would throw 422 INVALID_SCOPE_COMBINATION). Seed the
            // full chain so the resolver returns 'allowed'.
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000001',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000003',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000005',
              scope: 'contacting',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
          });
        },

      'a recruiter has authenticated and an engagement exists in non-engaged state for outreach':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-ffff00000f02',
              state: 'surfaced',
            });
            // M5 PR-9b — full chain so Step 5.5 passes and the surfaced
            // failure is ENGAGEMENT_STATE_INVALID at Step 8 repo.sendOutreach
            // (not the upstream consent-at-send refusal).
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000002',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000004',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000006',
              scope: 'contacting',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
          });
        },

      'a recruiter has authenticated but no engagement exists for tenant for outreach':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            // Engagement intentionally not seeded → 404 NOT_FOUND.
          });
        },

      'a portal user has authenticated against the outreach-send endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      // M5 PR-9b §4.5 / Ruling 9 — consent-at-send refusal seed. The
      // engagement is in 'engaged' state (Step 5 idempotency lookup
      // passes; Step 5.5 consent-at-send runs). The consent ledger is
      // seeded with a granted-then-revoked pair so the resolver
      // returns result='denied' at runtime check time (revoke occurred
      // BEFORE the outreach-send attempt). Reuses the existing
      // seedConsentEvent helper rather than introducing a separate
      // seedConsentLedger helper (the ledger is event-sourced — a single
      // higher-level helper would not match the schema reality).
      'an engagement in engaged state with contacting consent revoked exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-ffff00000f31',
              state: 'engaged',
            });
            // Seed prerequisite chain (profile_storage + matching) so
            // the resolver returns a clean denied (not 422 dep-unmet)
            // when contacting is revoked.
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000030',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000033',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000031',
              scope: 'contacting',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000032',
              scope: 'contacting',
              action: 'revoked',
              occurredAt: '2026-04-01T00:00:00.000Z',
            });
          });
        },

      // ===== Outreach Draft/Preview SEND pacts =====
      // SEND reads a prior outreach_drafted event (cross-event-ref check)
      // before the consent-at-send gate. Seed engaged engagement + the
      // full consent chain + a seeded outreach_drafted event with a fixed
      // id the consumer references as draft_event_id.
      'a recruiter has authenticated and an engagement in engaged state with a prior outreach_drafted event exists for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-ffff00000f01',
              state: 'engaged',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000051',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000052',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000053',
              scope: 'contacting',
              action: 'granted',
              occurredAt: '2026-05-25T00:00:00.000Z',
            });
            await c.query(
              `INSERT INTO engagement."TalentEngagementEvent"
                 (id, tenant_id, engagement_id, event_type, event_payload, created_at)
               VALUES ($1, $2, $3, 'outreach_drafted'::engagement."EngagementEventType", $4::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-ffff0dddd001',
                TENANT_ID,
                '00000000-0000-7000-8000-ffff00000f01',
                JSON.stringify({
                  draft_text: 'Mocked AI draft for pact verification.',
                  ai_draft_audit_record_id: '00000000-0000-7000-8000-ffff0a000001',
                  model_used: 'claude-sonnet-mock',
                  input_tokens: 10,
                  output_tokens: 20,
                  duration_ms: 100,
                  prompt: 'Reach out to talent about the role.',
                  max_tokens: 512,
                }),
              ],
            );
          });
        },

      'an engagement in engaged state with a prior outreach_drafted event but contacting consent revoked exists for the tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-ffff00000f31',
              state: 'engaged',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000061',
              scope: 'profile_storage',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000063',
              scope: 'matching',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000064',
              scope: 'contacting',
              action: 'granted',
              occurredAt: '2026-01-01T00:00:00.000Z',
            });
            await seedConsentEvent(c, {
              id: '00000000-0000-7000-8000-ffff0c000065',
              scope: 'contacting',
              action: 'revoked',
              occurredAt: '2026-04-01T00:00:00.000Z',
            });
            await c.query(
              `INSERT INTO engagement."TalentEngagementEvent"
                 (id, tenant_id, engagement_id, event_type, event_payload, created_at)
               VALUES ($1, $2, $3, 'outreach_drafted'::engagement."EngagementEventType", $4::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-ffff0dddd031',
                TENANT_ID,
                '00000000-0000-7000-8000-ffff00000f31',
                JSON.stringify({
                  draft_text: 'Mocked AI draft for pact verification.',
                  ai_draft_audit_record_id: '00000000-0000-7000-8000-ffff0a000031',
                  model_used: 'claude-sonnet-mock',
                  input_tokens: 10,
                  output_tokens: 20,
                  duration_ms: 100,
                  prompt: 'Reach out to talent about the role.',
                  max_tokens: 512,
                }),
              ],
            );
          });
        },

      // ===== M5 PR-7 response-received pacts (4 interactions) =====
      // PR-7 endpoint POST /v1/engagements/{id}/response. No new
      // migration constants needed (writes only to engagement +
      // consent schemas; both already in the pact-provider migration
      // list). DRAFT_PROVIDER_TOKEN + DELIVERY_PROVIDER_TOKEN overrides
      // remain wired at AppModule bootstrap (PR-6 substrate); PR-7
      // doesn't invoke either provider but they stay in the DI graph.

      'a recruiter has authenticated and an engagement exists in awaiting_response state with a prior outreach_sent event for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-eeee00000e01',
              state: 'awaiting_response',
            });
            // Seed the prior outreach_sent event that the response
            // references (cross-event-ref validation must resolve).
            await c.query(
              `INSERT INTO engagement."TalentEngagementEvent"
                 (id, tenant_id, engagement_id, event_type, event_payload, created_at)
               VALUES ($1, $2, $3, 'outreach_sent'::engagement."EngagementEventType", $4::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-eeee0e000001',
                TENANT_ID,
                '00000000-0000-7000-8000-eeee00000e01',
                JSON.stringify({
                  ai_draft_audit_record_id: '00000000-0000-7000-8000-eeee0a000001',
                  model_used: 'claude-sonnet-mock',
                  input_tokens: 10,
                  output_tokens: 20,
                  duration_ms: 100,
                  delivered_at: '2026-05-25T10:01:00.000Z',
                  delivery_channel: 'email',
                  delivery_id: '00000000-0000-7000-8000-eeee0d000001',
                }),
              ],
            );
          });
        },

      'a recruiter has authenticated and an engagement exists in responded state for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-eeee00000e02',
              state: 'responded',
            });
            // Seed the matching outreach_sent event so the repository's
            // cross-event-ref validation (Step 2) succeeds and the
            // canTransition guard (Step 3) reaches the
            // ENGAGEMENT_STATE_INVALID refusal path the consumer pact
            // expects.
            await c.query(
              `INSERT INTO engagement."TalentEngagementEvent"
                 (id, tenant_id, engagement_id, event_type, event_payload, created_at)
               VALUES ($1, $2, $3, 'outreach_sent'::engagement."EngagementEventType", $4::jsonb, NOW())`,
              [
                '00000000-0000-7000-8000-eeee0e000001',
                TENANT_ID,
                '00000000-0000-7000-8000-eeee00000e02',
                JSON.stringify({
                  ai_draft_audit_record_id: '00000000-0000-7000-8000-eeee0a000002',
                  model_used: 'claude-sonnet-mock',
                  input_tokens: 10,
                  output_tokens: 20,
                  duration_ms: 100,
                  delivered_at: '2026-05-25T10:01:00.000Z',
                  delivery_channel: 'email',
                  delivery_id: '00000000-0000-7000-8000-eeee0d000002',
                }),
              ],
            );
          });
        },

      'a recruiter has authenticated and an engagement exists in awaiting_response state but no outreach_sent event matches the outreach_event_ref_id':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-eeee00000e03',
              state: 'awaiting_response',
            });
            // Intentionally NOT seeding the outreach_sent event — the
            // consumer pact references a UUID that won't resolve.
          });
        },

      'a portal user has authenticated against the response-received endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      // M5 PR-8a §4.10 — conversation-started state handlers.
      //
      // NOTE: the happy precondition ("engagement exists in responded
      // state for tenant") is reused from the PR-7 response-received
      // failure scenario at the handler above — both PR-7 (testing
      // illegal responded → responded refusal) and PR-8a (testing legal
      // responded → in_conversation success) require an engagement
      // seeded at state='responded' for the same tenant + same engagement
      // ID. No duplicated handler.
      //
      // NO new pact migration constants needed: writes are to engagement
      // schema only; all 4 expected migrations
      // (engagement init, event log, consent, ai_draft) are already
      // present (Process Lesson 52 verification).

      'a recruiter has authenticated and an engagement exists in in_conversation state for tenant':
        async () => {
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedEngagementBasics(c);
            await seedEngagementRow(c, {
              id: '00000000-0000-7000-8000-cccc00000c02',
              state: 'in_conversation',
            });
            // No outreach_sent / response_received event seeding needed
            // — PR-8a has no cross-event reference validation (Ruling 3).
            // canTransition refuses in_conversation → in_conversation at
            // the state-machine layer (the matrix has no self-loop).
          });
        },

      'a portal user has authenticated against the conversation-started endpoint':
        async () => {
          await withClient((c) => resetAllRows(c));
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
    };

    // M5 PR-4 helpers: seed TalentRecord + Job + Requisition for the
    // PACT_RECRUITER_ACTOR_ID tenant context — engagement-create's three
    // cross-schema validators need all three to be visible.
    //
    // 4e-engagement-key: engagement.talent_id is now a TalentRecord.id (was a
    // Core talent.Talent.id). The Pattern-C validator resolves against
    // talent_record.TalentRecord (not the Core overlay), so we seed a
    // TalentRecord row keyed by `talentId` instead of Talent + overlay.
    async function seedEngagementBasics(c: Client): Promise<void> {
      const talentId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      const jobId = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
      const reqId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
      await c.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, created_at, updated_at)
         VALUES ($1, $2, 'Pact', 'Talent', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [talentId, TENANT_ID],
      );
      await c.query(
        `INSERT INTO job_domain."Job" (id, tenant_id)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [jobId, TENANT_ID],
      );
      await c.query(
        `INSERT INTO job_domain."Requisition"
           (id, tenant_id, job_id, recruiter_id, state)
         VALUES ($1, $2, $3, $4, 'active'::job_domain."RequisitionState")`,
        [reqId, TENANT_ID, jobId, PACT_RECRUITER_ACTOR_ID],
      );
    }

    async function seedEngagementRow(
      c: Client,
      params: { id: string; state: string },
    ): Promise<void> {
      const talentId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
      const reqId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
      await c.query(
        `INSERT INTO engagement."TalentJobEngagement"
           (id, tenant_id, talent_id, requisition_id, examination_id, state, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5::engagement."EngagementState", NOW())`,
        [params.id, TENANT_ID, talentId, reqId, params.state],
      );
    }

    // Request filter — rewrites the literal fake credentials the
    // consumer pacts ship into the real signed JWT, then forwards.
    //
    //   - tenant-console-consumer ships
    //     `Cookie: aramo_access_token=eyJfake.access.token` → rewrite
    //     the cookie value to the production-issuer JWT.
    //   - the retired thin consumer shipped `Authorization: Bearer
    //     eyJfake.token` → rewrite to `Bearer <real JWT>`; the literal
    //     `Bearer not-a-jwt` (the 401-INVALID_TOKEN interaction) was
    //     intentionally bypassed so JwtAuthGuard rejects it. Both
    //     branches are now unexercised.
    //   - tenant-console-consumer #5 ships NO Cookie header — the cookie
    //     branch is conditional on the literal substring, so it's a
    //     no-op for that interaction.
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
      'verifies all interactions from the 5 aramo-core pacts',
      async () => {
        const verifier = new Verifier({
          providerBaseUrl: `http://127.0.0.1:${port}`,
          pactUrls: [
            INGESTION_PACT,
            PROHIBITED_PACT,
            TENANT_CONSOLE_PACT,
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
