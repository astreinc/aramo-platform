import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// Inc-3 PR-3.8 Workstream A — the operator dashboard endpoint HTTP integration
// spec (real Postgres 17 testcontainer). Drives GET /platform/dashboard end-to-
// end and asserts the three sections against a seeded estate:
//   - status_counts: correct across a seeded status spread; the SENTINEL is
//     excluded (ACTIVE count does NOT include it); a status with zero tenants
//     still reports 0 (zero-fill).
//   - onboarding: PROVISIONED only, oldest-first, with the audit-derived invited
//     flag (a tenant.owner_invite.sent probe).
//   - recent_activity: newest-first tenant.* events across ALL tenants, tenant
//     names resolved, reason code lifted from the payload.
// Plus the scope gate (missing platform:tenant:read → 403). Docker-gated
// (ARAMO_RUN_INTEGRATION); apps/platform-admin runs in the CI tests-integration
// job, so this is CI-enforced.

const ENTITLEMENT_DDL_STATEMENTS: ReadonlyArray<string> = [
  'CREATE SCHEMA IF NOT EXISTS entitlement',
  `CREATE TYPE entitlement."Capability" AS ENUM ('core', 'ats', 'portal', 'sourcing')`,
  `CREATE TABLE IF NOT EXISTS entitlement."TenantEntitlement" (
     tenant_id   uuid NOT NULL,
     capability  entitlement."Capability" NOT NULL,
     granted_at  timestamptz(6) NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, capability)
   )`,
];

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

const READ_ONLY_SCOPES = ['platform:tenant:read'];
const NON_READ_SCOPES = ['platform:tenant:provision'];

