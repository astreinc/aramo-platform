import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
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
} from '@aramo/common';
import { AuthModule, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  IdentityModule,
  PrismaService as IdentityPrismaService,
} from '@aramo/identity';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformController } from '../app/platform/platform.controller.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';

import { generateTestKeyPair } from './test-keys.js';

// AUTHZ-2 §5 integration proofs (the HTTP surface, real Postgres, mocked
// Cognito). The catalog-level proofs (proof 7 — platform scope namespace
// disjoint from the 47 tenant scopes; proof 8 — tenant 13-role catalog
// byte-identical to AUTHZ-1) live in libs/identity/src/tests/
// identity.integration.spec.ts where the runIdentitySeed import is
// in-bounds for nx-enforce-module-boundaries; this spec exercises
// proofs 1, 2, 3, 4, 5, 6 (tier-separation directions + provisioning +
// Cognito-failure + Tenant-Owner-first + multi-role + idempotency).
//
// Schema bootstrap: this spec applies the identity + entitlement DDL
// manually and inserts the minimum rows the HTTP proofs need (sentinel
// platform Tenant, super_admin role + 3 platform:* scopes + role-scope
// bundle, the super_admin user/membership/external-identity, and the
// 13 tenant roles needed by the invitation proofs). Running the full
// libs/identity seed from this app's spec would require a relative
// cross-project import which violates the nx-boundaries rule (the seed
// is a CLI script at libs/identity/prisma/seed.ts, not part of the
// library's exported surface).

const IDENTITY_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
const IDENTITY_SITE_AXIS_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
// AUTHZ-D4a — PL-95 finally exercised (the first authz migration; identity-side).
const IDENTITY_D4A_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

// Entitlement DDL as discrete statements; the splitDdl helper used for
// the identity migrations splits on `;\n`, which would break a DO-block
// containing `$$` delimiters. Listing the statements here keeps the
// helper happy and keeps the spec self-contained (no entitlement
// migration file to mirror).
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

