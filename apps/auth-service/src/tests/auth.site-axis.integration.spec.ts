// PR-A1a-3 §4 live site e2e (Ruling 3) — the real round-trip A1a-2 §4
// Ruling-3 finding deferred. Closes the gap: a hand-mocked token was
// forbidden to "fake" site_id; the only valid proof is to seed a real
// site-scoped UserTenantMembership, drive the real issuance path, and
// observe the issued JWT carries site_id AND that @RequireSiteMatch
// enforces the round-trip against a real route.
//
// Spec uses REAL TenantService + RoleService (NOT stubbed, unlike
// auth.integration.spec.ts which overrides them). Cognito remains
// stubbed — it's the external dependency, not the unit under test.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import {
  Controller,
  Get,
  Param,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { decodeJwt } from 'jose';
import { AramoExceptionFilter, CommonModule } from '@aramo/common';
import {
  IdentityCoreModule,
  PrismaService as IdentityPrismaService,
} from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { JwtAuthGuard } from '@aramo/auth';
import {
  AuthorizationModule,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';

import { AuthController } from '../app/auth/auth.controller.js';
import { HostBaseResolver } from '../app/auth/host-base-resolver.service.js';
import { CognitoVerifierService } from '../app/auth/cognito-verifier.service.js';
import { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import { JwksController } from '../app/auth/jwks.controller.js';
import { JwksService } from '../app/auth/jwks.service.js';
import { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';
import { PkceService } from '../app/auth/pkce.service.js';
import { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';
import { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

import { generateTestKeyPair } from './test-keys.js';

// PR-A1a-3 §4 test-only proof route. @RequireSiteMatch enforces that
// AuthContext.site_id (from the JWT) matches the route's path :site_id;
// scaffolded here only — not exported, not wired into production.
@Controller('__test/site')
class SiteAxisProofController {
  @Get(':site_id/echo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireSiteMatch()
  echo(@Param('site_id') siteId: string): { site_id: string } {
    return { site_id: siteId };
  }
}

const IDENTITY_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
// Domain-Enforcement P2b — additive Tenant domain-verification columns.
const IDENTITY_DOMAIN_VERIFICATION_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
);
const IDENTITY_SLUG_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
);
// Subdomain-Identity Directive B — additive Tenant.identity_provider column.
const IDENTITY_IDP_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
);
const IDENTITY_IDP_MIGRATION_LC = resolve(__dirname, '../../../../libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql');
const IDENTITY_INVITATION_MIG = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
const IDENTITY_SITE_AXIS_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
// AUTHZ-D4a — team-model tables (chronologically between site-axis and the
// profile/hierarchy migrations; applied so the DB matches the generated client).
const IDENTITY_TEAM_MODELS_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
);
// Settings Rebuild D3 — additive tenant-profile columns (Prisma SELECTs them).
const IDENTITY_PROFILE_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);
// Settings Rebuild D4 — Site.parent_site_id self-FK hierarchy (Prisma SELECTs
// it on every site row, so the seed's site.upsert requires the column).
const IDENTITY_SITE_HIERARCHY_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
);
const AUTH_STORAGE_MIGRATION = resolve(
  __dirname,
  '../../../../libs/auth-storage/prisma/migrations/20260512100000_init_auth_storage/migration.sql',
);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