async function signJwt(args: {
  privatePem: string;
  audience: string;
  sub: string;
  scopes: string[];
}): Promise<string> {
  const key = await importPKCS8(args.privatePem, 'RS256');
  // Fixed iat/exp (the harness forbids argless Date.now via other tools, but a
  // spec runs under Node — still, pin the window explicitly for determinism).
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
  'apps/platform-admin — operator dashboard HTTP surface (real Postgres)',
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

    async function seedTenant(args: {
      name: string;
      status: string;
      created_at?: Date;
    }): Promise<string> {
      const id = uuidv7();
      await identityPrisma.tenant.create({
        data: {
          id,
          name: args.name,
          is_active: true,
          status: args.status,
          ...(args.created_at === undefined
            ? {}
            : { created_at: args.created_at }),
        },
      });
      return id;
    }

    async function seedAudit(args: {
      tenant_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: Date;
    }): Promise<void> {
      await identityPrisma.identityAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          actor_id: SUPER_ADMIN_USER_ID,
          actor_type: 'user',
          event_type: args.event_type,
          subject_id: args.tenant_id,
          event_payload: args.payload,
          created_at: args.created_at,
        },
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new IdentityPrismaService(url);
      await setup.$connect();
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
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = audience;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      identityPrisma = new IdentityPrismaService(url);
      await identityPrisma.$connect();

      // The sentinel platform tenant — ACTIVE, but infrastructure: it must NOT
      // count toward the ACTIVE estate.
      await identityPrisma.tenant.create({
        data: {
          id: PLATFORM_TENANT_SENTINEL_ID,
          name: 'Aramo Platform',
          is_active: true,
          status: 'ACTIVE',
        },
      });

      // Status spread (non-sentinel): 3 PROVISIONED, 2 ACTIVE, 1 SUSPENDED,
      // 1 CLOSED, 0 OFFBOARDING (to prove zero-fill).
      const oldest = new Date('2026-01-01T00:00:00.000Z');
      const mid = new Date('2026-03-01T00:00:00.000Z');
      const newest = new Date('2026-05-01T00:00:00.000Z');
      // PROVISIONED, seeded out of chronological order to prove the oldest-first sort.
      const provMid = await seedTenant({
        name: 'Onboarding Mid Co',
        status: 'PROVISIONED',
        created_at: mid,
      });
      const provOldest = await seedTenant({
        name: 'Onboarding Oldest Co',
        status: 'PROVISIONED',
        created_at: oldest,
      });
      const provNewest = await seedTenant({
        name: 'Onboarding Newest Co',
        status: 'PROVISIONED',
        created_at: newest,
      });
      await seedTenant({ name: 'Active One Co', status: 'ACTIVE' });
      const activeTwo = await seedTenant({ name: 'Active Two Co', status: 'ACTIVE' });
      const suspendedCo = await seedTenant({
        name: 'Suspended Co',
        status: 'SUSPENDED',
      });
      await seedTenant({ name: 'Closed Co', status: 'CLOSED' });

      // Invited-state: the OLDEST provisioned tenant has been invited; the other
      // two have not (not-yet-invited distinction).
      await seedAudit({
        tenant_id: provOldest,
        event_type: 'tenant.owner_invite.sent',
        payload: { reason: 'first_send' },
        created_at: new Date('2026-01-02T00:00:00.000Z'),
      });
      void provMid;
      void provNewest;

      // Recent activity across the estate (distinct created_at → deterministic
      // newest-first ordering). The suspend carries a reason.code; the invite a
      // string reason.
      await seedAudit({
        tenant_id: suspendedCo,
        event_type: 'tenant.suspended',
        payload: { reason: { code: 'ops_hold', text: 'ops review' } },
        created_at: new Date('2026-06-10T00:00:00.000Z'),
      });
      await seedAudit({
        tenant_id: activeTwo,
        event_type: 'tenant.activated',
        payload: { reason: { code: null, text: null } },
        created_at: new Date('2026-06-11T00:00:00.000Z'),
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
        .useValue({
          adminCreateUser: async () => ({ cognito_sub: 'x' }),
          adminGetUser: async () => null,
          adminDeleteUser: async () => undefined,
          adminResendInvite: async () => undefined,
        })
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.use(
        (req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
          const mw = new RequestIdMiddleware();
          mw.use(req as never, _res as never, next);
        },
      );
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

    it('status_counts — correct across the spread; sentinel excluded; zero-filled', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const res = await request(server())
        .get('/platform/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      const counts: { status: string; count: number }[] =
        res.body.status_counts;
      const by = new Map(counts.map((c) => [c.status, c.count]));
      // All five statuses present (zero-fill).
      expect([...by.keys()].sort()).toEqual(
        ['ACTIVE', 'CLOSED', 'OFFBOARDING', 'PROVISIONED', 'SUSPENDED'].sort(),
      );
      expect(by.get('PROVISIONED')).toBe(3);
      // The sentinel is ACTIVE too, but excluded — so ACTIVE is 2, not 3.
      expect(by.get('ACTIVE')).toBe(2);
      expect(by.get('SUSPENDED')).toBe(1);
      expect(by.get('CLOSED')).toBe(1);
      expect(by.get('OFFBOARDING')).toBe(0);
    });

    it('onboarding — PROVISIONED only, oldest-first, with the invited flag', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const res = await request(server())
        .get('/platform/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      const onboarding: {
        tenant_id: string;
        name: string;
        created_at: string;
        invited: boolean;
      }[] = res.body.onboarding;
      expect(onboarding.map((o) => o.name)).toEqual([
        'Onboarding Oldest Co',
        'Onboarding Mid Co',
        'Onboarding Newest Co',
      ]);
      // Only the oldest was invited.
      const oldest = onboarding[0];
      expect(oldest.invited).toBe(true);
      expect(onboarding[1].invited).toBe(false);
      expect(onboarding[2].invited).toBe(false);
    });

    it('recent_activity — newest-first across tenants, names + reason codes resolved', async () => {
      const token = await jwt(READ_ONLY_SCOPES);
      const res = await request(server())
        .get('/platform/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      const activity: {
        event_type: string;
        tenant_name: string | null;
        actor_type: string;
        reason_code: string | null;
        created_at: string;
      }[] = res.body.recent_activity;
      // At least the two lifecycle rows + the invite, newest-first.
      const first = activity[0];
      expect(first.event_type).toBe('tenant.activated');
      expect(first.tenant_name).toBe('Active Two Co');
      expect(first.actor_type).toBe('user');
      // A recent tenant.suspended with a reason.code.
      const suspend = activity.find((a) => a.event_type === 'tenant.suspended');
      expect(suspend?.tenant_name).toBe('Suspended Co');
      expect(suspend?.reason_code).toBe('ops_hold');
      // The invite's string reason surfaces as the reason_code.
      const invite = activity.find(
        (a) => a.event_type === 'tenant.owner_invite.sent',
      );
      expect(invite?.reason_code).toBe('first_send');
      // Descending by created_at.
      const times = activity.map((a) => Date.parse(a.created_at));
      expect(times).toEqual([...times].sort((x, y) => y - x));
    });

    it('scope gate — a platform token without platform:tenant:read is refused 403', async () => {
      const token = await jwt(NON_READ_SCOPES);
      const res = await request(server())
        .get('/platform/dashboard')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  },
);