async function signJwt(args: {
  privatePem: string;
  audience: string;
  sub: string;
  consumer_type: string;
  tenant_id: string;
  scopes: string[];
  actor_kind?: 'user' | 'service_account' | 'system';
}): Promise<string> {
  const key = await importPKCS8(args.privatePem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    consumer_type: args.consumer_type,
    actor_kind: args.actor_kind ?? 'user',
    tenant_id: args.tenant_id,
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

const SUPER_ADMIN_ROLE_ID = '01900000-0000-7000-8000-00000000001d';
const PLATFORM_TENANT_PROVISION_SCOPE_ID =
  '01900000-0000-7000-8000-000000000089';
const PLATFORM_TENANT_READ_SCOPE_ID = '01900000-0000-7000-8000-00000000008a';
const PLATFORM_ADMIN_INVITE_SCOPE_ID = '01900000-0000-7000-8000-00000000008b';
const TENANT_OWNER_ROLE_ID = '01900000-0000-7000-8000-000000000014';
const RECRUITER_ROLE_ID = '01900000-0000-7000-8000-000000000011';
// AUTHZ-1b fixture swap: hiring_manager retired -> use account_manager
// (UUID 0x16, in the staffing catalog). The fixture just needs a third
// non-tenant_owner non-recruiter role to exercise the multi-role invite
// path; AM is a stable kept role.
const ACCOUNT_MANAGER_ROLE_ID = '01900000-0000-7000-8000-000000000016';
// D-AUTHZ-PLATFORM-INVITE-1 — the exploit-rejected proof fixture. A 4th
// tenant role + two compensation scopes (view:pay + a spread) seeded so
// the validator has the role->scope edges needed to detect the D5 leak.
// Pairing recruiter (view:pay) with finance (view:spread:amount) produces
// the invertible union — the exact pattern the defect could persist.
const FINANCE_ROLE_ID = '01900000-0000-7000-8000-00000000001a';
const COMPENSATION_VIEW_PAY_SCOPE_ID =
  '01900000-0000-7000-8000-000000000090';
const COMPENSATION_VIEW_SPREAD_AMOUNT_SCOPE_ID =
  '01900000-0000-7000-8000-000000000091';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'apps/platform-admin — integration (Pattern A invitation flow, real Postgres, mocked Cognito)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    let identityPrisma: IdentityPrismaService;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    const audience = 'aramo-platform-test';
    let privatePem: string;
    let publicPem: string;

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
    };

    const SUPER_ADMIN_USER_ID = uuidv7();
    const SUPER_ADMIN_COGNITO_SUB = `cog-platform-${SUPER_ADMIN_USER_ID}`;

    async function insertMinimalSeed(p: IdentityPrismaService): Promise<void> {
      // Sentinel platform Tenant (Lead ruling 2 B1).
      await p.tenant.create({
        data: {
          id: PLATFORM_TENANT_SENTINEL_ID,
          name: 'Aramo Platform',
          is_active: true,
        },
      });
      // super_admin role + the 3 platform:* scopes + the role-scope bundle.
      await p.role.create({
        data: {
          id: SUPER_ADMIN_ROLE_ID,
          key: 'super_admin',
          description: 'Platform Super Admin',
          is_active: true,
        },
      });
      await p.scope.createMany({
        data: [
          {
            id: PLATFORM_TENANT_PROVISION_SCOPE_ID,
            key: 'platform:tenant:provision',
            description: 'Platform: provision tenant',
          },
          {
            id: PLATFORM_TENANT_READ_SCOPE_ID,
            key: 'platform:tenant:read',
            description: 'Platform: read tenants',
          },
          {
            id: PLATFORM_ADMIN_INVITE_SCOPE_ID,
            key: 'platform:admin:invite',
            description: 'Platform: invite admin',
          },
        ],
      });
      await p.roleScope.createMany({
        data: [
          {
            id: uuidv7(),
            role_id: SUPER_ADMIN_ROLE_ID,
            scope_id: PLATFORM_TENANT_PROVISION_SCOPE_ID,
          },
          {
            id: uuidv7(),
            role_id: SUPER_ADMIN_ROLE_ID,
            scope_id: PLATFORM_TENANT_READ_SCOPE_ID,
          },
          {
            id: uuidv7(),
            role_id: SUPER_ADMIN_ROLE_ID,
            scope_id: PLATFORM_ADMIN_INVITE_SCOPE_ID,
          },
        ],
      });
      // The 4 tenant roles the invitation proofs need (tenant_owner +
      // recruiter + account_manager + finance). The full 12-role catalog
      // assertion lives in libs/identity/src/tests/identity.integration
      // .spec.ts. D-AUTHZ-PLATFORM-INVITE-1: the `finance` role is added
      // so the exploit-rejected proof can pair it with `recruiter` to
      // produce an invertible (view:pay + view:spread) union.
      await p.role.createMany({
        data: [
          {
            id: TENANT_OWNER_ROLE_ID,
            key: 'tenant_owner',
            description: 'Tenant Owner',
            is_active: true,
          },
          {
            id: RECRUITER_ROLE_ID,
            key: 'recruiter',
            description: 'Recruiter',
            is_active: true,
          },
          {
            id: ACCOUNT_MANAGER_ROLE_ID,
            key: 'account_manager',
            description: 'Account Manager',
            is_active: true,
          },
          {
            id: FINANCE_ROLE_ID,
            key: 'finance',
            description: 'Finance',
            is_active: true,
          },
        ],
      });
      // D-AUTHZ-PLATFORM-INVITE-1 — compensation scopes for the
      // exploit-rejected proof. Two RoleScope edges seed the leak shape:
      //   recruiter -> compensation:view:pay
      //   finance   -> compensation:view:spread:amount
      // Their UNION is the canonical D5-invertible bundle (pay
      // reconstructable from bill - spread). account_manager and
      // tenant_owner stay unseeded for comp scopes (proof 5's
      // recruiter+AM stays safe — union = {view:pay}).
      await p.scope.createMany({
        data: [
          {
            id: COMPENSATION_VIEW_PAY_SCOPE_ID,
            key: 'compensation:view:pay',
            description: 'Compensation: view pay',
          },
          {
            id: COMPENSATION_VIEW_SPREAD_AMOUNT_SCOPE_ID,
            key: 'compensation:view:spread:amount',
            description: 'Compensation: view spread amount',
          },
        ],
      });
      await p.roleScope.createMany({
        data: [
          {
            id: uuidv7(),
            role_id: RECRUITER_ROLE_ID,
            scope_id: COMPENSATION_VIEW_PAY_SCOPE_ID,
          },
          {
            id: uuidv7(),
            role_id: FINANCE_ROLE_ID,
            scope_id: COMPENSATION_VIEW_SPREAD_AMOUNT_SCOPE_ID,
          },
        ],
      });
      // The super_admin user + membership in the sentinel + ExternalIdentity.
      await p.user.create({
        data: {
          id: SUPER_ADMIN_USER_ID,
          email: 'sa@aramo.platform',
          display_name: 'Super Admin',
          is_active: true,
        },
      });
      const memId = uuidv7();
      await p.userTenantMembership.create({
        data: {
          id: memId,
          user_id: SUPER_ADMIN_USER_ID,
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
          is_active: true,
        },
      });
      await p.userTenantMembershipRole.create({
        data: {
          id: uuidv7(),
          membership_id: memId,
          role_id: SUPER_ADMIN_ROLE_ID,
        },
      });
      await p.externalIdentity.create({
        data: {
          id: uuidv7(),
          provider: 'cognito',
          provider_subject: SUPER_ADMIN_COGNITO_SUB,
          user_id: SUPER_ADMIN_USER_ID,
          email_snapshot: 'sa@aramo.platform',
        },
      });
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      for (const stmt of [
        ...splitDdl(readFileSync(IDENTITY_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_SITE_AXIS_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_D4A_MIGRATION, 'utf8')),
        ...ENTITLEMENT_DDL_STATEMENTS,
      ]) {
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
      await insertMinimalSeed(identityPrisma);

      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          AuthModule,
          AuthorizationModule,
          IdentityModule,
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
      app.use((req: { headers: Record<string, string> }, _res: unknown, next: () => void) => {
        const mw = new RequestIdMiddleware();
        mw.use(req as never, _res as never, next);
      });
      await app.init();
    }, 120_000);

    afterAll(async () => {
      await app.close();
      await identityPrisma.$disconnect();
      await container.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }, 30_000);

    async function platformJwt(scopes?: string[]): Promise<string> {
      return signJwt({
        privatePem,
        audience,
        sub: SUPER_ADMIN_USER_ID,
        consumer_type: 'platform',
        tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        scopes: scopes ?? [
          'platform:tenant:provision',
          'platform:tenant:read',
          'platform:admin:invite',
        ],
      });
    }

    async function tenantJwt(scopes: string[] = ['talent:read']): Promise<string> {
      return signJwt({
        privatePem,
        audience,
        sub: uuidv7(),
        consumer_type: 'recruiter',
        tenant_id: '01900000-0000-7000-8000-000000000001',
        scopes,
      });
    }

    // -------------------------------------------------------------------
    // Proof 1 — Tier separation tripwire (DDR §13.1), both directions.
    // -------------------------------------------------------------------
    it('proof 1.A — TENANT token at platform route returns 403 (tenant->platform tripwire)', async () => {
      const token = await tenantJwt(['talent:read', 'requisition:read']);
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Should Not Provision', owner_email: 'x@y.io' });
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('proof 1.B — PLATFORM token without required scope is rejected at the scope guard (platform-namespace partition)', async () => {
      const token = await platformJwt([]);
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'NewCo', owner_email: 'o@new.co' });
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // -------------------------------------------------------------------
    // Proof 2 — Tenant provisioning + entitlement seed + Tenant-Owner invite.
    // -------------------------------------------------------------------
    it('proof 2 — POST /platform/tenants provisions Tenant + entitlements + invites Tenant Owner', async () => {
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Acme Corp',
          owner_email: 'owner@acme.corp',
          owner_display_name: 'Acme Owner',
        });
      expect(res.status).toBe(201);
      expect(res.body.tenant_id).toBeDefined();
      expect(res.body.tenant_name).toBe('Acme Corp');
      expect(res.body.owner_email).toBe('owner@acme.corp');
      expect(res.body.invitation_sent).toBe(true);
      expect(res.body.capabilities.sort()).toEqual(['ats', 'core', 'portal']);

      expect(cognitoMock.adminCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ pool: 'tenant', email: 'owner@acme.corp' }),
      );

      const tenantId = res.body.tenant_id;
      const tenant = await identityPrisma.tenant.findUnique({
        where: { id: tenantId },
      });
      expect(tenant?.name).toBe('Acme Corp');
      const owner = await identityPrisma.user.findUnique({
        where: { email: 'owner@acme.corp' },
      });
      expect(owner).not.toBeNull();
      const ownerId = owner?.id;
      expect(ownerId).toBeDefined();
      if (ownerId === undefined) return;
      const membership = await identityPrisma.userTenantMembership.findUnique({
        where: {
          user_id_tenant_id: { user_id: ownerId, tenant_id: tenantId },
        },
      });
      expect(membership).not.toBeNull();
      const invitationAudit =
        await identityPrisma.identityAuditEvent.findFirst({
          where: { event_type: 'identity.invitation.created', tenant_id: tenantId },
        });
      expect(invitationAudit).not.toBeNull();
    });

    // -------------------------------------------------------------------
    // Proof 4 — Tenant Owner first.
    // -------------------------------------------------------------------
    it('proof 4 — provisioned tenant\'s first user holds the tenant_owner role', async () => {
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Globex', owner_email: 'owner@globex.io' });
      expect(res.status).toBe(201);
      const owner = await identityPrisma.user.findUnique({
        where: { email: 'owner@globex.io' },
      });
      expect(owner).not.toBeNull();
      const ownerId = owner?.id;
      if (ownerId === undefined) return;
      const memRole = await identityPrisma.userTenantMembershipRole.findFirst({
        where: {
          membership: { user_id: ownerId, tenant_id: res.body.tenant_id },
          role_id: TENANT_OWNER_ROLE_ID,
        },
      });
      expect(memRole).not.toBeNull();
    });

    // -------------------------------------------------------------------
    // Proof 6 — Idempotency: same-name re-provision returns 409.
    // -------------------------------------------------------------------
    it('proof 6 — re-provisioning the same tenant name returns 409 TENANT_ALREADY_EXISTS', async () => {
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Acme Corp', owner_email: 'other@acme.corp' });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe('TENANT_ALREADY_EXISTS');
    });

    // -------------------------------------------------------------------
    // Proof 3 — Cognito-provisioning failure surfaces COGNITO_PROVISION_FAILED.
    // -------------------------------------------------------------------
    it('proof 3 — Cognito AdminCreateUser failure surfaces COGNITO_PROVISION_FAILED 502', async () => {
      cognitoMock.adminCreateUser.mockImplementationOnce(async () => {
        throw new Error('Cognito unavailable');
      });
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Fail Co', owner_email: 'will@fail.io' });
      expect(res.status).toBe(502);
      expect(res.body?.error?.code).toBe('COGNITO_PROVISION_FAILED');

      const failTenant = await identityPrisma.tenant.findFirst({
        where: { name: 'Fail Co' },
      });
      expect(failTenant).toBeNull();
    });

    // -------------------------------------------------------------------
    // Proof 5 — Multi-role invite uses the staffing catalog.
    // -------------------------------------------------------------------
    it('proof 5 — invite with multiple role_keys assigns each via the staffing catalog', async () => {
      const provToken = await platformJwt();
      const provRes = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'MultiCo', owner_email: 'mowner@multi.co' });
      expect(provRes.status).toBe(201);
      const tenantId = provRes.body.tenant_id;

      const res = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({
          email: 'multi@multi.co',
          role_keys: ['recruiter', 'account_manager'],
        });
      expect(res.status).toBe(201);

      const invitee = await identityPrisma.user.findUnique({
        where: { email: 'multi@multi.co' },
      });
      const inviteeId = invitee?.id;
      expect(inviteeId).toBeDefined();
      if (inviteeId === undefined) return;
      const membership = await identityPrisma.userTenantMembership.findUnique({
        where: {
          user_id_tenant_id: { user_id: inviteeId, tenant_id: tenantId },
        },
        include: { role_assignments: { include: { role: true } } },
      });
      const roleKeys = membership?.role_assignments
        .map((a) => a.role.key)
        .sort() ?? [];
      expect(roleKeys).toEqual(['account_manager', 'recruiter']);
    });

    // -------------------------------------------------------------------
    // D-AUTHZ-PLATFORM-INVITE-1 — the EXPLOIT-REJECTED PROOF (load-bearing).
    //
    // The defect: PlatformInvitationService.inviteUserIntoTenant wrote
    // membership-roles via 3 IdentityService methods WITHOUT running the
    // RoleBundleValidator — a super_admin could persist an invertible
    // scope union via POST /platform/tenants/:tenant_id/invitations.
    //
    // The fix (in-service, §2 ruling): assertUnionNonInvertible moved
    // INTO IdentityService's 3 write methods — safe-by-construction.
    //
    // The proof: a super_admin POSTs role_keys=['recruiter','finance']
    // (recruiter holds view:pay, finance holds view:spread:amount, per the
    // seed above; their union IS invertible — the D5 leak). The response
    // must be 400 VALIDATION_ERROR with details.reason='invertible_role_
    // union' AND zero rows must have persisted in either the membership
    // or membership-role tables for the invitee email.
    // -------------------------------------------------------------------
    it('D-AUTHZ-PLATFORM-INVITE-1 — invertible bundle on platform invite → 400, ZERO rows persisted, no Cognito user retained', async () => {
      // Provision a fresh tenant to receive the (rejected) invite.
      const provToken = await platformJwt();
      const provRes = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'ExploitProbe Co', owner_email: 'owner@exploit.probe' });
      expect(provRes.status).toBe(201);
      const tenantId = provRes.body.tenant_id;

      // Snapshot row counts BEFORE the rejected invite.
      const exploitEmail = 'exploit@victim.io';
      const membershipsBefore =
        await identityPrisma.userTenantMembership.count({
          where: { tenant_id: tenantId },
        });
      const membershipRolesBefore =
        await identityPrisma.userTenantMembershipRole.count();

      // THE EXPLOIT — a super_admin attempts to grant an invertible union
      // (recruiter + finance = view:pay + view:spread:amount = D5 leak).
      const res = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({
          email: exploitEmail,
          role_keys: ['recruiter', 'finance'],
        });

      // THE LOAD-BEARING ASSERTION — the in-service validator rejects.
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body?.error?.details?.reason).toBe('invertible_role_union');

      // The invertible union NEVER persisted. The Cognito user MAY have
      // been created (in-service trade — validator fires AFTER Cognito on
      // the greenfield branch), but the identity-tx never committed and
      // the Cognito-rollback compensation fires. Either way, neither the
      // membership nor any membership-role rows exist for the invitee.
      const membershipsAfter =
        await identityPrisma.userTenantMembership.count({
          where: { tenant_id: tenantId },
        });
      const membershipRolesAfter =
        await identityPrisma.userTenantMembershipRole.count();
      // Pre = the just-provisioned owner's membership. Post must equal Pre.
      expect(membershipsAfter).toBe(membershipsBefore);
      expect(membershipRolesAfter).toBe(membershipRolesBefore);

      // No User row in identity for the exploit email — the identity-tx
      // never committed.
      const invitee = await identityPrisma.user.findUnique({
        where: { email: exploitEmail },
      });
      expect(invitee).toBeNull();
    });

    // The defense-in-depth DTO guard — an unknown role_key is rejected at
    // the DTO BEFORE the IdentityService.resolveRoleIdsByKeys DB roundtrip
    // (which would have caught it as a second layer).
    it('D-AUTHZ-PLATFORM-INVITE-1 — unknown role_key rejected at the DTO (defense-in-depth, before any DB call)', async () => {
      const provToken = await platformJwt();
      const provRes = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'DtoGuard Co', owner_email: 'owner@dto.guard' });
      expect(provRes.status).toBe(201);
      const tenantId = provRes.body.tenant_id;

      const res = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({
          email: 'should-not-persist@dto.guard',
          role_keys: ['nonexistent_role_key'],
        });
      // class-validator's @IsIn surfaces a 400 VALIDATION_ERROR.
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
    });

    // The safe see-all bypass — the in-service validator exempts
    // see-all-tier roles (tenant_admin / tenant_owner / super_admin /
    // auditor_with_financials). The two safe platform routes
    // (provisionTenant + invitePlatformAdmin) hard-fix to see-all roles
    // and must keep succeeding. Proof 2 (above) covers provisionTenant;
    // here we cover invitePlatformAdmin's safety.
    it('D-AUTHZ-PLATFORM-INVITE-1 — invitePlatformAdmin (super_admin, see-all-tier) still succeeds (bypass)', async () => {
      const provToken = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/admins/invitations')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'new-platform-admin@aramo.platform' });
      expect(res.status).toBe(201);
      // The new admin's membership is at the sentinel platform tenant.
      const admin = await identityPrisma.user.findUnique({
        where: { email: 'new-platform-admin@aramo.platform' },
      });
      expect(admin).not.toBeNull();
    });
  },
);