// Fixed UUIDs for determinism.
const TENANT_ID = '01900000-0000-7000-8000-0000000000a1';
const SITE_ID = '01900000-0000-7000-8000-0000000000b1';
const OTHER_SITE_ID = '01900000-0000-7000-8000-0000000000b2';
const SITE_USER_ID = '01900000-0000-7000-8000-0000000000d1';
const TENANT_WIDE_USER_ID = '01900000-0000-7000-8000-0000000000d2';
const SITE_USER_COGNITO_SUB = 'cognito-sub-site-user';
const TENANT_WIDE_COGNITO_SUB = 'cognito-sub-tenant-wide-user';
const ROLE_ID = '01900000-0000-7000-8000-0000000000e1';
const SCOPE_ID = '01900000-0000-7000-8000-0000000000e2';
const SCOPE_KEY = 'auth:session:read';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-service — PR-A1a-3 §4 live site e2e (Ruling 3 round-trip)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let identityPrisma: IdentityPrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      for (const stmt of [
        ...splitDdl(readFileSync(IDENTITY_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_ALLOWED_DOMAIN_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_DOMAIN_VERIFICATION_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_SLUG_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_IDP_MIGRATION, IDENTITY_IDP_MIGRATION_LC, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_INVITATION_MIG, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_SITE_AXIS_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_TEAM_MODELS_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_PROFILE_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(IDENTITY_SITE_HIERARCHY_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(AUTH_STORAGE_MIGRATION, 'utf8')),
      ]) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await setup.$executeRawUnsafe(t);
      }
      await setup.$disconnect();

      // Generate the keypair used by BOTH the JwtIssuerService (signs)
      // and the JwtAuthGuard (verifies). Single pair, byte-identical.
      const { privatePem, publicPem } = generateTestKeyPair();
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PRIVATE_KEY: process.env['AUTH_PRIVATE_KEY'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        AUTH_PKCE_STATE_KEY: process.env['AUTH_PKCE_STATE_KEY'],
        AUTH_COGNITO_DOMAIN: process.env['AUTH_COGNITO_DOMAIN'],
        AUTH_COGNITO_CLIENT_ID: process.env['AUTH_COGNITO_CLIENT_ID'],
        AUTH_COGNITO_REDIRECT_URI: process.env['AUTH_COGNITO_REDIRECT_URI'],
        AUTH_POST_LOGIN_REDIRECT: process.env['AUTH_POST_LOGIN_REDIRECT'],
        AUTH_REFRESH_GRACE_SECONDS: process.env['AUTH_REFRESH_GRACE_SECONDS'],
        AUTH_ALLOW_INSECURE_COOKIES: process.env['AUTH_ALLOW_INSECURE_COOKIES'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
      process.env['AUTH_PRIVATE_KEY'] = privatePem;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['AUTH_PKCE_STATE_KEY'] = randomBytes(32).toString('base64url');
      process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
      process.env['AUTH_COGNITO_CLIENT_ID'] = 'test-client';
      process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://app.example/cb';
      // Callback success now 302-redirects the browser to this per-env URL
      // (cookies set first); throws 500 if unset. See auth.controller §callback.
      process.env['AUTH_POST_LOGIN_REDIRECT'] = 'https://app.example/home';
      process.env['AUTH_REFRESH_GRACE_SECONDS'] = '0';
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      // Build the testing module — IdentityCoreModule provides REAL
      // IdentityService / TenantService / RoleService. Only Cognito is
      // stubbed (external dependency).
      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          IdentityCoreModule,
          AuthStorageModule,
          AuthorizationModule,
        ],
        controllers: [AuthController, JwksController, SiteAxisProofController],
        providers: [
          PkceService,
          JwtIssuerService,
          CookieVerifierService,
          JwksService,
          CognitoVerifierService,
          SessionOrchestratorService,
          RefreshOrchestratorService,
          HostBaseResolver,
          // Mirror AuthModule's APP_FILTER wiring so AramoError → the
          // nested {error:{code,...}} envelope the real app emits.
          { provide: APP_FILTER, useClass: AramoExceptionFilter },
        ],
      }).compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
        req.requestId = 'site-axis-req';
        next();
      });
      await app.init();

      identityPrisma = module.get(IdentityPrismaService);

      // Seed the entities needed for the round-trip: tenant, two sites,
      // two users (one site-scoped, one tenant-wide), external
      // identities, one role + one scope + role-scope assignment, and
      // both memberships + their role assignments.
      await seedSiteAxisFixture(identityPrisma);
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function stubCognitoForUser(cognitoSub: string): void {
      vi.spyOn(CognitoVerifierService.prototype, 'verify').mockResolvedValue({
        sub: cognitoSub,
        email: `${cognitoSub}@aramo.dev`,
        email_verified: true,
        token_use: 'id',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id_token: 'cognito.id.token' }),
        }),
      );
    }

    function unstubCognito(): void {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }

    async function loginAndExtractAccessToken(
      cognitoSub: string,
    ): Promise<string> {
      stubCognitoForUser(cognitoSub);
      const loginRes = await request(app.getHttpServer()).get(
        '/auth/recruiter/login',
      );
      expect(loginRes.status).toBe(302);
      const setCookies = loginRes.headers['set-cookie'] as unknown as string[];
      const pkceCookie = (Array.isArray(setCookies) ? setCookies : [setCookies as string])
        .find((c) => c.startsWith('aramo_pkce_state='))!
        .split(';')[0]!;
      const state = new URL(loginRes.headers['location']!).searchParams.get('state')!;

      const cbRes = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      // Success is a 302 back into the app (AUTH_POST_LOGIN_REDIRECT) with the
      // session cookies set on the redirect response (contract: 204 → 302).
      expect(cbRes.status).toBe(302);
      const cbCookies = cbRes.headers['set-cookie'] as unknown as string[];
      const accessHeader = cbCookies.find((c) =>
        c.startsWith('aramo_access_token='),
      )!;
      const accessToken = accessHeader.split(';')[0]!.split('=')[1]!;
      unstubCognito();
      return accessToken;
    }

    // PR-A1a-3 §4 main assertion: real issuance stamps site_id on the
    // JWT for a site-scoped membership user (Ruling 1 round-trip).
    it('PR-A1a-3 §4 — issued JWT carries the seeded site_id for a site-scoped user', async () => {
      const accessToken = await loginAndExtractAccessToken(SITE_USER_COGNITO_SUB);
      const payload = decodeJwt(accessToken);
      expect(payload['site_id']).toBe(SITE_ID);
      expect(payload['sub']).toBe(SITE_USER_ID);
      expect(payload['tenant_id']).toBe(TENANT_ID);
      expect(payload['scopes']).toEqual([SCOPE_KEY]);
    });

    // PR-A1a-3 §4 round-trip: matching-site token ACCEPTS at a real
    // @RequireSiteMatch route.
    it('PR-A1a-3 §4 — @RequireSiteMatch route ACCEPTS a matching-site token (200)', async () => {
      const accessToken = await loginAndExtractAccessToken(SITE_USER_COGNITO_SUB);
      const res = await request(app.getHttpServer())
        .get(`/__test/site/${SITE_ID}/echo`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ site_id: SITE_ID });
    });

    // PR-A1a-3 §4 round-trip: wrong-site token REJECTS at the same
    // route with 403 INSUFFICIENT_PERMISSIONS.
    it('PR-A1a-3 §4 — @RequireSiteMatch route REJECTS a wrong-site request (403)', async () => {
      const accessToken = await loginAndExtractAccessToken(SITE_USER_COGNITO_SUB);
      const res = await request(app.getHttpServer())
        .get(`/__test/site/${OTHER_SITE_ID}/echo`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // Site-Axis Authority Fix: a tenant-wide membership → JWT lacks
    // site_id → that principal holds authority over EVERY site, so a
    // @RequireSiteMatch route ACCEPTS it (200), even against a specific
    // requested site. (Was 403 under the pre-fix missing-claim hard-deny,
    // which wrongly locked out the broadest-authority principal.) The
    // issuer omits site_id only for NULL-site memberships, so this admit
    // path cannot be forged by a site-scoped user.
    it('Site-Axis Authority Fix — tenant-wide membership issues a null-site token; @RequireSiteMatch ACCEPTS it on any site (200)', async () => {
      const accessToken = await loginAndExtractAccessToken(TENANT_WIDE_COGNITO_SUB);
      const payload = decodeJwt(accessToken);
      expect('site_id' in payload).toBe(false);
      expect(payload['sub']).toBe(TENANT_WIDE_USER_ID);
      const res = await request(app.getHttpServer())
        .get(`/__test/site/${SITE_ID}/echo`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ site_id: SITE_ID });
    });
  },
);

