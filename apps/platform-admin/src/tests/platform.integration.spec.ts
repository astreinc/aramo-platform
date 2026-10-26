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
  ARAMO_POSTGRES_TEST_IMAGE,
  AramoExceptionFilter,
  CommonModule,
  RequestIdMiddleware,
  ENTITLEMENT_PROVENANCE_MIGRATION,
  resolveIdentityMigrations,
} from '@aramo/common';
import { AuthModule, EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule, EntitlementRepository } from '@aramo/entitlement';
import {
  IdentityCoreModule,
  IdentityRepository,
  IdentityService,
  PrismaService as IdentityPrismaService,
} from '@aramo/identity';

import { CognitoAdminService } from '../app/platform/cognito/cognito-admin.service.js';
import { PlatformController } from '../app/platform/platform.controller.js';
import { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';
import { TenantPolicyProvisioningService } from '../app/platform/tenant-policy-provisioning.service.js';

import { ConfigurableAuthzResolver } from './support/configurable-authz-resolver.js';
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

// PR-1.5 Workstream C — the identity migration set now comes from the single
// shared ordered helper (@aramo/common). This replaces ~10 hand-listed
// individually-named `const IDENTITY_*_MIGRATION` consts. It ALSO fixes a latent
// bug that lived here undetected: the old line applied
//   readFileSync(IDENTITY_IDP_MIGRATION, IDENTITY_IDP_MIGRATION_LC, 'utf8')
// — passing the lifecycle-status migration path into readFileSync's `options`
// slot, so the lifecycle_status columns migration was NEVER applied. It went
// unnoticed because this spec is skipIf-gated on ARAMO_RUN_INTEGRATION and its
// root was absent from CI's tests-integration job (PR-1.5 adds the root, so this
// spec now runs in CI — the helper is what makes that safe).
const IDENTITY_MIGRATION_SQL_PATHS = resolveIdentityMigrations(
  resolve(__dirname, '../../../..'),
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
  // IC-3 PR-7 — `sign` is part of the live enum (20260923173000_add_esign_capability).
  `CREATE TYPE entitlement."Capability" AS ENUM ('core', 'ats', 'portal', 'sourcing', 'sign')`,
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
    authz_version: __authzResolver.grant(args.tenant_id, args.sub, args.scopes),
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
// ROLES-1 PR-2 — row 0x2b0 is tenant_admin (the organization administrator, formerly org_admin).
const TENANT_ADMIN_ROLE_ID = '01900000-0000-7000-8000-0000000002b0';
// IC-4 PR-9 — a Sign product role (PX-V1 PX-3 id), for the governed Sign grant proof.
// ROLES-1 PR-2: sign_admin (sign_owner is retired).
const ESIGN_ADMIN_ROLE_ID = '01900000-0000-7000-8000-0000000002a1';
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

// HF-AUTH-1 — MODE A resolver: each token declares its scopes via grant().
const __authzResolver = new ConfigurableAuthzResolver();

// IC-3 PR-7 — ATS projection spies (see the providers block).
const policyPublishSpy = vi.fn(async (_tenantId: string) => undefined);

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
          // ROLES-1 PR-2 — the organization administrator (row 0x2b0); every new
          // tenant's first owner receives tenant_owner + tenant_admin (§6).
          {
            id: TENANT_ADMIN_ROLE_ID,
            key: 'tenant_admin',
            description: 'Tenant Admin',
            is_active: true,
          },
          // IC-4 PR-9 — a Sign product role (assignable only in an esign-entitled tenant).
          {
            id: ESIGN_ADMIN_ROLE_ID,
            key: 'sign_admin',
            description: 'Sign Admin',
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
          // IC-1 PR-3: the platform operator is OWNED by the sentinel tenant.
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
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
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();

      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      // Identity schema from the shared ordered helper (Workstream C), then the
      // entitlement DDL this spec keeps hand-listed (it is a non-identity stack
      // spread inline to keep the spec self-contained — see the const above).
      const identityStatements = IDENTITY_MIGRATION_SQL_PATHS.flatMap((sqlPath) =>
        splitDdl(readFileSync(sqlPath, 'utf8')),
      );
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
          IdentityCoreModule,
          EntitlementModule,
        ],
        controllers: [PlatformController],
        providers: [
          PlatformInvitationService,
          // ADR-0024 PR-4a-2 — stub the template-copy dep; this spec does not
          // provision, so no PolicyStore/template is exercised.
          // IC-3 PR-7 — the two ATS projections are SPIES so the Sign-only proof
          // can assert they never run for a tenant without the ats capability.
          {
            provide: TenantPolicyProvisioningService,
            useValue: { publishDefaultLifecyclePackage: policyPublishSpy },
          },
          CognitoAdminService,
          // HF-AUTH-1 — bind the MODE A resolver so the guard hydrates scopes.
          { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: __authzResolver },
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
      // Domain-Enforcement P1 — the owner's (business) domain is derived +
      // persisted as the tenant's locked allowed_domain (real-graph proof).
      expect(tenant?.allowed_domain).toBe('acme.corp');
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

    // IC-2 PR-4 (F-4) — optional validated slug at console provisioning (real
    // graph): supplied → normalized + persisted on Tenant.slug (UNIQUE); a
    // reserved slug is refused at the single-source gate BEFORE Cognito; omitted
    // → slug NULL (the pre-PR-4 shape). Never derived from the name.
    it('IC-2 PR-4 (F-4) — POST /platform/tenants with a slug persists it normalized; a reserved slug → 400 reserved_slug, no tenant, no Cognito user', async () => {
      const token = await platformJwt();
      const ok = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Slugged Corp', owner_email: 'owner@slugged.corp', slug: 'Slugged-Corp' });
      expect(ok.status).toBe(201);
      const slugged = await identityPrisma.tenant.findUnique({ where: { id: ok.body.tenant_id } });
      expect(slugged?.slug).toBe('slugged-corp');

      const callsBefore = cognitoMock.adminCreateUser.mock.calls.length;
      const reserved = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Reserved Corp', owner_email: 'owner@reserved.corp', slug: 'admin' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.error.code).toBe('VALIDATION_ERROR');
      expect(reserved.body.error.details.reason).toBe('reserved_slug');
      expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(callsBefore);
      expect(await identityPrisma.tenant.findFirst({ where: { name: 'Reserved Corp' } })).toBeNull();

      const noSlug = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Unslugged Corp', owner_email: 'owner@unslugged.corp' });
      expect(noSlug.status).toBe(201);
      const unslugged = await identityPrisma.tenant.findUnique({ where: { id: noSlug.body.tenant_id } });
      expect(unslugged?.slug).toBeNull();
    });

    // Domain-Enforcement P1 — reject-personal at provision (real-graph proof
    // of §2). A personal/free owner domain is rejected with a 4xx
    // VALIDATION_ERROR (reason personal_email_not_allowed) and NO tenant /
    // Cognito user is created — the pre-Cognito pre-check fires before
    // AdminCreateUser, so no temp-password email goes to the personal address.
    it('proof 7 — personal owner email (gmail) is rejected; no tenant, no Cognito', async () => {
      const token = await platformJwt();
      cognitoMock.adminCreateUser.mockClear();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Personal Co',
          owner_email: 'founder@gmail.com',
          owner_display_name: 'Personal Founder',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details?.reason).toBe('personal_email_not_allowed');
      // No Cognito side-effect (pre-check ran BEFORE AdminCreateUser).
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      // No tenant row was created.
      const leaked = await identityPrisma.tenant.findFirst({
        where: { name: 'Personal Co' },
      });
      expect(leaked).toBeNull();
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

    // IC-2 PR-5 — a platform operator cannot grant platform-operator authority
    // to a non-sentinel tenant membership: super_admin is refused at the DTO
    // allow-list (400 VALIDATION_ERROR), no invite rows, no Cognito call.
    it('IC-2 PR-5 — inviting super_admin INTO a non-sentinel tenant → 400, zero rows, zero Cognito calls', async () => {
      const provToken = await platformJwt();
      const provRes = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'NoSuperCo', owner_email: 'owner@nosuper.co' });
      expect(provRes.status).toBe(201);
      const tenantId = provRes.body.tenant_id;
      const callsBefore = cognitoMock.adminCreateUser.mock.calls.length;
      const res = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'ops@nosuper.co', role_keys: ['recruiter', 'super_admin'] });
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(cognitoMock.adminCreateUser.mock.calls.length).toBe(callsBefore);
      expect(await identityPrisma.user.findUnique({ where: { email: 'ops@nosuper.co' } })).toBeNull();
    });

    // IC-3 PR-7 — product-neutral provisioning (real PG): Sign-only, ATS+Sign,
    // one tenant + one owner identity, owner role per product set, no ATS
    // projection for a tenant without ats, authorization baseline present.
    // ROLES-1 PR-2 (§6) — the first owner of every new tenant: tenant_owner + tenant_admin.
    it('IC-3 PR-7 — Sign-only provisioning ([esign]): tenant + tenant_owner + tenant_admin owner + [core, esign]; NO ATS projection; authz baseline exists', async () => {
      policyPublishSpy.mockClear();
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'SignOnly Corp', owner_email: 'owner@signonly.corp', capabilities: ['sign'] });
      expect(res.status).toBe(201);
      expect(res.body.capabilities).toEqual(['core', 'sign']);
      const tenantId = res.body.tenant_id as string;
      const entitled = await module.get(EntitlementRepository).getCapabilities(tenantId);
      expect([...entitled].sort()).toEqual(['core', 'sign']);
      const owner = await identityPrisma.user.findUnique({ where: { email: 'owner@signonly.corp' } });
      expect(owner?.tenant_id).toBe(tenantId);
      const memRoles = await identityPrisma.userTenantMembershipRole.findMany({
        where: { membership: { user_id: owner!.id, tenant_id: tenantId } },
        include: { role: { select: { key: true } } },
      });
      expect(memRoles.map((r) => r.role.key).sort()).toEqual(['tenant_admin', 'tenant_owner']);
      // authorization baseline for the owner in its one tenant
      const baseline = await identityPrisma.authorizationVersion.findFirst({ where: { tenant_id: tenantId, principal_id: owner!.id } });
      expect(baseline).not.toBeNull();
      // NO ATS projection ran
      expect(policyPublishSpy).not.toHaveBeenCalled();
      const tenant = await identityPrisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant?.status).toBe('PROVISIONED');
      expect(tenant?.is_active).toBe(true);
    });

    // IC-4 PR-9 — PERSONAL tenancy through the REAL console graph.
    it('IC-4 PR-9 #1/#7/#10 — POST /platform/tenants kind PERSONAL + gmail owner → 201: Tenant PERSONAL, allowed_domain NULL, [core, esign], tenant_owner + tenant_admin owner, ONE membership, authz baseline, NO ATS projection, PROVISIONED', async () => {
      policyPublishSpy.mockClear();
      cognitoMock.adminCreateUser.mockClear();
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Jane Doe', owner_email: 'jane.doe@gmail.com', owner_display_name: 'Jane Doe', kind: 'PERSONAL' });
      expect(res.status).toBe(201);
      expect(res.body.tenant_kind).toBe('PERSONAL');
      expect(res.body.capabilities).toEqual(['core', 'sign']);
      expect(cognitoMock.adminCreateUser).toHaveBeenCalledWith(expect.objectContaining({ pool: 'tenant', email: 'jane.doe@gmail.com' }));
      const tenantId = res.body.tenant_id as string;
      const tenant = await identityPrisma.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant?.kind).toBe('PERSONAL');
      expect(tenant?.allowed_domain).toBeNull();
      expect(tenant?.status).toBe('PROVISIONED');
      expect(tenant?.is_active).toBe(true);
      const entitled = await module.get(EntitlementRepository).getCapabilities(tenantId);
      expect([...entitled].sort()).toEqual(['core', 'sign']);
      const owner = await identityPrisma.user.findUnique({ where: { email: 'jane.doe@gmail.com' } });
      expect(owner?.tenant_id).toBe(tenantId);
      const memberships = await identityPrisma.userTenantMembership.findMany({ where: { user_id: owner!.id } });
      expect(memberships).toHaveLength(1);
      const memRoles = await identityPrisma.userTenantMembershipRole.findMany({
        where: { membership_id: memberships[0]!.id },
        include: { role: { select: { key: true } } },
      });
      expect(memRoles.map((r) => r.role.key).sort()).toEqual(['tenant_admin', 'tenant_owner']);
      expect(await identityPrisma.authorizationVersion.findFirst({ where: { tenant_id: tenantId, principal_id: owner!.id } })).not.toBeNull();
      expect(policyPublishSpy).not.toHaveBeenCalled();
      // The list row and the detail read surface the kind.
      const list = await request(app.getHttpServer()).get('/platform/tenants').set('Authorization', `Bearer ${await platformJwt()}`);
      expect(list.status).toBe(200);
      const row = (list.body.tenants as Array<{ id: string; kind: string }>).find((t) => t.id === tenantId);
      expect(row?.kind).toBe('PERSONAL');
    });

    it('IC-4 PR-9 #4/#8 — PERSONAL with an ATS capability → 400 personal_tenant_capability_not_allowed BEFORE Cognito; unknown kind → 400 at the DTO; no tenant rows', async () => {
      cognitoMock.adminCreateUser.mockClear();
      const token = await platformJwt();
      const ats = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Jane ATS', owner_email: 'jane.ats@gmail.com', kind: 'PERSONAL', capabilities: ['core', 'ats'] });
      expect(ats.status).toBe(400);
      expect(ats.body.error.details?.reason).toBe('personal_tenant_capability_not_allowed');
      const bad = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Jane Kind', owner_email: 'jane.kind@gmail.com', kind: 'ENTERPRISE' });
      expect(bad.status).toBe(400);
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(await identityPrisma.tenant.findFirst({ where: { name: { in: ['Jane ATS', 'Jane Kind'] } } })).toBeNull();
    });

    it('IC-4 PR-9 #3/#9 — a registered personal email cannot provision a second tenant (409 EMAIL_UNAVAILABLE before Cognito); BUSINESS still refuses a personal-provider owner (proof 7 unchanged)', async () => {
      cognitoMock.adminCreateUser.mockClear();
      const token = await platformJwt();
      const dup = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Jane Doe Again', owner_email: 'Jane.Doe@gmail.com', kind: 'PERSONAL' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('EMAIL_UNAVAILABLE');
      expect(dup.body.error.details).toEqual({});
      const biz = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Gmail Business', owner_email: 'founder2@gmail.com' });
      expect(biz.status).toBe(400);
      expect(biz.body.error.details?.reason).toBe('personal_email_not_allowed');
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(await identityPrisma.tenant.count({ where: { name: { in: ['Jane Doe Again', 'Gmail Business'] } } })).toBe(0);
    });

    it('IC-4 PR-9 #6 — the personal owner (tenant_owner + tenant_admin) adds a Sign product role through the governed role path; the same grant is refused for a tenant without esign (IC-3 PR-8)', async () => {
      const identitySvc = module.get(IdentityService);
      const owner = await identityPrisma.user.findUniqueOrThrow({ where: { email: 'jane.doe@gmail.com' } });
      const membership = await identityPrisma.userTenantMembership.findFirstOrThrow({ where: { user_id: owner.id } });
      await identitySvc.replaceMembershipRoles({
        membership_id: membership.id, tenant_id: owner.tenant_id, role_keys: ['tenant_owner', 'tenant_admin', 'sign_admin'],
        role_ids: [TENANT_OWNER_ROLE_ID, TENANT_ADMIN_ROLE_ID, ESIGN_ADMIN_ROLE_ID], request_id: 'rq-pr9-grant',
      });
      const keys = await identitySvc.findRoleKeysForMembership(membership.id);
      expect(keys.sort()).toEqual(['sign_admin', 'tenant_admin', 'tenant_owner']);
      // An ATS-only business tenant's owner cannot receive a Sign role.
      const acme = await identityPrisma.user.findUniqueOrThrow({ where: { email: 'owner@acme.corp' } });
      const acmeMembership = await identityPrisma.userTenantMembership.findFirstOrThrow({ where: { user_id: acme.id } });
      await expect(identitySvc.replaceMembershipRoles({
        membership_id: acmeMembership.id, tenant_id: acme.tenant_id, role_keys: ['tenant_owner', 'tenant_admin', 'sign_admin'],
        role_ids: [TENANT_OWNER_ROLE_ID, TENANT_ADMIN_ROLE_ID, ESIGN_ADMIN_ROLE_ID], request_id: 'rq-pr9-grant-2',
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'esign_role_not_entitled' } } });
    });

    it('IC-3 PR-7 — ATS + Sign provisioning: ONE tenant, ONE owner (tenant_owner + tenant_admin), all four entitlements, ATS projections run; ATS-only (proof 2) unchanged', async () => {
      policyPublishSpy.mockClear();
      const token = await platformJwt();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Both Corp', owner_email: 'owner@both.corp', capabilities: ['core', 'ats', 'portal', 'sign'] });
      expect(res.status).toBe(201);
      expect(res.body.capabilities).toEqual(['core', 'ats', 'portal', 'sign']);
      const tenantId = res.body.tenant_id as string;
      const owners = await identityPrisma.user.findMany({ where: { email: 'owner@both.corp' } });
      expect(owners).toHaveLength(1);
      const memRoles = await identityPrisma.userTenantMembershipRole.findMany({
        where: { membership: { user_id: owners[0]!.id, tenant_id: tenantId } },
        include: { role: { select: { key: true } } },
      });
      expect(memRoles.map((r) => r.role.key).sort()).toEqual(['tenant_admin', 'tenant_owner']);
      expect(policyPublishSpy).toHaveBeenCalledWith(tenantId);
      // DOC-TEMPLATE-LIB-1 T-3 (§5.3) — no RTR template copy any more: the new tenant has
      // no documents rows and resolves to the Aramo RTR default.
      // cross-tenant email collision still refused for the Sign-only owner's email
      const dup = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Dup Corp', owner_email: 'owner@signonly.corp', capabilities: ['sign'] });
      expect(dup.status).toBe(409);
      expect(dup.body?.error?.code).toBe('EMAIL_UNAVAILABLE');
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
        // PLATFORM-UX-1 B-1c — an allowed operator domain (default aramo.ai).
        .send({ email: 'new-platform-admin@aramo.ai' });
      expect(res.status).toBe(201);
      // The new admin's membership is at the sentinel platform tenant.
      const admin = await identityPrisma.user.findUnique({
        where: { email: 'new-platform-admin@aramo.ai' },
      });
      expect(admin).not.toBeNull();
    });

    // PLATFORM-UX-1 B-1c (directive R-8) — the platform-admin invite refuses a
    // domain outside PLATFORM_ADMIN_EMAIL_DOMAINS (default aramo.ai) with 400
    // VALIDATION_ERROR reason platform_admin_domain_not_allowed, and writes
    // nothing (no user row, no Cognito call).
    it('PLATFORM-UX-1 B-1c — invitePlatformAdmin refuses a non-allowed email domain (400, no side effect)', async () => {
      const provToken = await platformJwt();
      cognitoMock.adminCreateUser.mockClear();
      const res = await request(app.getHttpServer())
        .post('/platform/admins/invitations')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'outsider@example.com' });
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('VALIDATION_ERROR');
      expect(res.body?.error?.details?.reason).toBe('platform_admin_domain_not_allowed');
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(
        await identityPrisma.user.findUnique({ where: { email: 'outsider@example.com' } }),
      ).toBeNull();
    });

    // -------------------------------------------------------------------
    // IC-1 PR-1 — D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 (one User, one
    // tenant) at the HTTP surface, real Postgres, mocked Cognito.
    // -------------------------------------------------------------------
    async function snapshotCounts(): Promise<Record<string, number>> {
      return {
        users: await identityPrisma.user.count(),
        memberships: await identityPrisma.userTenantMembership.count(),
        external_identities: await identityPrisma.externalIdentity.count(),
        invitations: await identityPrisma.invitation.count(),
        tenants: await identityPrisma.tenant.count(),
      };
    }

    function clearCognitoCalls(): void {
      cognitoMock.adminCreateUser.mockClear();
      cognitoMock.adminGetUser.mockClear();
      cognitoMock.adminDeleteUser.mockClear();
    }

    it('IC-1 PR-1 — inviting an email owned by ANOTHER tenant → 409 EMAIL_UNAVAILABLE, details {}, no ownership detail, ZERO rows, ZERO Cognito calls, audit reason retained (former membership_added RETIRED)', async () => {
      const provToken = await platformJwt();
      const alpha = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Alpha Co', owner_email: 'owner@alpha.co' });
      expect(alpha.status).toBe(201);
      const alphaTenantId: string = alpha.body.tenant_id;
      const alphaOwnerUserId: string = alpha.body.owner_user_id;
      const beta = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Beta Co', owner_email: 'owner@beta.co' });
      expect(beta.status).toBe(201);
      const betaTenantId: string = beta.body.tenant_id;

      const before = await snapshotCounts();
      clearCognitoCalls();

      // Mixed case on purpose — the probe must normalize before the lookup.
      const res = await request(app.getHttpServer())
        .post(`/platform/tenants/${betaTenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'Owner@Alpha.CO', role_keys: ['recruiter'] });

      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe('EMAIL_UNAVAILABLE');
      // EXACTLY `details: {}` inside the standard envelope.
      expect(res.body?.error?.details).toEqual({});
      expect(typeof res.body?.error?.request_id).toBe('string');
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(alphaTenantId);
      expect(serialized).not.toContain(alphaOwnerUserId);
      expect(serialized).not.toContain('Alpha Co');
      expect(serialized).not.toContain('recruiter');

      // Nothing persisted — no User, membership, ExternalIdentity, Invitation
      // or Tenant row changed; the owner still has exactly ONE membership.
      expect(await snapshotCounts()).toEqual(before);
      expect(
        await identityPrisma.userTenantMembership.count({
          where: { user_id: alphaOwnerUserId },
        }),
      ).toBe(1);
      expect(
        await identityPrisma.userTenantMembership.findUnique({
          where: {
            user_id_tenant_id: { user_id: alphaOwnerUserId, tenant_id: betaTenantId },
          },
        }),
      ).toBeNull();

      // No Cognito side effect of any kind (no probe, no create, no delete).
      expect(cognitoMock.adminGetUser).not.toHaveBeenCalled();
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(cognitoMock.adminDeleteUser).not.toHaveBeenCalled();

      // The internal audit entry, scoped to the ATTEMPTED target tenant,
      // retains the actual reason + caller; never the email.
      const audit = await identityPrisma.identityAuditEvent.findMany({
        where: {
          tenant_id: betaTenantId,
          event_type: 'identity.invitation.rejected_cross_tenant',
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_id).toBe(SUPER_ADMIN_USER_ID);
      // Gate-5 G5-08 — no foreign-tenant identifier anywhere in the stored row.
      expect(audit[0]?.subject_id).toBe(betaTenantId);
      expect(audit[0]?.event_payload).toEqual({
        reason: 'existing_user_owned_by_other_tenant',
        tier: 'platform',
        attempted_tenant_id: betaTenantId,
        request_id: expect.any(String),
      });
      const storedRow = JSON.stringify(audit[0]);
      expect(storedRow).not.toContain(alphaOwnerUserId);
      expect(storedRow).not.toContain(alphaTenantId);
      expect(storedRow).not.toContain('owner@alpha.co');
      expect(
        await identityPrisma.identityAuditEvent.count({
          where: {
            tenant_id: alphaTenantId,
            event_type: 'identity.invitation.rejected_cross_tenant',
          },
        }),
      ).toBe(0);
    });

    it('IC-1 PR-1 — Cognito-absent / identity-present in the SAME tenant → preserved 409 INVITATION_ALREADY_EXISTS (same roles) / roles_updated (different roles); NEVER AdminCreateUser', async () => {
      const provToken = await platformJwt();
      const prov = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'NoSub Co', owner_email: 'owner@nosub.co' });
      expect(prov.status).toBe(201);
      const tenantId: string = prov.body.tenant_id;

      // Simulate a tenant-tier (Pattern-2, no-sub) invitee: User + INVITED
      // membership + recruiter role, NO ExternalIdentity, NO Cognito user.
      const noSubUserId = uuidv7();
      const noSubMembershipId = uuidv7();
      await identityPrisma.user.create({
        data: { id: noSubUserId, email: 'nosub@nosub.co', display_name: 'No Sub', is_active: true, tenant_id: tenantId },
      });
      await identityPrisma.userTenantMembership.create({
        data: {
          id: noSubMembershipId,
          user_id: noSubUserId,
          tenant_id: tenantId,
          is_active: true,
          invite_status: 'INVITED',
        },
      });
      await identityPrisma.userTenantMembershipRole.create({
        data: { id: uuidv7(), membership_id: noSubMembershipId, role_id: RECRUITER_ROLE_ID },
      });
      const before = await snapshotCounts();
      clearCognitoCalls();

      // Same role set → the preserved same-tenant 409 (never EMAIL_UNAVAILABLE).
      const same = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'NoSub@NoSub.CO', role_keys: ['recruiter'] });
      expect(same.status).toBe(409);
      expect(same.body?.error?.code).toBe('INVITATION_ALREADY_EXISTS');

      // Different role set → the preserved reconcile (roles_updated).
      const diff = await request(app.getHttpServer())
        .post(`/platform/tenants/${tenantId}/invitations`)
        .set('Authorization', `Bearer ${provToken}`)
        .send({ email: 'nosub@nosub.co', role_keys: ['recruiter', 'account_manager'] });
      expect(diff.status).toBe(201);
      expect(diff.body?.status).toBe('roles_updated');
      expect(diff.body?.membership_id).toBe(noSubMembershipId);

      // Pre-IC-1 this state fell through to AdminCreateUser + a P2002 500 +
      // AdminDeleteUser. Now: no Cognito call on either branch, no new rows.
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(cognitoMock.adminDeleteUser).not.toHaveBeenCalled();
      expect(await snapshotCounts()).toEqual(before);
      expect(
        await identityPrisma.identityAuditEvent.count({
          where: { tenant_id: tenantId, event_type: 'identity.invitation.rejected_cross_tenant' },
        }),
      ).toBe(0);
    });

    it('IC-1 PR-1 — provisioning a tenant whose owner email is already registered → 409 EMAIL_UNAVAILABLE (details {}) BEFORE Cognito; no tenant created', async () => {
      const provToken = await platformJwt();
      const before = await snapshotCounts();
      clearCognitoCalls();
      const res = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Gamma Co', owner_email: 'Owner@Alpha.CO' });
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe('EMAIL_UNAVAILABLE');
      expect(res.body?.error?.details).toEqual({});
      expect(await snapshotCounts()).toEqual(before);
      expect(
        await identityPrisma.tenant.findFirst({ where: { name: 'Gamma Co' } }),
      ).toBeNull();
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(cognitoMock.adminDeleteUser).not.toHaveBeenCalled();
    });

    // -------------------------------------------------------------------
    // IC-1 PR-1 Gate-5 FIX_NOW-2 — Cognito compensation isolation under a
    // concurrent-registration race (real Postgres, real unique index, mocked
    // Cognito store). The race is reproduced by making the identity pre-checks
    // MISS once each (the platform-service classification and the in-service
    // guard), so the insert hits the real User.email unique index.
    // -------------------------------------------------------------------
    async function forceRaceOnNextInvite(): Promise<() => void> {
      const repo = module.get(IdentityRepository);
      const spy = vi
        .spyOn(repo, 'findUserByEmail')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      return () => spy.mockRestore();
    }

    it('FIX_NOW-2 (drift branch) — a lost race against a PRE-EXISTING Cognito identity never deletes it: 409 EMAIL_UNAVAILABLE, AdminCreateUser/AdminDeleteUser not called, identity intact', async () => {
      const provToken = await platformJwt();
      const alpha = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Race Alpha Co', owner_email: 'owner@racealpha.co' });
      expect(alpha.status).toBe(201);
      const beta = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Race Beta Co', owner_email: 'owner@racebeta.co' });
      expect(beta.status).toBe(201);
      const subBefore = cognitoStore.get('owner@racealpha.co');
      expect(subBefore).toBeDefined();
      const before = await snapshotCounts();
      clearCognitoCalls();

      const restore = await forceRaceOnNextInvite();
      try {
        // Pre-checks miss → identity "absent" → Cognito has the user → the
        // drift branch mirrors against the EXISTING sub → the real unique
        // index refuses the insert → governed 409. No compensation runs on
        // the drift branch, and the established Cognito identity survives.
        const res = await request(app.getHttpServer())
          .post(`/platform/tenants/${beta.body.tenant_id}/invitations`)
          .set('Authorization', `Bearer ${provToken}`)
          .send({ email: 'owner@racealpha.co', role_keys: ['recruiter'] });
        expect(res.status).toBe(409);
        expect(res.body?.error?.code).toBe('EMAIL_UNAVAILABLE');
        expect(res.body?.error?.details).toEqual({});
      } finally {
        restore();
      }
      expect(cognitoMock.adminCreateUser).not.toHaveBeenCalled();
      expect(cognitoMock.adminDeleteUser).not.toHaveBeenCalled();
      expect(cognitoStore.get('owner@racealpha.co')).toBe(subBefore);
      expect(await snapshotCounts()).toEqual(before);
    });

    it('FIX_NOW-2 (greenfield branch) — a lost race compensates ONLY the Cognito identity this operation created; the established identity of the email owner (no Cognito) is unaffected', async () => {
      const provToken = await platformJwt();
      const prov = await request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Authorization', `Bearer ${provToken}`)
        .send({ name: 'Race Gamma Co', owner_email: 'owner@racegamma.co' });
      expect(prov.status).toBe(201);
      const tenantId: string = prov.body.tenant_id;
      // A tenant-tier (no-sub) user owned by ANOTHER tenant: identity.User +
      // membership elsewhere, NO Cognito identity at all.
      const ownedUserId = uuidv7();
      await identityPrisma.user.create({
        data: { id: ownedUserId, email: 'nosub@racegamma.co', display_name: 'No Sub', is_active: true, tenant_id: PLATFORM_TENANT_SENTINEL_ID },
      });
      await identityPrisma.userTenantMembership.create({
        data: {
          id: uuidv7(),
          user_id: ownedUserId,
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
          is_active: true,
          invite_status: 'INVITED',
        },
      });
      const before = await snapshotCounts();
      clearCognitoCalls();
      expect(cognitoStore.has('nosub@racegamma.co')).toBe(false);

      const restore = await forceRaceOnNextInvite();
      try {
        // Pre-checks miss → Cognito absent → GREENFIELD: AdminCreateUser mints
        // a sub for this operation → the real unique index refuses the mirror
        // → governed 409 → compensation deletes exactly the identity it minted.
        const res = await request(app.getHttpServer())
          .post(`/platform/tenants/${tenantId}/invitations`)
          .set('Authorization', `Bearer ${provToken}`)
          .send({ email: 'nosub@racegamma.co', role_keys: ['recruiter'] });
        expect(res.status).toBe(409);
        expect(res.body?.error?.code).toBe('EMAIL_UNAVAILABLE');
        expect(res.body?.error?.details).toEqual({});
      } finally {
        restore();
      }
      expect(cognitoMock.adminCreateUser).toHaveBeenCalledTimes(1);
      expect(cognitoMock.adminDeleteUser).toHaveBeenCalledTimes(1);
      expect(cognitoMock.adminDeleteUser).toHaveBeenCalledWith(
        expect.objectContaining({ pool: 'tenant', email: 'nosub@racegamma.co' }),
      );
      // The minted identity is gone; no identity rows changed; the owner
      // still holds exactly one membership (elsewhere).
      expect(cognitoStore.has('nosub@racegamma.co')).toBe(false);
      expect(await snapshotCounts()).toEqual(before);
      expect(
        await identityPrisma.userTenantMembership.count({ where: { user_id: ownedUserId } }),
      ).toBe(1);
      // Every other Cognito identity in the store is untouched.
      expect(cognitoStore.get('owner@racegamma.co')).toBeDefined();
    });

    it('IC-1 PR-1 — the retired AUTHZ-2 entry points are absent from the live module graph', () => {
      const identitySvc = module.get(IdentityService) as unknown as Record<string, unknown>;
      expect(identitySvc['addMembershipForExistingUser']).toBeUndefined();
      const repo = module.get(IdentityRepository) as unknown as Record<string, unknown>;
      expect(repo['createMembershipForExistingUser']).toBeUndefined();
    });
  },
);
