import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, resolveEntitlementMigrations } from '@aramo/common';
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
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { applyTalentRecordMigrations } from './talent-record-fixtures.js';

// Portal P1 PR-2a — Portal records + R10 negative-shape integration test
// (extends the M3 PR-9 F23 negative-shape spec onto the records surface).
//
// ATI-SEP-1 T10 WP4 — Addendum A4 (Talent Portal identity deferred; gap
// GAP-PORTAL-ID-1): the legacy OPEN-4 chain (PortalUser.cluster_id → trust-ledger
// subjects → ATS refs) is retired with the talent_trust / identity_index schemas,
// so a portal session resolves NO talent. End-to-end (boots AppModule against a
// Postgres testcontainer):
//   1. Provision consent + ingestion + examination + job-domain + entitlement +
//      identity.Tenant + talent_record + portal_identity migrations (no trust).
//   2. Sign portal / recruiter / unentitled-tenant JWTs (+ an unauthenticated
//      case). The portal JWT sub = PortalUser.id (its cluster_id is INERT).
//   3. Every /v1/portal records + consent route — the list, per-record reads of a
//      REAL TalentRecord id, an unknown id, a malformed id, consent grant /
//      revoke — answers ONE uniform, non-leaking 404 NOT_AVAILABLE, with no
//      R10 / Match-class leak in the error body.
//   4. Recruiter JWT → 403 INSUFFICIENT_PERMISSIONS; unauthenticated → 401;
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
// PR-A1b §4 sweep — portal routes are now class-level @RequireCapability('portal');
// the integration boot must have the entitlement schema available so the
// tenant-axis gate can be exercised (both pass and deliberate-failure paths).
// CCP-A7 — the full entitlement set (the shared helper; the repository reads A7 columns).
const ENTITLEMENT_MIGRATIONS = resolveEntitlementMigrations(ROOT);
// Portal P2 P2b — the portal reads now enrich tenant_name via TenantService
// (@aramo/identity), so the identity.Tenant table must exist + carry every
// column the regenerated Tenant client SELECTs. Same Tenant-relevant subset the
// settings-d3 tenant-profile spec applies (init + the additive Tenant ALTERs;
// the site/team tables Tenant findUnique does not need are skipped).
const IDENTITY_TENANT_MIGRATIONS = [
  '20260512000000_init_identity_model',
  '20260625000000_add_tenant_allowed_domain',
  '20260626000000_add_tenant_domain_verification',
  '20260626120000_add_tenant_slug',
  '20260627000000_add_tenant_identity_provider',
  '20260709130000_add_tenant_lifecycle_status',
  '20260624000000_add_invitation_and_invite_status',
  '20260619000000_add_tenant_profile',
  // IC-4 PR-9 — Tenant.kind (additive, defaulted); the client SELECTs it on every Tenant read.
  '20261015000002_ic4_tenant_kind',
].map((n) => resolve(ROOT, `libs/identity/prisma/migrations/${n}/migration.sql`));
// Portal P1 PR-2a — portal_identity (PortalUser) for the portal session's sub.
const PORTAL_IDENTITY_MIGRATION = resolve(
  ROOT,
  'libs/portal-identity/prisma/migrations/20260714120000_init_portal_identity/migration.sql',
);

// An INERT legacy cluster pointer on the PortalUser (A4 §3 — kept, never read).
const CLUSTER_ID = 'cccccccc-cccc-7ccc-8ccc-ccccccccc111';
// A second tenant's live record — never reachable from the portal session.
const TENANT_B_ID = '33333333-3333-7333-8333-333333333333';
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

