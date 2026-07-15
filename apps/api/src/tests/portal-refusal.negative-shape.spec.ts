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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

import { applyTalentRecordMigrations } from './talent-record-fixtures.js';

// Portal P1 PR-2a — Portal OPEN-4 chain + R10 negative-shape integration test
// (extends the M3 PR-9 F23 negative-shape spec onto the new records surface).
//
// End-to-end (boots AppModule against a Postgres testcontainer):
//   1. Provision consent + ingestion + examination + job-domain + talent +
//      entitlement + talent_record + talent_trust + portal_identity migrations.
//   2. Sign portal / recruiter / unentitled-tenant JWTs (+ an unauthenticated
//      case). The portal JWT sub = PortalUser.id.
//   3. Seed the OPEN-4 chain: a PortalUser → cluster → (tenant A) a husk that
//      merges into the ACTIVE survivor holding the ATS record ref, and (tenant B)
//      a second subject on the SAME cluster → a second record.
//   4. GET /v1/portal/records → 200 resolving BOTH records (husk→survivor +
//      cross-tenant), asserting (A) no R10-class leaks, (B) no PR-8 Match-Class
//      leaks, (C) the closed PortalProfile envelope.
//   5. GET /v1/portal/records/:id/{profile,consent} → 200 for an in-chain record;
//      a record NOT in the chain (or malformed) → a UNIFORM 404.
//   6. Recruiter JWT → 403 INSUFFICIENT_PERMISSIONS; unauthenticated → 401;
//      portal-scoped-but-unentitled-tenant JWT → 403 TENANT_CAPABILITY_NOT_ENTITLED.
//
// Lives in apps/api (not libs/portal) for the same Nx-cycle reason as PR-8's
// negative-shape spec — a static AppModule import from libs/portal would create
// libs/portal → @aramo/api → MatchingModule → ... cycle.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const CONSENT_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
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
const TALENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/talent/prisma/migrations/20260516085014_init_talent_model/migration.sql',
);
// PR-A1b §4 sweep — portal routes are now class-level @RequireCapability('portal');
// the integration boot must have the entitlement schema available so the
// tenant-axis gate can be exercised (both pass and deliberate-failure paths).
const ENTITLEMENT_INIT_MIGRATION = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
// Portal P1 PR-2a — the OPEN-4 chain provisions talent_trust (ResolutionSubject +
// ResolutionSubjectRef, the PERSON_CLUSTER → ATS_TALENT_RECORD graph) and
// portal_identity (PortalUser). Full talent_trust set so the regenerated client's
// SELECTs resolve every column.
const TALENT_TRUST_MIGRATIONS = [
  '20260628000000_init_talent_trust',
  '20260703120000_tr2a1_subject_anchor',
  '20260703130000_tr2a2_match_advisory',
  '20260703140000_tr2a3_advisory_resolution',
  '20260705120000_add_reconcile_watermark_to_resolution_subject',
  '20260706120000_ats_ref_partial_unique',
  '20260706160000_sourcing_pool_keyset_index',
  '20260706170000_tr2a_b1_subject_anchor_source_class',
  '20260706180000_tr2a_b1_subject_anchor_source_class_unique',
  '20260706200000_tr2a_b2_advisory_reopen_provenance',
  '20260706230000_tr2a_b3b_subject_merge_operation',
  '20260707120000_tr6_b1_last_matched_at',
  '20260707130000_tr6_b1_merge_operation_kind',
  '20260708120000_tr3_b1_verification_request',
  '20260709120000_tr4_b1_evidence_link_unique',
  '20260710120000_tr4_b3_last_consistency_at',
  '20260711120000_tr5_b2_thinness_flags',
  '20260712120000_tr8_b1_verified_control_stale',
  '20260713120000_tr12_b1_verification_proposal',
].map((n) => resolve(ROOT, `libs/talent-trust/prisma/migrations/${n}/migration.sql`));
const PORTAL_IDENTITY_MIGRATION = resolve(
  ROOT,
  'libs/portal-identity/prisma/migrations/20260714120000_init_portal_identity/migration.sql',
);

