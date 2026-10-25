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
  ARAMO_POSTGRES_TEST_IMAGE,
  AramoExceptionFilter,
  CommonModule,
  RequestIdMiddleware,
  ENTITLEMENT_PROVENANCE_MIGRATION,
  resolveIdentityMigrations,
} from '@aramo/common';
import { AuthModule, EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  IdentityCoreModule,
  PrismaService as IdentityPrismaService,
} from '@aramo/identity';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformController } from '../app/platform/platform.controller.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import { TenantPolicyProvisioningService } from '../app/platform/tenant-policy-provisioning.service.js';

import { ConfigurableAuthzResolver } from './support/configurable-authz-resolver.js';
import { generateTestKeyPair } from './test-keys.js';

// PLATFORM-UX-1 B-1a (directive R-6 / §5) — GET /platform/me HTTP integration
// spec (real Postgres 17 testcontainer). Proves, end-to-end through the real
// JwtAuthGuard + RolesGuard + the controller's tier tripwire:
//   - a platform token with platform:tenant:read → 200 with the CALLER's own
//     identity (user_id = sub, email, display_name, tenant_id, tenant_name,
//     role_keys) and nothing about any other principal (a second seeded
//     operator in the same tenant is never returned);
//   - a platform token without platform:tenant:read → 403;
//   - a non-platform consumer token → 403 INSUFFICIENT_PERMISSIONS (the tier
//     tripwire; the guard answers tenant_token_on_platform_route first);
//   - a token whose sub has no membership in its tenant → 404.
// Docker-gated (ARAMO_RUN_INTEGRATION); apps/platform-admin runs in the CI
// tests-integration job, so this is CI-enforced.

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

const SUPER_ADMIN_ROLE_ID = '01900000-0000-7000-8000-00000000001d';

