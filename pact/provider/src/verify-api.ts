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

// PR-14 §4.7 + Amendment v1.0 §2 + PR-15 §4.2/§4.3 + M3 PR-8 §4.7 —
// Pact provider verifier for apps/api.
//
// Scope:
//   - PR-14: ingestion-consumer (2 interactions) + prohibited-source-type
//     (1 interaction)
//   - PR-15 §4.2 (F10): tenant-console-consumer (5 consent interactions)
//   - PR-15 §4.3 (F9): ats-thin (23 consent interactions)
//   - M3 PR-8 §4.7: ats-thin match-list (4 interactions; happy path,
//     empty list, 400 INVALID_REQUEST, 403 INSUFFICIENT_PERMISSIONS).
//     PR-8's match-list interactions MUST pass; pre-existing 23 consent
//     interactions remain covered by the PR-15 §4.3 handlers below.
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
//   - ats-thin pacts ship Authorization: Bearer eyJfake.token — rewritten
//     to a real Bearer JWT. The literal 'Bearer not-a-jwt' (interaction
//     #14 of ats-thin) is intentionally NOT rewritten so JwtAuthGuard
//     returns INVALID_TOKEN 401.
//
// Run condition: ARAMO_RUN_PACT_PROVIDER=1 gating. Invoke via
// `npm run pact:provider`.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../..');
const CONSENT_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
const INGESTION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql',
);
const INGESTION_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql',
);
const EXAMINATION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
);
const EXAMINATION_LIVE_LIST_MIGRATION = resolve(
  ROOT,
  'libs/examination/prisma/migrations/20260521120000_add_live_list_index/migration.sql',
);
const JOB_DOMAIN_INIT_MIGRATION = resolve(
  ROOT,
  'libs/job-domain/prisma/migrations/20260519100000_init_job_domain_model/migration.sql',
);
// M3 PR-9 §4.8 — talent migration applied so the portal-thin state
// handlers can seed Talent + TalentTenantOverlay rows.
const TALENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
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
// M4 PR-3 — talent-evidence migration applied so the buildPackage
// rate_expectation lookup can find a TalentRateExpectation row when the
// optional rate_expectation_id is supplied (the pact happy-path body
// does NOT supply one, but the migration is harmless to apply).
const TALENT_EVIDENCE_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
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
const ATS_THIN_PACT = resolve(ROOT, 'pact/pacts/ats-thin-aramo-core.json');
const PORTAL_THIN_PACT = resolve(ROOT, 'pact/pacts/portal-thin-aramo-core.json');

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

// Constants shared across the tenant-console + ats-thin pacts. The talent
// uuid matches the value the consumer tests use; the recruiter actor uuid
// matches the audit-row value the pacts assert with a regex matcher.
const PACT_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PACT_RECRUITER_ACTOR_ID = '00000000-0000-7000-8000-000000000bb1';