// The OPEN-4 chain seed ids: a PortalUser (id = JWT sub) → cluster → a live
// ResolutionSubject holding both the PERSON_CLUSTER ref and the ATS_TALENT_RECORD
// ref (= the seeded TalentRecord).
const CLUSTER_ID = 'cccccccc-cccc-7ccc-8ccc-ccccccccc111';
const SUBJECT_ID = 'dddddddd-dddd-7ddd-8ddd-ddddddddd111'; // the ACTIVE survivor (tenant A)
// Husk→survivor proof: a MERGED subject that holds the PERSON_CLUSTER ref and
// merges into SUBJECT_ID (the survivor that holds the ATS record ref). The chain
// must follow the husk to the survivor via the standing resolver.
const HUSK_SUBJECT_ID = 'dddddddd-dddd-7ddd-8ddd-ddddddddd222';
// Cross-tenant proof: a second tenant referencing the SAME cluster → a 2nd record.
const TENANT_B_ID = '33333333-3333-7333-8333-333333333333';
const SUBJECT_B_ID = 'dddddddd-dddd-7ddd-8ddd-ddddddddd333';
const RECORD_B_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaabbb';

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-portal-refusal-audience';
const ALG = 'RS256';

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const PORTAL_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
// PR-A1b §4 — a second tenant deliberately NOT seeded with the `portal`
// capability. Used by the distinct-from-authz proof: a JWT carrying the
// full portal scope set in this tenant is rejected by EntitlementGuard
// with TENANT_CAPABILITY_NOT_ENTITLED — proving the tenant axis fires
// independently of (and BEFORE) the scope axis.
const UNENTITLED_TENANT_ID = '22222222-2222-7222-8222-222222222222';

// R10-class fields that must NEVER appear in any portal response item
// (per verify-portal-refusal.ts forbidden list + the R10 charter
// refusal — no internal reasoning exposure).
const R10_EXACT_FORBIDDEN = ['internal_reasoning', 'entrustability_tier_raw'];
const R10_PREFIX_FORBIDDEN = ['override_', 'recruiter_'];

// PR-8 Match/Full-class fields — these must never leak into portal
// responses either (Phase 3 invariant 4: "no recruiter or system artifact
// leakage").
const MATCH_CLASS_FORBIDDEN = [
  'tier',
  'rank_ordinal',
  'examination_id',
  'score',
  'why_matched_sentence',
  'strengths',
  'gaps',
  'risk_flags',
  'expanded_reasoning',
  'evidence_references',
  'confidence_indicators',
  'delta_to_entrustable',
];

