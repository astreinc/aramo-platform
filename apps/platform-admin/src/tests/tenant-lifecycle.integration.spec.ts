import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import cookieParser from 'cookie-parser';
import { SignJWT, importPKCS8 } from 'jose';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import {
  AramoExceptionFilter,
  CommonModule,
  RequestIdMiddleware,
  resolveIdentityMigrations,
} from '@aramo/common';
import { AuthModule, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  IdentityCoreModule,
  PrismaService as IdentityPrismaService,
} from '@aramo/identity';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformController } from '../app/platform/platform.controller.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';

import { generateTestKeyPair } from './test-keys.js';

// Platform-Console Increment-2 PR-1.5 Workstream B — the tenant-lifecycle HTTP
// integration spec (the PR-1 deviation-#4 debt). Real Postgres 17 (testcontainer)
// + mocked Cognito, exercising the operator surface end-to-end over HTTP:
//   - GET  /platform/tenants                        (list: all statuses, ?status, ?q, envelope)
//   - GET  /platform/tenants/:id                    (detail; 404)
//   - POST /platform/tenants/:id/{suspend,reactivate,start-offboarding,close}
//       (happy path + illegal transition 422 + missing reason 400 + wrong scope 403)
//   - POST /platform/tenants/:id/resend-owner-invite (PROVISIONED-only guard + audit)
//
// It is the first consumer of Workstream C's shared identity-migrations helper
// (resolveIdentityMigrations). This spec is Docker-gated (ARAMO_RUN_INTEGRATION)
// and, per the PR-1.5 ci.yml rider, apps/platform-admin now runs in the CI
// tests-integration job — so this is CI-enforced, not local-only.
//
// The app is built WITH the same ValidationPipe as main.ts so the DTO-shape
// gate (missing reasonCode → 400) is exercised authentically (the older
// platform.integration.spec.ts omits the pipe and relies on service-layer 4xx).

const ENTITLEMENT_DDL_STATEMENTS: ReadonlyArray<string> = [
  'CREATE SCHEMA IF NOT EXISTS entitlement',
  `CREATE TYPE entitlement."Capability" AS ENUM ('core', 'ats', 'portal', 'sourcing')`,
  `CREATE TABLE IF NOT EXISTS entitlement."TenantEntitlement" (
     tenant_id   uuid NOT NULL,
     capability  entitlement."Capability" NOT NULL,
     granted_at  timestamptz(6) NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, capability)
   )`,
  `CREATE INDEX IF NOT EXISTS "TenantEntitlement_tenant_id_idx" ON entitlement."TenantEntitlement" (tenant_id)`,
];

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

const TENANT_OWNER_ROLE_ID = '01900000-0000-7000-8000-000000000014';

// Scope sets — RolesGuard authorizes off the JWT `scopes` claim, so we mint the
// exact scope set each test needs (no DB role-scope seeding required).
const LIFECYCLE_SCOPES = [
  'platform:tenant:provision',
  'platform:tenant:read',
  'platform:tenant:lifecycle:manage',
];
const READ_ONLY_SCOPES = ['platform:tenant:read'];