const __authzTestResolver = new ConfigurableTestResolver();

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Portal records — A4 identity-deferred uniform 404 + R10 negative-shape verification (end-to-end)',
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
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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
        ...ENTITLEMENT_MIGRATIONS,
        // Portal P2 P2b — identity.Tenant for the tenant_name enrichment read.
        ...IDENTITY_TENANT_MIGRATIONS,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }
      // 4e-rest-b — the portal profile re-homed onto TalentRecord; apply the
      // talent_record schema so the re-pointed portal fixture (a TalentRecord
      // row) is readable by findSelfProfile.
      await applyTalentRecordMigrations(setup);

      // Portal P1 PR-2a — the portal identity schema (PortalUser).
      await setup.query(readFileSync(PORTAL_IDENTITY_MIGRATION, 'utf8'));

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

      // Portal P2 P2b — seed the two selection tenants so the tenant_name
      // enrichment (TenantService.getTenantById) resolves a human name. Only
      // id/name/updated_at are NOT-NULL-without-default on identity.Tenant.
      await setup.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at)
         VALUES ($1::uuid, 'Acme Corp', NOW()), ($2::uuid, 'Globex', NOW())
         ON CONFLICT DO NOTHING`,
        [TENANT_ID, TENANT_B_ID],
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

      // TENANT B — a distinct live record (never reachable from the portal session).
      await setup.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, tenant_status, source_channel,
            created_at, updated_at)
         VALUES ($1, $2, 'Portal', 'TalentB', 'active', 'self_signup', NOW(), NOW())`,
        [RECORD_B_ID, TENANT_B_ID],
      );
      // The PortalUser (id = JWT sub) with an INERT legacy cluster_id (A4 §3).
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
        authz_version: __authzTestResolver.grant(TENANT_ID, PORTAL_TALENT_ID, [
          'portal:profile:read',
          'portal:consent:read',
          // Portal P2a — consent grant / revoke (the A4 uniform-404 proof reaches them).
          'portal:consent:write',
          // Portal P3a — verification view + dispute rights.
          'portal:verification:read',
          'portal:dispute:read',
          'portal:dispute:write',
        ]),
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
        authz_version: __authzTestResolver.grant(TENANT_ID, RECRUITER_ID, []),
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
        authz_version: __authzTestResolver.grant(UNENTITLED_TENANT_ID, PORTAL_TALENT_ID, ['portal:profile:read', 'portal:consent:read']),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      module = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .compile();

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

    // A well-formed record id that does not exist anywhere (uniform-404).
    const UNKNOWN_RECORD_ID = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
    const MALFORMED_RECORD_ID = 'not-a-uuid';
    const IDEM = 'cccccccc-cccc-7ccc-8ccc-cccccccccccb';
    const CONSENT_BODY = JSON.stringify({ scope: 'matching', consent_text_version: 'portal-consent-v1' });

    // ATI-SEP-1 T10 WP4 (A4, GAP-PORTAL-ID-1) — ONE uniform, non-leaking answer for
    // every records / consent route: the list, a REAL record id (in tenant A and in
    // tenant B), an unknown id and a malformed id — no format / existence /
    // membership oracle, and no R10 / Match-class field in the error body.
    const RECORD_ROUTES: Array<[string, string, string | undefined]> = [
      ['GET', '/v1/portal/records', undefined],
      ['GET', `/v1/portal/records/${PORTAL_TALENT_ID}/profile`, undefined],
      ['GET', `/v1/portal/records/${RECORD_B_ID}/profile`, undefined],
      ['GET', `/v1/portal/records/${UNKNOWN_RECORD_ID}/profile`, undefined],
      ['GET', `/v1/portal/records/${MALFORMED_RECORD_ID}/profile`, undefined],
      ['GET', `/v1/portal/records/${PORTAL_TALENT_ID}/consent`, undefined],
      ['GET', `/v1/portal/records/${UNKNOWN_RECORD_ID}/consent`, undefined],
      ['GET', `/v1/portal/records/${PORTAL_TALENT_ID}/consent/text`, undefined],
      ['GET', `/v1/portal/records/${PORTAL_TALENT_ID}/consent/history`, undefined],
      ['POST', `/v1/portal/records/${PORTAL_TALENT_ID}/consent/grant`, CONSENT_BODY],
      ['POST', `/v1/portal/records/${PORTAL_TALENT_ID}/consent/revoke`, CONSENT_BODY],
    ];

    it.each(RECORD_ROUTES)('%s %s — uniform 404 NOT_AVAILABLE (A4)', async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${portalJwt}`,
          'Idempotency-Key': IDEM,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } };
      assertNoR10OrMatchClass(json, `${path}.response`);
      expect(json.error.code).toBe('NOT_FOUND');
      expect(json.error.message).toBe('not available');
      expect(json.error.details).toEqual({ reason: 'NOT_AVAILABLE' });
    });

    it('a portal consent grant through the deferred surface writes NO consent event', async () => {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      try {
        const r = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM consent."TalentConsentEvent" WHERE talent_record_id = $1`,
          [PORTAL_TALENT_ID],
        );
        expect(r.rows[0]!.n).toBe(1); // only the seeded recruiter grant
      } finally {
        await c.end();
      }
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

    // ── Portal P3a verification view + dispute rights — ATI-SEP-1 T10 WP3b ──
    // Addendum A4 (Talent Portal identity deferred): the legacy trust-ledger
    // implementation is retired; every route answers ONE uniform 404
    // NOT_AVAILABLE for a portal caller (no body is parsed) until the portal
    // identity work re-points them to Talent Intelligence.
    const P3A_IDEM = 'cccccccc-cccc-7ccc-8ccc-ccccccccccca';
    const P3A_ROUTES: Array<[string, string, string | undefined]> = [
      ['GET', '/v1/portal/verifications', undefined],
      ['POST', '/v1/portal/disputes', JSON.stringify({ item_id: 'f'.repeat(64), statement: 'x' })],
      ['GET', '/v1/portal/disputes', undefined],
      ['GET', `/v1/portal/disputes/${UNKNOWN_RECORD_ID}`, undefined],
      ['POST', `/v1/portal/disputes/${UNKNOWN_RECORD_ID}/respond`, JSON.stringify({ statement: 'x' })],
      ['POST', `/v1/portal/disputes/${UNKNOWN_RECORD_ID}/withdraw`, undefined],
    ];

    it.each(P3A_ROUTES)('%s %s — uniform 404 NOT_AVAILABLE (A4)', async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${portalJwt}`,
          'Idempotency-Key': P3A_IDEM,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } };
      expect(json.error.code).toBe('NOT_FOUND');
      expect(json.error.details).toEqual({ reason: 'NOT_AVAILABLE' });
    });

    it('GET /v1/portal/verifications — still 403 for a recruiter JWT (the consumer check runs first)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/portal/verifications`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${recruiterJwt}` },
      });
      expect(res.status).toBe(403);
    });
  },
);