function assertNoR10OrMatchClass(value: unknown, contextPath: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoR10OrMatchClass(value[i], `${contextPath}[${i}]`);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    for (const f of R10_EXACT_FORBIDDEN) {
      expect(
        key,
        `R10 exact-forbidden field "${f}" leaked at ${contextPath}.${key}`,
      ).not.toBe(f);
    }
    for (const p of R10_PREFIX_FORBIDDEN) {
      expect(
        key.startsWith(p),
        `R10 forbidden prefix "${p}*" leaked at ${contextPath}.${key}`,
      ).toBe(false);
    }
    for (const f of MATCH_CLASS_FORBIDDEN) {
      expect(
        key,
        `Match/Full-class field "${f}" leaked at ${contextPath}.${key}`,
      ).not.toBe(f);
    }
    assertNoR10OrMatchClass(obj[key], `${contextPath}.${key}`);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Portal records — OPEN-4 chain + R10 negative-shape verification (end-to-end)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let portalJwt: string;
    let recruiterJwt: string;
    // PR-A1b §4 — JWT for the distinct-from-authz proof: carries all
    // portal scopes (would pass RolesGuard) but is bound to
    // UNENTITLED_TENANT_ID (no `portal` capability row). Expect 403
    // TENANT_CAPABILITY_NOT_ENTITLED — NOT INSUFFICIENT_PERMISSIONS.
    let portalScopedUnentitledTenantJwt: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const migrationPath of [
        CONSENT_MIGRATION,
        CONSENT_REKEY_MIGRATION,
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
        EXAMINATION_INIT_MIGRATION,
        EXAMINATION_LIVE_LIST_MIGRATION,
        JOB_DOMAIN_INIT_MIGRATION,
        TALENT_INIT_MIGRATION,
        ENTITLEMENT_INIT_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }
      // 4e-rest-b — the portal profile re-homed onto TalentRecord; apply the
      // talent_record schema so the re-pointed portal fixture (a TalentRecord
      // row) is readable by findSelfProfile.
      await applyTalentRecordMigrations(setup);

      // Portal P1 PR-2a — the OPEN-4 chain schemas.
      for (const migrationPath of [...TALENT_TRUST_MIGRATIONS, PORTAL_IDENTITY_MIGRATION]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }

      // PR-A1b §4 — seed the integration-spec tenant with the `portal`
      // capability so the pass-path tests can traverse the gated routes.
      // The default-posture rows seeded by the migration apply only to
      // SEED_IDS.tenant (01900000-...001); this spec uses a distinct
      // TENANT_ID (11111111-...111), so the per-test seed is required.
      await setup.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'portal') ON CONFLICT DO NOTHING`,
        [TENANT_ID],
      );

      // 4e-rest-b — seed the portal talent's TalentRecord (findSelfProfile
      // re-homed onto the ATS heart). tenant_status + source_channel non-null
      // so the reader's un-statused → 404 guard is satisfied.
      await setup.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel,
            created_at, updated_at)
         VALUES ($1, $2, 'Portal', 'Talent', 'active', 'self_signup', NOW(), NOW())`,
        [PORTAL_TALENT_ID, TENANT_ID],
      );
      // Seed a matching consent grant so ConsentService.getState returns a
      // non-trivial scope state.
      await setup.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
            captured_method, consent_version, occurred_at, created_at)
         VALUES ($1,$2,$3,'matching','granted',$4,
                 'recruiter_capture','v1','2026-04-01T10:00:00Z',
                 '2026-04-01T10:00:00Z')`,
        [
          '00000000-0000-7000-8000-0000000000a1',
          PORTAL_TALENT_ID,
          TENANT_ID,
          RECRUITER_ID,
        ],
      );

      // Portal P1 PR-2a — the OPEN-4 chain seed. sub → PortalUser → cluster →
      // (cross-tenant) PERSON_CLUSTER holders → (husk→survivor) subjects →
      // ATS_TALENT_RECORD refs → live records. Two tenants share CLUSTER_ID.
      //
      // TENANT A — husk→survivor: the PERSON_CLUSTER ref sits on a MERGED husk
      // that points at SUBJECT_ID (the ACTIVE survivor holding the record ref).
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', NOW())`,
        [SUBJECT_ID, TENANT_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubject"
           (id, tenant_id, status, merged_into_subject_id, created_at)
         VALUES ($1::uuid, $2::uuid, 'MERGED', $3::uuid, NOW())`,
        [HUSK_SUBJECT_ID, TENANT_ID, SUBJECT_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'PERSON_CLUSTER',$4::uuid,'seed',NOW())`,
        ['00000000-0000-7000-8000-0000000000f1', HUSK_SUBJECT_ID, TENANT_ID, CLUSTER_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'ATS_TALENT_RECORD',$4::uuid,'seed',NOW())`,
        ['00000000-0000-7000-8000-0000000000f2', SUBJECT_ID, TENANT_ID, PORTAL_TALENT_ID],
      );

      // TENANT B — cross-tenant: same cluster, a distinct live record.
      await setup.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel,
            created_at, updated_at)
         VALUES ($1, $2, 'Portal', 'TalentB', 'active', 'self_signup', NOW(), NOW())`,
        [RECORD_B_ID, TENANT_B_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', NOW())`,
        [SUBJECT_B_ID, TENANT_B_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'PERSON_CLUSTER',$4::uuid,'seed',NOW())`,
        ['00000000-0000-7000-8000-0000000000f3', SUBJECT_B_ID, TENANT_B_ID, CLUSTER_ID],
      );
      await setup.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'ATS_TALENT_RECORD',$4::uuid,'seed',NOW())`,
        ['00000000-0000-7000-8000-0000000000f4', SUBJECT_B_ID, TENANT_B_ID, RECORD_B_ID],
      );

      // The PortalUser (id = JWT sub) → the shared cluster.
      await setup.query(
        `INSERT INTO portal_identity."PortalUser"
           (id, email_normalized, cluster_id, created_at, updated_at)
         VALUES ($1::uuid, 'portal-neg@example.com', $2::uuid, NOW(), NOW())`,
        [PORTAL_TALENT_ID, CLUSTER_ID],
      );
      await setup.end();

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

      // PR-A1a-4 §4 sweep — portalJwt carries the 2 portal scopes that
      // the now-guarded GET /v1/portal/profile and GET /v1/portal/consent
      // routes require (PR-A1a-2 prepared this token; PR-A1a-4 enables
      // the guards). The candidate role catalog carries both
      // (libs/identity/prisma/seed.ts). recruiterJwt below stays scopes:[]
      // — it is the deliberate-negative token for the 403 cases. Under the
      // PR-A1a-4 Ruling 1 superset envelope, the rejection is now from
      // RolesGuard (missing scope, details:{required_scopes, missing_scopes})
      // because the guard runs structurally before the controller-body
      // consumer_type check (which would have produced details:{consumer_type}).
      // Both paths are valid 403 INSUFFICIENT_PERMISSIONS; these tests
      // assert only the status code + error.code, which both paths satisfy.
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

      recruiterJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
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

      // PR-A1b §4 — the distinct-from-authz JWT: carries both portal
      // scopes (would pass RolesGuard) but is bound to UNENTITLED_TENANT_ID
      // (which has NO `portal` capability row). EntitlementGuard runs
      // before RolesGuard and rejects on the tenant axis.
      portalScopedUnentitledTenantJwt = await new SignJWT({
        sub: PORTAL_TALENT_ID,
        consumer_type: 'portal',
        actor_kind: 'user',
        tenant_id: UNENTITLED_TENANT_ID,
        scopes: ['portal:profile:read', 'portal:consent:read'],
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

    // A well-formed record id NOT reachable through the chain (uniform-404).
    const UNKNOWN_RECORD_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
    const PORTAL_PROFILE_KEYS = new Set([
      'talent_id',
      'tenant_id',
      'tenant_status',
      'source_channel',
      'created_at',
    ]);

    it('GET /v1/portal/records — 200: OPEN-4 chain resolves husk→survivor + cross-tenant; R10 absence + closed envelope', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/portal/records`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${portalJwt}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: Record<string, unknown>[] };
      // (A)+(B): per-field R10 + Match-class absence (recursive over the envelope).
      assertNoR10OrMatchClass(body, '/v1/portal/records.response');
      // Closed envelope.
      expect(new Set(Object.keys(body))).toEqual(new Set(['records']));
      // TWO records: tenant A (resolved through a husk→survivor) + tenant B (the
      // same cluster in a second tenant). Cross-tenant + husk-following, proven.
      expect(body.records).toHaveLength(2);
      const talentIds = body.records.map((r) => r.talent_id).sort();
      expect(talentIds).toEqual([PORTAL_TALENT_ID, RECORD_B_ID].sort());
      const tenantIds = new Set(body.records.map((r) => r.tenant_id));
      expect(tenantIds).toEqual(new Set([TENANT_ID, TENANT_B_ID]));
      for (const rec of body.records) {
        expect(new Set(Object.keys(rec))).toEqual(PORTAL_PROFILE_KEYS);
        expect(rec).not.toHaveProperty('source_recruiter_id');
      }
    });

    it('GET /v1/portal/records/:id/profile — 200 for an in-chain record; R10 absence + closed key set', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/portal/records/${PORTAL_TALENT_ID}/profile`,
        { method: 'GET', headers: { Authorization: `Bearer ${portalJwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      assertNoR10OrMatchClass(body, '/v1/portal/records/:id/profile.response');
      expect(new Set(Object.keys(body))).toEqual(PORTAL_PROFILE_KEYS);
      expect(body).not.toHaveProperty('source_recruiter_id');
    });

    it('GET /v1/portal/records/:id/consent — 200 for an in-chain record; R10 absence + closed envelope', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/portal/records/${PORTAL_TALENT_ID}/consent`,
        { method: 'GET', headers: { Authorization: `Bearer ${portalJwt}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      assertNoR10OrMatchClass(body, '/v1/portal/records/:id/consent.response');
      expect(new Set(Object.keys(body))).toEqual(
        new Set(['talent_record_id', 'tenant_id', 'is_anonymized', 'computed_at', 'scopes']),
      );
    });

    it('GET /v1/portal/records/:id/profile — uniform 404 for a record NOT in the caller chain', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/portal/records/${UNKNOWN_RECORD_ID}/profile`,
        { method: 'GET', headers: { Authorization: `Bearer ${portalJwt}` } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('GET /v1/portal/records/:id/consent — uniform 404 for a record NOT in the caller chain', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/portal/records/${UNKNOWN_RECORD_ID}/consent`,
        { method: 'GET', headers: { Authorization: `Bearer ${portalJwt}` } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('GET /v1/portal/records — 403 INSUFFICIENT_PERMISSIONS with a recruiter JWT (D)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/portal/records`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('GET /v1/portal/records — 401 when unauthenticated (D)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/portal/records`, {
        method: 'GET',
        headers: { Authorization: 'Bearer not-a-jwt' },
      });
      expect(res.status).toBe(401);
    });

    // PR-A1b §4 — entitlement is a DISTINCT AXIS from authorization: a token with
    // the full portal scope set but bound to a tenant WITHOUT the `portal`
    // capability is rejected with TENANT_CAPABILITY_NOT_ENTITLED before any chain.
    it('GET /v1/portal/records — 403 TENANT_CAPABILITY_NOT_ENTITLED when scoped user is in unentitled tenant (Ruling 1)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/portal/records`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${portalScopedUnentitledTenantJwt}` },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; details?: { tenant_id?: string; missing_capabilities?: string[] } };
      };
      expect(body.error.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
      expect(body.error.details?.tenant_id).toBe(UNENTITLED_TENANT_ID);
      expect(body.error.details?.missing_capabilities).toEqual(['portal']);
    });
  },
);