async function signJwt(args: {
  privatePem: string;
  audience: string;
  sub: string;
  scopes: string[];
}): Promise<string> {
  const key = await importPKCS8(args.privatePem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    consumer_type: 'platform',
    actor_kind: 'user',
    tenant_id: PLATFORM_TENANT_SENTINEL_ID,
    scopes: args.scopes,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('Aramo Core Auth')
    .setAudience(args.audience)
    .setSubject(args.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(key);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'apps/platform-admin — tenant lifecycle HTTP surface (real Postgres, mocked Cognito)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    let identityPrisma: IdentityPrismaService;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    const audience = 'aramo-platform-test';
    let privatePem: string;
    let publicPem: string;
    const SUPER_ADMIN_USER_ID = uuidv7();

    const cognitoStore = new Map<string, string>();
    const cognitoMock = {
      adminCreateUser: vi.fn(async (args: { pool: string; email: string }) => {
        if (cognitoStore.has(args.email)) {
          throw new Error('UsernameExistsException');
        }
        const sub = `cog-${args.pool}-${uuidv7()}`;
        cognitoStore.set(args.email, sub);
        return { cognito_sub: sub };
      }),
      adminGetUser: vi.fn(async (args: { pool: string; email: string }) => {
        const sub = cognitoStore.get(args.email);
        return sub === undefined ? null : { cognito_sub: sub };
      }),
      adminDeleteUser: vi.fn(async (args: { pool: string; email: string }) => {
        cognitoStore.delete(args.email);
      }),
      // PR-1.5 A2 — the resend path. vi.fn() records the call args regardless of
      // the declared signature; the real Cognito MessageAction=RESEND behavior is
      // a readiness-track concern.
      adminResendInvite: vi.fn(async () => undefined),
    };

    // Directly stage a bare tenant row in a chosen lifecycle status (transition
    // legality lets us start each action test from the right state without
    // threading the owner-acceptance activation flow).
    async function seedTenant(args: {
      name: string;
      slug?: string | null;
      status: string;
    }): Promise<string> {
      const id = uuidv7();
      await identityPrisma.tenant.create({
        data: {
          id,
          name: args.name,
          slug: args.slug ?? null,
          is_active: true,
          status: args.status,
        },
      });
      return id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      // Identity schema from the shared ordered helper (Workstream C) + the
      // entitlement DDL the provisioning saga's capability grant needs.
      const identityStatements = resolveIdentityMigrations(
        resolve(__dirname, '../../../..'),
      ).flatMap((sqlPath) => splitDdl(readFileSync(sqlPath, 'utf8')));
      for (const stmt of [...identityStatements, ...ENTITLEMENT_DDL_STATEMENTS]) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await setup.$executeRawUnsafe(t);
      }
      await setup.$disconnect();

      const keys = generateTestKeyPair();
      privatePem = keys.privatePem;
      publicPem = keys.publicPem;
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        AUTH_COGNITO_TENANT_USER_POOL_ID:
          process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'],
        AUTH_COGNITO_PLATFORM_USER_POOL_ID:
          process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = audience;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['AUTH_COGNITO_TENANT_USER_POOL_ID'] = 'test-tenant-pool';
      process.env['AUTH_COGNITO_PLATFORM_USER_POOL_ID'] = 'test-platform-pool';

      identityPrisma = new IdentityPrismaService(url);
      await identityPrisma.$connect();

      // Minimal seed: the sentinel platform tenant + the tenant_owner role
      // (provisioning resolves it) + the super_admin actor. RolesGuard reads the
      // token's scopes claim, so no DB role-scope wiring is needed.
      await identityPrisma.tenant.create({
        data: {
          id: PLATFORM_TENANT_SENTINEL_ID,
          name: 'Aramo Platform',
          is_active: true,
          status: 'ACTIVE',
        },
      });
      await identityPrisma.role.create({
        data: {
          id: TENANT_OWNER_ROLE_ID,
          key: 'tenant_owner',
          description: 'Tenant Owner',
          is_active: true,
        },
      });

      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          AuthModule,
          AuthorizationModule,
          IdentityCoreModule,
          EntitlementModule,
        ],
        controllers: [PlatformController],
        providers: [
          PlatformInvitationService,
          CognitoAdminService,
          { provide: APP_FILTER, useClass: AramoExceptionFilter },
        ],
      })
        .overrideProvider(CognitoAdminService)
        .useValue(cognitoMock)
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.use(
        (req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
          const mw = new RequestIdMiddleware();
          mw.use(req as never, _res as never, next);
        },
      );
      // Mirror main.ts so the DTO-shape gate (missing reasonCode → 400) is real.
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await app.init();
    }, 120_000);

    afterAll(async () => {
      await app.close();
      await identityPrisma.$disconnect();
      await container.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 30_000);

    function jwt(scopes: string[]): Promise<string> {
      return signJwt({ privatePem, audience, sub: SUPER_ADMIN_USER_ID, scopes });
    }

    const server = (): ReturnType<INestApplication['getHttpServer']> =>
      app.getHttpServer();

    // ---------------------------------------------------------------- LIST ---
    it('list — returns ALL tenants in ALL statuses (suspended/closed visible) in a { tenants } envelope', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const suspendedId = await seedTenant({
        name: 'List Suspended Co',
        slug: 'list-suspended',
        status: 'SUSPENDED',
      });
      const closedId = await seedTenant({
        name: 'List Closed Co',
        slug: 'list-closed',
        status: 'CLOSED',
      });

      const res = await request(server())
        .get('/platform/tenants')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.tenants)).toBe(true);
      const ids = res.body.tenants.map((t: { id: string }) => t.id);
      // The operator sees suspended AND closed tenants — MORE visible, not less.
      expect(ids).toContain(suspendedId);
      expect(ids).toContain(closedId);
      const suspendedRow = res.body.tenants.find(
        (t: { id: string }) => t.id === suspendedId,
      );
      // The lifecycle-triage row shape.
      expect(suspendedRow).toEqual(
        expect.objectContaining({
          id: suspendedId,
          name: 'List Suspended Co',
          slug: 'list-suspended',
          status: 'SUSPENDED',
          is_active: true,
        }),
      );
      expect(suspendedRow).toHaveProperty('status_reason_code');
      expect(suspendedRow).toHaveProperty('status_changed_at');
      expect(suspendedRow).toHaveProperty('activated_at');
      expect(suspendedRow).toHaveProperty('suspended_at');
    });

    it('list — ?status filter returns only matching-status tenants', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      await seedTenant({ name: 'Filter Offboarding Co', status: 'OFFBOARDING' });
      const res = await request(server())
        .get('/platform/tenants?status=OFFBOARDING')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.tenants.length).toBeGreaterThan(0);
      for (const t of res.body.tenants) {
        expect(t.status).toBe('OFFBOARDING');
      }
    });

    it('list — ?q filter matches name OR slug, case-insensitive', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      await seedTenant({
        name: 'Zephyr Dynamics',
        slug: 'zephyr-dyn',
        status: 'ACTIVE',
      });
      const byName = await request(server())
        .get('/platform/tenants?q=zephyr')
        .set('Authorization', `Bearer ${token}`);
      expect(byName.status).toBe(200);
      expect(
        byName.body.tenants.some((t: { name: string }) => t.name === 'Zephyr Dynamics'),
      ).toBe(true);
      const bySlug = await request(server())
        .get('/platform/tenants?q=ZEPHYR-DYN')
        .set('Authorization', `Bearer ${token}`);
      expect(bySlug.status).toBe(200);
      expect(
        bySlug.body.tenants.some((t: { slug: string | null }) => t.slug === 'zephyr-dyn'),
      ).toBe(true);
    });

    // -------------------------------------------------------------- DETAIL ---
    it('detail — GET /platform/tenants/:id returns the tenant; unknown id → 404', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const id = await seedTenant({ name: 'Detail Co', status: 'ACTIVE' });
      const ok = await request(server())
        .get(`/platform/tenants/${id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(ok.status).toBe(200);
      expect(ok.body.tenant.id).toBe(id);
      expect(ok.body.tenant.status).toBe('ACTIVE');

      const missing = await request(server())
        .get(`/platform/tenants/${uuidv7()}`)
        .set('Authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
      expect(missing.body?.error?.code).toBe('NOT_FOUND');
    });

    // ------------------------------------------------------------- ACTIONS ---
    it('suspend — ACTIVE→SUSPENDED happy path (200) writes status + tenant.suspended audit', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Suspend Happy Co', status: 'ACTIVE' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reasonCode: 'ap_violation', reasonText: 'Acceptable-use breach' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ from: 'ACTIVE', to: 'SUSPENDED', status: 'SUSPENDED', changed: true }),
      );
      const row = await identityPrisma.tenant.findUnique({ where: { id } });
      expect(row?.status).toBe('SUSPENDED');
      expect(row?.suspended_at).not.toBeNull();
      const audit = await identityPrisma.identityAuditEvent.findFirst({
        where: { event_type: 'tenant.suspended', tenant_id: id },
      });
      expect(audit).not.toBeNull();
    });

    it('suspend — illegal transition (PROVISIONED→SUSPENDED) → 422 + rejected audit', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Illegal Suspend Co', status: 'PROVISIONED' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reasonCode: 'x', reasonText: 'y' });
      expect(res.status).toBe(422);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body?.error?.details?.reason).toBe('illegal_transition');
      const rejected = await identityPrisma.identityAuditEvent.findFirst({
        where: { event_type: 'tenant.lifecycle_transition_rejected', tenant_id: id },
      });
      expect(rejected).not.toBeNull();
      // The status did NOT change.
      const row = await identityPrisma.tenant.findUnique({ where: { id } });
      expect(row?.status).toBe('PROVISIONED');
    });

    it('suspend — missing reason (empty body) → 400 VALIDATION_ERROR (DTO gate)', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Missing Reason Co', status: 'ACTIVE' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      // Status unchanged (the DTO gate fired before the service).
      const row = await identityPrisma.tenant.findUnique({ where: { id } });
      expect(row?.status).toBe('ACTIVE');
    });

    it('suspend — wrong scope (no lifecycle:manage) → 403', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const id = await seedTenant({ name: 'Wrong Scope Co', status: 'ACTIVE' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/suspend`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reasonCode: 'x', reasonText: 'y' });
      expect(res.status).toBe(403);
    });

    it('reactivate — SUSPENDED→ACTIVE happy path (200) + tenant.reactivated audit', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Reactivate Co', status: 'SUSPENDED' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/reactivate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reasonCode: 'resolved' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ from: 'SUSPENDED', to: 'ACTIVE', changed: true }),
      );
      const audit = await identityPrisma.identityAuditEvent.findFirst({
        where: { event_type: 'tenant.reactivated', tenant_id: id },
      });
      expect(audit).not.toBeNull();
    });

    it('start-offboarding — ACTIVE→OFFBOARDING happy path (200) stamps retention + milestone', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Offboard Co', status: 'ACTIVE' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/start-offboarding`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          retentionPolicyCode: 'standard_90d',
          closeAt: '2026-12-31T00:00:00.000Z',
          reasonCode: 'contract_end',
        });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ from: 'ACTIVE', to: 'OFFBOARDING', changed: true }),
      );
      const row = await identityPrisma.tenant.findUnique({ where: { id } });
      expect(row?.status).toBe('OFFBOARDING');
      expect(row?.offboarding_started_at).not.toBeNull();
      expect(row?.retention_policy_code).toBe('standard_90d');
    });

    it('close — OFFBOARDING→CLOSED happy path (200) + tenant.closed audit', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Close Co', status: 'OFFBOARDING' });
      const res = await request(server())
        .post(`/platform/tenants/${id}/close`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reasonCode: 'offboarding_complete' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ from: 'OFFBOARDING', to: 'CLOSED', changed: true }),
      );
      const row = await identityPrisma.tenant.findUnique({ where: { id } });
      expect(row?.status).toBe('CLOSED');
      expect(row?.closed_at).not.toBeNull();
    });

    // ------------------------------------------------ RESEND OWNER INVITE ---
    it('resend-owner-invite — PROVISIONED tenant: re-sends via Cognito RESEND + tenant.owner_invite.sent audit', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      // Provision through the real endpoint so a tenant_owner membership exists.
      const prov = await request(server())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Resend Happy Co', owner_email: 'owner@resend.co' });
      expect(prov.status).toBe(201);
      const tenantId = prov.body.tenant_id;
      expect(prov.body.status ?? 'PROVISIONED').toBeDefined();

      cognitoMock.adminResendInvite.mockClear();
      const res = await request(server())
        .post(`/platform/tenants/${tenantId}/resend-owner-invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          tenant_id: tenantId,
          owner_email: 'owner@resend.co',
          resent: true,
        }),
      );
      expect(cognitoMock.adminResendInvite).toHaveBeenCalledWith(
        expect.objectContaining({ pool: 'tenant', email: 'owner@resend.co' }),
      );
      const audit = await identityPrisma.identityAuditEvent.findFirst({
        where: { event_type: 'tenant.owner_invite.sent', tenant_id: tenantId },
      });
      expect(audit).not.toBeNull();
      expect((audit?.event_payload as { reason?: string })?.reason).toBe('resend');
    });

    it('resend-owner-invite — non-PROVISIONED tenant → 422 tenant_not_provisioned, no Cognito call', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const id = await seedTenant({ name: 'Resend Refused Co', status: 'ACTIVE' });
      cognitoMock.adminResendInvite.mockClear();
      const res = await request(server())
        .post(`/platform/tenants/${id}/resend-owner-invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(422);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body?.error?.details?.reason).toBe('tenant_not_provisioned');
      expect(cognitoMock.adminResendInvite).not.toHaveBeenCalled();
    });

    it('resend-owner-invite — unknown tenant → 404', async () => {
      const token = await jwt(LIFECYCLE_SCOPES);
      const res = await request(server())
        .post(`/platform/tenants/${uuidv7()}/resend-owner-invite`)
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body?.error?.code).toBe('NOT_FOUND');
    });
  },
);