async function seedSiteAxisFixture(prisma: IdentityPrismaService): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Site Axis Tenant', is_active: true },
  });
  await prisma.site.upsert({
    where: { id: SITE_ID },
    update: {},
    create: {
      id: SITE_ID,
      tenant_id: TENANT_ID,
      name: 'Primary Site',
      is_active: true,
    },
  });
  await prisma.site.upsert({
    where: { id: OTHER_SITE_ID },
    update: {},
    create: {
      id: OTHER_SITE_ID,
      tenant_id: TENANT_ID,
      name: 'Other Site',
      is_active: true,
    },
  });
  await prisma.user.upsert({
    where: { id: SITE_USER_ID },
    update: {},
    create: {
      id: SITE_USER_ID,
      email: 'site-user@aramo.dev',
      display_name: 'Site User',
      is_active: true,
    },
  });
  await prisma.user.upsert({
    where: { id: TENANT_WIDE_USER_ID },
    update: {},
    create: {
      id: TENANT_WIDE_USER_ID,
      email: 'tenant-wide-user@aramo.dev',
      display_name: 'Tenant Wide User',
      is_active: true,
    },
  });
  await prisma.externalIdentity.upsert({
    where: {
      provider_provider_subject: {
        provider: 'cognito',
        provider_subject: SITE_USER_COGNITO_SUB,
      },
    },
    update: {},
    create: {
      id: uuidv7(),
      user_id: SITE_USER_ID,
      provider: 'cognito',
      provider_subject: SITE_USER_COGNITO_SUB,
    },
  });
  await prisma.externalIdentity.upsert({
    where: {
      provider_provider_subject: {
        provider: 'cognito',
        provider_subject: TENANT_WIDE_COGNITO_SUB,
      },
    },
    update: {},
    create: {
      id: uuidv7(),
      user_id: TENANT_WIDE_USER_ID,
      provider: 'cognito',
      provider_subject: TENANT_WIDE_COGNITO_SUB,
    },
  });
  await prisma.scope.upsert({
    where: { id: SCOPE_ID },
    update: {},
    create: {
      id: SCOPE_ID,
      key: SCOPE_KEY,
      description: 'Read session for tests',
    },
  });
  await prisma.role.upsert({
    where: { id: ROLE_ID },
    update: {},
    create: {
      id: ROLE_ID,
      key: 'site_axis_recruiter',
      description: 'Test role for PR-A1a-3 site axis e2e',
      is_active: true,
    },
  });
  await prisma.roleScope.upsert({
    where: { role_id_scope_id: { role_id: ROLE_ID, scope_id: SCOPE_ID } },
    update: {},
    create: { id: uuidv7(), role_id: ROLE_ID, scope_id: SCOPE_ID },
  });

  // Site-scoped membership (the round-trip subject): site_id = SITE_ID.
  const siteMembershipId = uuidv7();
  await prisma.userTenantMembership.upsert({
    where: {
      user_id_tenant_id: {
        user_id: SITE_USER_ID,
        tenant_id: TENANT_ID,
      },
    },
    update: {},
    create: {
      id: siteMembershipId,
      user_id: SITE_USER_ID,
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
      is_active: true,
    },
  });
  await prisma.userTenantMembershipRole.upsert({
    where: {
      membership_id_role_id: {
        membership_id: siteMembershipId,
        role_id: ROLE_ID,
      },
    },
    update: {},
    create: {
      id: uuidv7(),
      membership_id: siteMembershipId,
      role_id: ROLE_ID,
    },
  });

  // Tenant-wide membership: site_id = null.
  const tenantWideMembershipId = uuidv7();
  await prisma.userTenantMembership.upsert({
    where: {
      user_id_tenant_id: {
        user_id: TENANT_WIDE_USER_ID,
        tenant_id: TENANT_ID,
      },
    },
    update: {},
    create: {
      id: tenantWideMembershipId,
      user_id: TENANT_WIDE_USER_ID,
      tenant_id: TENANT_ID,
      site_id: null,
      is_active: true,
    },
  });
  await prisma.userTenantMembershipRole.upsert({
    where: {
      membership_id_role_id: {
        membership_id: tenantWideMembershipId,
        role_id: ROLE_ID,
      },
    },
    update: {},
    create: {
      id: uuidv7(),
      membership_id: tenantWideMembershipId,
      role_id: ROLE_ID,
    },
  });
}