// Cursor anchor reused by ats-thin #13 / #17 and the regenerated
// tenant-console-consumer pact #3 (PR-15 §4.1). c is the keyset's
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
      // M3 PR-9 — portal-thin state handlers seed Talent + TalentTenantOverlay;
      // truncate at the start of every interaction.
      await c.query('TRUNCATE TABLE talent."TalentTenantOverlay" CASCADE');
      await c.query('TRUNCATE TABLE talent."Talent" CASCADE');
      // M4 PR-3 — submittal-create state handlers seed an examination
      // and trigger buildPackage which writes the evidence package +
      // submittal record. Truncate both tables so prior runs don't leak.
      await c.query('TRUNCATE TABLE engagement."TalentSubmittalRecord" CASCADE');
      await c.query('TRUNCATE TABLE evidence."TalentJobEvidencePackage" CASCADE');
    }

    // M3 PR-9 §4.8 — seed a Talent core row + a TalentTenantOverlay for
    // the portal-thin pacts. The portal JWT's sub is PORTAL_TALENT_ID;
    // the controller derives talent_id from authContext.sub and
    // tenant_id from authContext.tenant_id (TENANT_ID below). Both
    // states ("profile P" and "consent grants G") use the same fixture
    // shape; consent grants are seeded separately via seedConsentEvent
    // when the test requires them.
    async function seedPortalTalentFixture(c: Client): Promise<void> {
      await c.query(
        `INSERT INTO talent."Talent" (id, lifecycle_status, updated_at)
         VALUES ($1, 'active', NOW())`,
        [PORTAL_TALENT_ID],
      );
      await c.query(
        `INSERT INTO talent."TalentTenantOverlay"
           (id, talent_id, tenant_id, source_recruiter_id, source_channel,
            tenant_status, updated_at)
         VALUES ($1, $2, $3, NULL, 'self_signup', 'active', NOW())`,
        [
          '00000000-0000-7000-8000-0000000000aa',
          PORTAL_TALENT_ID,
          TENANT_ID,
        ],
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
           (id, talent_id, tenant_id, scope, action, captured_by_actor_id,
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
        await c.query(
          `INSERT INTO evidence."TalentJobEvidencePackage"
             (id, tenant_id, talent_id, job_id, examination_id,
              talent_identity, contact_summary, capability_summary,
              match_justification, recruiter_contribution,
              engagement_event_refs)
           VALUES ($1,$2,$3,$4,$5,
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
          ],
        );
        const fca = opts.precreateDraftSubmittal.failed_criterion_acknowledgments;
        await c.query(
          `INSERT INTO engagement."TalentSubmittalRecord"
             (id, tenant_id, talent_id, job_id, evidence_package_id,
              pinned_examination_id, state, created_by,
              justification, failed_criterion_acknowledgments)
           VALUES ($1,$2,$3,$4,$5,$6,'draft'::engagement."SubmittalState",$7,
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

    async function seedIdempotencyKey(
      c: Client,
      opts: { id: string; key: string; requestHash: string },
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
          201,
          JSON.stringify({ pact_seeded: true }),
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
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
        EXAMINATION_INIT_MIGRATION,
        EXAMINATION_LIVE_LIST_MIGRATION,
        JOB_DOMAIN_INIT_MIGRATION,
        TALENT_INIT_MIGRATION,
        // M4 PR-3 §4.8 — evidence + talent-evidence + submittal
        // migrations applied so the submittal-create pact verification
        // can build the evidence package + persist the workflow record.
        TALENT_EVIDENCE_INIT_MIGRATION,
        EVIDENCE_INIT_MIGRATION,
        SUBMITTAL_INIT_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }
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

      accessJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: ['ingestion:write'],
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
      portalJwt = await new SignJWT({
        sub: PORTAL_TALENT_ID,
        consumer_type: 'portal',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: [],
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

      module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

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

    // State handlers for the 3 ingestion-pact + 5 tenant-console + 23
    // ats-thin interactions. Each handler:
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

      // ===== PR-15 §4.3 ats-thin (18 unique state handlers covering 23
      // interactions; duplicates of 'a valid recruiter token' / 'a talent
      // with no consent events' / 'no valid token' are handled by a
      // single entry each) =====

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
        // PR-9 §4.8 — happy /v1/portal/profile interaction. Seed Talent
        // + TalentTenantOverlay so findSelfProfile returns a projection.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedPortalTalentFixture(c);
        });
      },
      'a portal talent with consent grants G exists': async () => {
        // PR-9 §4.8 — happy /v1/portal/consent interaction. Seed Talent
        // + overlay AND a grant for each of the 5 ConsentScope values so
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
    };

    // Request filter — rewrites the literal fake credentials the
    // consumer pacts ship into the real signed JWT, then forwards.
    //
    //   - tenant-console-consumer ships
    //     `Cookie: aramo_access_token=eyJfake.access.token` → rewrite
    //     the cookie value to the production-issuer JWT.
    //   - ats-thin ships `Authorization: Bearer eyJfake.token` → rewrite
    //     to `Bearer <real JWT>`. The literal `Bearer not-a-jwt` (the
    //     401-INVALID_TOKEN interaction) is intentionally bypassed so
    //     JwtAuthGuard rejects it.
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
        // 'Bearer eyJfake.token' (the canonical recruiter JWT); ats-thin
        // interactions continue to use 'Bearer eyJfake.token' via the
        // first branch.
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
            ATS_THIN_PACT,
            PORTAL_THIN_PACT,
          ],
          stateHandlers,
          requestFilter: requestFilter as never,
          logLevel: 'warn',
        });
        await verifier.verifyProvider();
      },
      600_000,
    );
  },
);