async function signJwt(args: {
  privatePem: string;
  audience: string;
  sub: string;
  scopes: string[];
  consumer_type?: string;
  tenant_id?: string;
}): Promise<string> {
  const key = await importPKCS8(args.privatePem, 'RS256');
  const tenant_id = args.tenant_id ?? PLATFORM_TENANT_SENTINEL_ID;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    consumer_type: args.consumer_type ?? 'platform',
    actor_kind: 'user',
    tenant_id,
    authz_version: __authzResolver.grant(tenant_id, args.sub, args.scopes),
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer('Aramo Core Auth')
    .setAudience(args.audience)
    .setSubject(args.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(key);
}

// HF-AUTH-1 — MODE A resolver: each token declares its scopes via grant().
const __authzResolver = new ConfigurableAuthzResolver();

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'apps/platform-admin — GET /platform/me caller-only identity (real Postgres)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    let identityPrisma: IdentityPrismaService;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    const audience = 'aramo-platform-test';
    let privatePem: string;
    let publicPem: string;
    const CALLER_USER_ID = uuidv7();
    const OTHER_USER_ID = uuidv7();
    const NO_MEMBERSHIP_USER_ID = uuidv7();

    async function seedOperator(p: IdentityPrismaService, args: {
      id: string;
      email: string;
      display_name: string | null;
    }): Promise<void> {
      await p.user.create({
        data: {
          id: args.id,
          email: args.email,
          display_name: args.display_name,
          is_active: true,
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        },
      });
      const membership_id = uuidv7();
      await p.userTenantMembership.create({
        data: {
          id: membership_id,
          user_id: args.id,
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
          is_active: true,
        },
      });
      await p.userTenantMembershipRole.create({
        data: { id: uuidv7(), membership_id, role_id: SUPER_ADMIN_ROLE_ID },
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();

      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      const identityStatements = resolveIdentityMigrations(
        resolve(__dirname, '../../../..'),
      ).flatMap((sqlPath) => splitDdl(readFileSync(sqlPath, 'utf8')));
      for (const stmt of [...identityStatements, ...ENTITLEMENT_DDL_STATEMENTS, ...splitDdl(readFileSync(resolve(__dirname, '../../../..', ENTITLEMENT_PROVENANCE_MIGRATION), 'utf8'))]) {
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

      await identityPrisma.tenant.create({
        data: {
          id: PLATFORM_TENANT_SENTINEL_ID,
          name: 'Aramo Platform',
          is_active: true,
          status: 'ACTIVE',
        },
      });
      // The role row may already be seeded by the identity migrations; upsert
      // keeps the spec independent of that.
      await identityPrisma.role.upsert({
        where: { id: SUPER_ADMIN_ROLE_ID },
        update: {},
        create: {
          id: SUPER_ADMIN_ROLE_ID,
          key: 'super_admin',
          description: 'Platform Super Admin',
          is_active: true,
        },
      });
      await seedOperator(identityPrisma, {
        id: CALLER_USER_ID,
        email: 'caller@aramo.ai',
        display_name: 'Caller Operator',
      });
      // A second operator in the SAME tenant: must never surface for the caller.
      await seedOperator(identityPrisma, {
        id: OTHER_USER_ID,
        email: 'other@aramo.ai',
        display_name: 'Other Operator',
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
          {
            provide: TenantPolicyProvisioningService,
            useValue: { publishDefaultLifecyclePackage: async () => undefined },
          },
          CognitoAdminService,
          { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: __authzResolver },
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
      await app?.close();
      await identityPrisma?.$disconnect();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 30_000);

    const server = (): ReturnType<INestApplication['getHttpServer']> =>
      app.getHttpServer();

    it("platform token with platform:tenant:read → 200 with the caller's own identity only", async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: CALLER_USER_ID,
        scopes: READ_ONLY_SCOPES,
      });
      const res = await request(server())
        .get('/platform/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user_id: CALLER_USER_ID,
        email: 'caller@aramo.ai',
        display_name: 'Caller Operator',
        tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        tenant_name: 'Aramo Platform',
        role_keys: ['super_admin'],
      });
      // No other principal: the second operator in the same tenant is absent.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(OTHER_USER_ID);
      expect(raw).not.toContain('other@aramo.ai');
    });

    it('the other operator reads their own identity, never the caller (no cross-principal read)', async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: OTHER_USER_ID,
        scopes: READ_ONLY_SCOPES,
      });
      const res = await request(server())
        .get('/platform/me')
        // A query value is ignored: there is no principal selector on this route.
        .query({ user_id: CALLER_USER_ID })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.user_id).toBe(OTHER_USER_ID);
      expect(res.body.email).toBe('other@aramo.ai');
      expect(JSON.stringify(res.body)).not.toContain(CALLER_USER_ID);
    });

    it('platform token missing platform:tenant:read → 403', async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: CALLER_USER_ID,
        scopes: NON_READ_SCOPES,
      });
      const res = await request(server())
        .get('/platform/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // The tier tripwire refuses a tenant-tier token at the shared JwtAuthGuard
    // (reason tenant_token_on_platform_route) before the controller's own
    // consumer_type check (reason tier_mismatch, proven in
    // platform.controller.spec.ts) is reached — two layers, same 403.
    it('non-platform consumer token → 403 tier refusal', async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: CALLER_USER_ID,
        consumer_type: 'recruiter',
        scopes: READ_ONLY_SCOPES,
      });
      const res = await request(server())
        .get('/platform/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(res.body?.error?.details?.reason).toBe('tenant_token_on_platform_route');
      expect(JSON.stringify(res.body)).not.toContain('caller@aramo.ai');
    });

    it('a sub with no membership in its tenant → 404', async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: NO_MEMBERSHIP_USER_ID,
        scopes: READ_ONLY_SCOPES,
      });
      const res = await request(server())
        .get('/platform/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body?.error?.code).toBe('NOT_FOUND');
    });

    it('no request input can select another principal: no path param exists', async () => {
      const token = await signJwt({
        privatePem,
        audience,
        sub: CALLER_USER_ID,
        scopes: READ_ONLY_SCOPES,
      });
      const res = await request(server())
        .get(`/platform/me/${OTHER_USER_ID}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('other@aramo.ai');
    });
  },
);
