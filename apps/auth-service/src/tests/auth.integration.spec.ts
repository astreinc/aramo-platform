import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import {
  afterEach,
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
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  AramoExceptionFilter,
  CommonModule,
  resolveIdentityMigrations,
  resolveAuthStorageMigrations,
} from '@aramo/common';
import {
  AuthorizationResolverModule,
  IdentityCoreModule,
  IdentityService,
  PrismaService as IdentityPrismaService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import {
  AuthStorageModule,
  RefreshTokenService,
} from '@aramo/auth-storage';
import { AuthController, PORTAL_SESSION_SCOPES } from '@aramo/auth-core';
import { HostAuthProfileService } from '@aramo/auth-core';
import { HostBaseResolver } from '@aramo/auth-core';
import { CognitoVerifierService } from '@aramo/auth-core';
import { CookieVerifierService } from '@aramo/auth-core';
import { JwksController } from '@aramo/auth-core';
import { JwksService } from '@aramo/auth-core';
import { JwtIssuerService } from '@aramo/auth-core';
import { PkceService } from '@aramo/auth-core';
import { AUDIT_SINK } from '@aramo/auth-core';
import { HOST_CONTEXT_DIRECTORY } from '@aramo/auth-core';
import { PRINCIPAL_DIRECTORY } from '@aramo/auth-core';
import { RefreshOrchestratorService } from '@aramo/auth-core';
import { SessionOrchestratorService } from '@aramo/auth-core';

import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

import { generateTestKeyPair } from './test-keys.js';

// Inc-3 PR-3.6 (Workstream A) — the identity migration set comes from the single
// ordered source of truth (@aramo/common resolveIdentityMigrations), retiring
// the hand-listed consts. This eliminates the readFileSync(IDP, LC, 'utf8') bug
// that jammed the lifecycle-status migration path in as a bogus second
// readFileSync argument (a named-const dup corruption — tsc-invisible, caught
// only when the spec actually runs under ARAMO_RUN_INTEGRATION=1). The
// auth-storage set stays SEPARATE (different schema) via its own helper, applied
// after identity. repoRoot is 4 levels up from apps/auth-service/src/tests.
const REPO_ROOT = resolve(__dirname, '../../../..');
const IDENTITY_MIGRATIONS = resolveIdentityMigrations(REPO_ROOT);
const AUTH_STORAGE_MIGRATIONS = resolveAuthStorageMigrations(REPO_ROOT);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

const FIXED_USER_ID = uuidv7();
const FIXED_TENANT_ID = uuidv7();
// IC-2 PR-4 (L6) — a SECOND tenant that owns another subdomain; the fixed user
// is NOT a member of it. Logging in on its host must never mint a session for
// FIXED_TENANT_ID under enforce.
const OTHER_TENANT_ID = uuidv7();
const OWN_HOST = 'tenanta.aramo.ai';
const OTHER_HOST = 'tenantb.aramo.ai';
const COGNITO_SUB = 'integration-cognito-sub';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-service — integration (real Postgres 17, real refresh-token + audit storage)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let identityPrisma: IdentityPrismaService;
    let refreshTokens: RefreshTokenService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      for (const migrationPath of [
        ...IDENTITY_MIGRATIONS,
        ...AUTH_STORAGE_MIGRATIONS,
      ]) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();

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
        AUTH_COGNITO_SIGNOUT_REDIRECT: process.env['AUTH_COGNITO_SIGNOUT_REDIRECT'],
        // §5 D5 (3.6) Part A — capture/restore AUTH_POST_LOGIN_REDIRECT too, so
        // the callback-success tests (test 39 + the logout/session tests that
        // drive a callback) are SELF-CONTAINED: they no longer depend on the
        // ambient env carrying it. This closes the "test-39 green-in-CI /
        // failing-locally" gap (CI set it ambiently; a local run did not).
        AUTH_POST_LOGIN_REDIRECT: process.env['AUTH_POST_LOGIN_REDIRECT'],
        AUTH_REFRESH_GRACE_SECONDS: process.env['AUTH_REFRESH_GRACE_SECONDS'],
        AUTH_ALLOW_INSECURE_COOKIES: process.env['AUTH_ALLOW_INSECURE_COOKIES'],
        // IC-2 PR-4 — host binding flags + the apex the slug parse anchors to.
        AUTH_HOST_TENANT_BINDING: process.env['AUTH_HOST_TENANT_BINDING'],
        AUTH_ALLOW_UNBOUND_HOST: process.env['AUTH_ALLOW_UNBOUND_HOST'],
        APP_ROOT_DOMAIN: process.env['APP_ROOT_DOMAIN'],
      };
      delete process.env['AUTH_HOST_TENANT_BINDING'];
      delete process.env['AUTH_ALLOW_UNBOUND_HOST'];
      process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
      process.env['AUTH_PRIVATE_KEY'] = privatePem;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['AUTH_PKCE_STATE_KEY'] = randomBytes(32).toString('base64url');
      process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
      process.env['AUTH_COGNITO_CLIENT_ID'] = 'test-client';
      process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://app.example/cb';
      process.env['AUTH_COGNITO_SIGNOUT_REDIRECT'] = 'https://app.example/login';
      process.env['AUTH_POST_LOGIN_REDIRECT'] = 'https://app.example/';
      process.env['AUTH_REFRESH_GRACE_SECONDS'] = '0';
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      // Build the testing module. IdentityService / TenantService /
      // RoleService are stubbed (their unit + integration tests live in
      // libs/identity); IdentityAuditService stays real so audit rows
      // genuinely land in Postgres.
      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          IdentityCoreModule,
          AuthStorageModule,
          // HF-AUTH-1 — bind the REAL server-side resolver (the AuthController
          // /session path resolves scopes through it). RoleService is stubbed
          // below, so the resolver returns the stub's fixed scope set at the
          // baseline authz_version — the same production wiring, no bespoke stub.
          AuthorizationResolverModule.forRoot({
            portalScopes: PORTAL_SESSION_SCOPES,
            scopeCacheTtlSeconds: 300,
          }),
        ],
        controllers: [AuthController, JwksController],
        providers: [
          PkceService,
          JwtIssuerService,
          CookieVerifierService,
          JwksService,
          CognitoVerifierService,
          SessionOrchestratorService,
          RefreshOrchestratorService,
          // PR-4 — PrincipalDirectory + AuditSink bindings (DI ripple, §4).
          IdentityPrincipalDirectoryAdapter,
          IdentityAuditSinkAdapter,
          { provide: PRINCIPAL_DIRECTORY, useClass: IdentityPrincipalDirectoryAdapter },
          { provide: AUDIT_SINK, useClass: IdentityAuditSinkAdapter },
          // PR-5a — HostContextDirectory binding (host resolvers, DI ripple).
          IdentityHostContextAdapter,
          { provide: HOST_CONTEXT_DIRECTORY, useClass: IdentityHostContextAdapter },
          HostAuthProfileService,
          HostBaseResolver,
          // IC-2 PR-5 — the PRODUCTION exception filter (auth.module.ts binds the
          // same APP_FILTER), so error BODIES assert the real contract shape
          // ({ error: { code, details } }) and not Nest's default envelope.
          { provide: APP_FILTER, useClass: AramoExceptionFilter },
        ],
      })
        .overrideProvider(IdentityService)
        .useValue({
          resolveUser: vi.fn().mockResolvedValue({
            id: FIXED_USER_ID,
            email: 'integration@aramo.dev',
            display_name: 'Integration User',
            is_active: true,
            deactivated_at: null,
            created_at: '',
            updated_at: '',
          }),
          // IC-2 PR-5 — the refresh-path eligibility read (User.is_active).
          findUserById: vi.fn().mockResolvedValue({ id: FIXED_USER_ID, is_active: true }),
        })
        .overrideProvider(TenantService)
        .useValue({
          getTenantsByUser: vi.fn().mockResolvedValue([
            {
              id: FIXED_TENANT_ID,
              name: 'Integration Tenant',
              is_active: true,
              status: 'ACTIVE',
              created_at: '',
              updated_at: '',
            },
          ]),
          // IC-2 PR-4 (L6) — the host→tenant read behind HostContextDirectory:
          // two slugged tenants; the fixed user belongs to tenanta only.
          findActiveBySlug: vi.fn(async (slug: string) =>
            slug === 'tenanta'
              ? { id: FIXED_TENANT_ID, name: 'Integration Tenant', is_active: true, identity_provider: null, status: 'ACTIVE' }
              : slug === 'tenantb'
                ? { id: OTHER_TENANT_ID, name: 'Other Tenant', is_active: true, identity_provider: null, status: 'ACTIVE' }
                : null,
          ),
        })
        .overrideProvider(RoleService)
        .useValue({
          // PR-A1a-3 Ruling 2: default to null → tenant-wide path,
          // tokens byte-identical to pre-A1a-3 (no site_id claim).
          findActiveMembershipSite: vi.fn().mockResolvedValue(null),
          getScopesByUserAndTenant: vi.fn().mockResolvedValue(['auth:session:read']),
          getScopesByUserTenantAndSite: vi.fn().mockResolvedValue(['auth:session:read']),
        })
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
        req.requestId = 'integration-req';
        next();
      });
      await app.init();

      identityPrisma = module.get(IdentityPrismaService);
      refreshTokens = module.get(RefreshTokenService);
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function stubCognitoVerifyOnly(): void {
      vi.spyOn(CognitoVerifierService.prototype, 'verify').mockResolvedValue({
        sub: COGNITO_SUB,
        email: 'integration@aramo.dev',
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

    async function prepareLogin(
      consumer: string,
      host?: string,
    ): Promise<{ pkceCookie: string; state: string }> {
      let req = request(app.getHttpServer()).get(`/auth/${consumer}/login`);
      if (host !== undefined) req = req.set('Host', host);
      const res = await req;
      expect(res.status).toBe(302);
      const setCookies = res.headers['set-cookie'] as unknown as string[];
      const cookieHeader = (Array.isArray(setCookies) ? setCookies : [setCookies as string])
        .find((c) => c.startsWith('aramo_pkce_state='))!;
      const pkceCookie = cookieHeader.split(';')[0]!;
      const state = new URL(res.headers['location']!).searchParams.get('state')!;
      return { pkceCookie, state };
    }

    // Test 39
    it('test 39 — /callback issues access + refresh cookies; refresh row + audit row written', async () => {
      stubCognitoVerifyOnly();
      const { pkceCookie, state } = await prepareLogin('recruiter');
      const res = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      // §5 D2: callback success is a top-level browser 302 to
      // AUTH_POST_LOGIN_REDIRECT (was a bodyless 204 pre-D2). The cookies are
      // set on the redirect response. (Updated from the stale 204 assertion;
      // beforeAll now sets AUTH_POST_LOGIN_REDIRECT so this no longer 500s
      // off-CI — §5 D5 Part A.)
      expect(res.status).toBe(302);
      // Inc-3 PR-3.6 (Workstream B): PR-3.1 host-derivation now wins over the
      // legacy AUTH_POST_LOGIN_REDIRECT env. The request host (127.0.0.1:<port>)
      // is a dev-posture localhost (a VALIDATED host under AUTH_ALLOW_INSECURE_
      // COOKIES), so the post-login redirect derives to that host + the post-
      // login path ('/'), NOT the env's https://app.example/. This spec never
      // ran (the readFileSync bug retired in Workstream A) so it never caught
      // the 3.1 behavior change; the derived-host redirect is the correct
      // production path (a real tenant host derives https://<tenant>/…).
      expect(res.headers['location']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('aramo_access_token='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('aramo_refresh_token='))).toBe(true);

      const audits = await identityPrisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.session.issued', actor_id: FIXED_USER_ID },
      });
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[audits.length - 1]!.tenant_id).toBe(FIXED_TENANT_ID);
      unstubCognito();
    });

    // Test 40
    // IC-2 PR-4 — L6 (host-bound login) and F-8 (legacy PKCE cookies), real
    // HTTP through the real HostBaseResolver → IdentityHostContextAdapter →
    // the stubbed findActiveBySlug, with the real PKCE sealing.
    describe('IC-2 PR-4 — session tenant binding (L6) + legacy PKCE (F-8)', () => {
      afterEach(() => {
        delete process.env['AUTH_HOST_TENANT_BINDING'];
        delete process.env['AUTH_ALLOW_UNBOUND_HOST'];
        unstubCognito();
      });

      async function callbackOn(host: string, pkceCookie: string, state: string) {
        return request(app.getHttpServer())
          .get(`/auth/recruiter/callback?code=c&state=${state}`)
          .set('Host', host)
          .set('Cookie', pkceCookie);
      }

      it('L6 enforce — login on ANOTHER tenant\'s host cannot mint a session: 302 /login?error=TENANT_ACCESS_DENIED, no cookies, no refresh row', async () => {
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        stubCognitoVerifyOnly();
        const { pkceCookie, state } = await prepareLogin('recruiter', OTHER_HOST);
        const res = await callbackOn(OTHER_HOST, pkceCookie, state);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toBe(`https://${OTHER_HOST}/login?error=TENANT_ACCESS_DENIED`);
        const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
        expect(cookies.some((c) => c.startsWith('aramo_access_token=') && !c.includes('Max-Age=0'))).toBe(false);
        expect(cookies.some((c) => c.startsWith('aramo_refresh_token='))).toBe(false);
      });

      it('L6 enforce — login on the user\'s OWN tenant host mints normally (302 to that host)', async () => {
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        stubCognitoVerifyOnly();
        const { pkceCookie, state } = await prepareLogin('recruiter', OWN_HOST);
        const res = await callbackOn(OWN_HOST, pkceCookie, state);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toBe(`https://${OWN_HOST}/`);
        const cookies = res.headers['set-cookie'] as unknown as string[];
        expect(cookies.some((c) => c.startsWith('aramo_access_token='))).toBe(true);
      });

      it('L6 log (default) — login on ANOTHER tenant\'s host keeps today\'s outcome (302 success)', async () => {
        stubCognitoVerifyOnly();
        const { pkceCookie, state } = await prepareLogin('recruiter', OTHER_HOST);
        const res = await callbackOn(OTHER_HOST, pkceCookie, state);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toBe(`https://${OTHER_HOST}/`);
      });

      it('L6 enforce — a cookie sealed on one tenant host presented at another host is refused BEFORE the code exchange', async () => {
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        stubCognitoVerifyOnly();
        const { pkceCookie, state } = await prepareLogin('recruiter', OWN_HOST);
        const res = await callbackOn(OTHER_HOST, pkceCookie, state);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toBe(`https://${OTHER_HOST}/login?error=TENANT_ACCESS_DENIED`);
        expect(globalThis.fetch).not.toHaveBeenCalled();
      });

      it('F-8 — a LEGACY PKCE cookie (no sealed host) on the dev host: allowed under log, refused under enforce, allowed again with AUTH_ALLOW_UNBOUND_HOST=true', async () => {
        const pkce = module.get(PkceService);
        const legacy = (): { pkceCookie: string; state: string } => {
          const pair = pkce.generate();
          const cipher = pkce.encryptState({
            verifier: pair.verifier,
            state: pair.state,
            consumer: 'recruiter',
            issued_at: Math.floor(Date.now() / 1000),
          });
          return { pkceCookie: `aramo_pkce_state=${cipher}`, state: pair.state };
        };
        stubCognitoVerifyOnly();
        // log (default): unchanged outcome on the dev host.
        let c = legacy();
        let res = await request(app.getHttpServer())
          .get(`/auth/recruiter/callback?code=c&state=${c.state}`)
          .set('Cookie', c.pkceCookie);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        // enforce: unbound → refused.
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        c = legacy();
        res = await request(app.getHttpServer())
          .get(`/auth/recruiter/callback?code=c&state=${c.state}`)
          .set('Cookie', c.pkceCookie);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toMatch(/\/login\?error=TENANT_ACCESS_DENIED$/);
        // enforce + the explicit dev exception: allowed.
        process.env['AUTH_ALLOW_UNBOUND_HOST'] = 'true';
        c = legacy();
        res = await request(app.getHttpServer())
          .get(`/auth/recruiter/callback?code=c&state=${c.state}`)
          .set('Cookie', c.pkceCookie);
        expect(res.status).toBe(302);
        expect(res.headers['location']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      });
    });

    // IC-2 PR-5 — session security: /session + /refresh + /logout host binding,
    // refresh eligibility (disabled user, suspended tenant, foreign-tenant token),
    // real HTTP + real refresh-token storage + real PKCE + the stubbed reads.
    describe('IC-2 PR-5 — session, refresh and logout hardening', () => {
      afterEach(() => {
        delete process.env['AUTH_HOST_TENANT_BINDING'];
        delete process.env['AUTH_ALLOW_UNBOUND_HOST'];
        unstubCognito();
      });

      async function loginOn(host: string): Promise<{ access: string; refresh: string }> {
        stubCognitoVerifyOnly();
        const { pkceCookie, state } = await prepareLogin('recruiter', host);
        const res = await request(app.getHttpServer())
          .get(`/auth/recruiter/callback?code=c&state=${state}`)
          .set('Host', host)
          .set('Cookie', pkceCookie);
        expect(res.status).toBe(302);
        const cookies = res.headers['set-cookie'] as unknown as string[];
        const pick = (n: string) => cookies.find((c) => c.startsWith(`${n}=`))!.split(';')[0]!;
        return { access: pick('aramo_access_token'), refresh: pick('aramo_refresh_token') };
      }
      const tenantSvc = () => module.get(TenantService) as unknown as { getTenantsByUser: ReturnType<typeof vi.fn> };
      const identitySvc = () => module.get(IdentityService) as unknown as { findUserById: ReturnType<typeof vi.fn> };

      it('1. /session on ANOTHER tenant\'s host: enforce → 403 TENANT_ACCESS_DENIED (no scopes); log → 200', async () => {
        const { access } = await loginOn(OWN_HOST);
        const logRes = await request(app.getHttpServer()).get('/auth/recruiter/session').set('Host', OTHER_HOST).set('Cookie', access);
        expect(logRes.status).toBe(200);
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        const res = await request(app.getHttpServer()).get('/auth/recruiter/session').set('Host', OTHER_HOST).set('Cookie', access);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('TENANT_ACCESS_DENIED');
        expect(res.body.error.details.reason).toBe('host_tenant_mismatch');
        expect(JSON.stringify(res.body)).not.toContain(OTHER_TENANT_ID);
        expect(JSON.stringify(res.body)).not.toContain(FIXED_TENANT_ID);
        const own = await request(app.getHttpServer()).get('/auth/recruiter/session').set('Host', OWN_HOST).set('Cookie', access);
        expect(own.status).toBe(200);
        expect(own.body.tenant_id).toBe(FIXED_TENANT_ID);
      });

      it('2. /refresh under a mismatched host (enforce) → 401 REFRESH_TOKEN_INVALID host_tenant_mismatch, both cookies cleared, token NOT rotated; missing host context → host_unbound', async () => {
        const { refresh } = await loginOn(OWN_HOST);
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        const res = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OTHER_HOST).set('Cookie', refresh);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
        expect(res.body.error.details.reason).toBe('host_tenant_mismatch');
        const cleared = res.headers['set-cookie'] as unknown as string[];
        expect(cleared.filter((c) => c.includes('Max-Age=0')).length).toBe(2);
        // 8/10. the same token still refreshes on the OWN host (not rotated by the refusal)
        const ok = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OWN_HOST).set('Cookie', refresh);
        expect(ok.status).toBe(200);
        // unbound dev host (127.0.0.1) under enforce → host_unbound; with the dev exception → 200
        const { refresh: r2 } = await loginOn(OWN_HOST);
        const unbound = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Cookie', r2);
        expect(unbound.status).toBe(401);
        expect(unbound.body.error.details.reason).toBe('host_unbound');
      });

      it('3. SUSPENDED tenant refresh → 401 tenant_suspended; token revoked server-side (a retained copy cannot resume after reactivation)', async () => {
        const { refresh } = await loginOn(OWN_HOST);
        tenantSvc().getTenantsByUser.mockResolvedValueOnce([{ id: FIXED_TENANT_ID, name: 'Integration Tenant', is_active: true, status: 'SUSPENDED', created_at: '', updated_at: '' }]);
        const res = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OWN_HOST).set('Cookie', refresh);
        expect(res.status).toBe(401);
        expect(res.body.error.details.reason).toBe('tenant_suspended');
        // tenant back to ACTIVE: the revoked token is still refused (explicitly_revoked)
        const again = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OWN_HOST).set('Cookie', refresh);
        expect(again.status).toBe(401);
        expect(again.body.error.details.reason).toBe('explicitly_revoked');
        // Deterministic: match the audit row by its payload reason (several
        // session.revoked rows share a second in this file).
        const revokedAudit = await identityPrisma.identityAuditEvent.findFirst({
          where: {
            event_type: 'identity.session.revoked',
            actor_id: FIXED_USER_ID,
            event_payload: { path: ['reason'], equals: 'refresh_denied:tenant_suspended' },
          },
        });
        expect(revokedAudit).not.toBeNull();
      });

      it('4. disabled User (is_active=false) refresh → 401 user_inactive; and login mint refused (user_inactive)', async () => {
        const { refresh } = await loginOn(OWN_HOST);
        identitySvc().findUserById.mockResolvedValueOnce({ id: FIXED_USER_ID, is_active: false });
        const res = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OWN_HOST).set('Cookie', refresh);
        expect(res.status).toBe(401);
        expect(res.body.error.details.reason).toBe('user_inactive');
        // login mint for a deactivated identity
        stubCognitoVerifyOnly();
        const idSvc = module.get(IdentityService) as unknown as { resolveUser: ReturnType<typeof vi.fn> };
        idSvc.resolveUser.mockResolvedValueOnce({ id: FIXED_USER_ID, email: 'integration@aramo.dev', display_name: null, is_active: false, deactivated_at: '2026-10-14T00:00:00.000Z', created_at: '', updated_at: '' });
        const { pkceCookie, state } = await prepareLogin('recruiter', OWN_HOST);
        const cb = await request(app.getHttpServer()).get(`/auth/recruiter/callback?code=c&state=${state}`).set('Host', OWN_HOST).set('Cookie', pkceCookie);
        expect(cb.status).toBe(302);
        expect(cb.headers['location']).toBe(`https://${OWN_HOST}/login?error=INSUFFICIENT_PERMISSIONS`);
      });

      it('7. logout on ANOTHER tenant\'s host (enforce): 204, cookies cleared, token revoked, audit records the mismatch — never strands', async () => {
        const { refresh } = await loginOn(OWN_HOST);
        process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
        const res = await request(app.getHttpServer()).post('/auth/recruiter/logout').set('Host', OTHER_HOST).set('Cookie', refresh);
        expect(res.status).toBe(204);
        const cleared = res.headers['set-cookie'] as unknown as string[];
        expect(cleared.filter((c) => c.includes('Max-Age=0')).length).toBe(2);
        const after = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OWN_HOST).set('Cookie', refresh);
        expect(after.status).toBe(401);
        expect(after.body.error.details.reason).toBe('explicitly_revoked');
        const audit = await identityPrisma.identityAuditEvent.findFirst({
          where: {
            event_type: 'identity.session.revoked',
            actor_id: FIXED_USER_ID,
            event_payload: { path: ['reason'], equals: 'logout_host_tenant_mismatch' },
          },
        });
        expect(audit).not.toBeNull();
      });

      it('10. a stored refresh token for a tenant the user does NOT own cannot re-mint that tenant → 401 membership_inactive', async () => {
        const plain = randomBytes(32).toString('base64url');
        await refreshTokens.create({
          user_id: FIXED_USER_ID,
          tenant_id: OTHER_TENANT_ID,
          consumer_type: 'recruiter',
          token_hash: createHash('sha256').update(plain).digest('base64url'),
          expires_at: new Date(Date.now() + 60_000),
        });
        const res = await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OTHER_HOST).set('Cookie', `aramo_refresh_token=${plain}`);
        expect(res.status).toBe(401);
        expect(res.body.error.details.reason).toBe('membership_inactive');
      });

      it('9. log (default): mismatched-host refresh and session keep today\'s outcome', async () => {
        const { access, refresh } = await loginOn(OWN_HOST);
        expect((await request(app.getHttpServer()).get('/auth/recruiter/session').set('Host', OTHER_HOST).set('Cookie', access)).status).toBe(200);
        expect((await request(app.getHttpServer()).post('/auth/recruiter/refresh').set('Host', OTHER_HOST).set('Cookie', refresh)).status).toBe(200);
      });
    });

    it('test 40 — /refresh rotates: old revoked + linked, new row created, audit row', async () => {
      stubCognitoVerifyOnly();
      const { pkceCookie, state } = await prepareLogin('recruiter');
      const cb = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      const refreshHeader = (cb.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('aramo_refresh_token='))!;
      const refreshCookie = refreshHeader.split(';')[0]!;
      const refreshPlaintext = refreshCookie.split('=')[1]!;

      const res = await request(app.getHttpServer())
        .post('/auth/recruiter/refresh')
        .set('Cookie', refreshCookie);
      expect(res.status).toBe(200);

      const oldHash = createHash('sha256').update(refreshPlaintext).digest('base64url');
      const oldRow = await refreshTokens.findByHash({ token_hash: oldHash });
      expect(oldRow!.revoked_at).not.toBeNull();
      expect(oldRow!.replaced_by_id).not.toBeNull();

      const refreshedAudits = await identityPrisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.session.refreshed', actor_id: FIXED_USER_ID },
      });
      expect(refreshedAudits.length).toBeGreaterThan(0);
      unstubCognito();
    });

    // Test 41
    it('test 41 — reuse with old token past grace triggers R.2 cascade + reuse_detected event', async () => {
      stubCognitoVerifyOnly();
      const { pkceCookie, state } = await prepareLogin('recruiter');
      const cb = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      const refreshCookie = (cb.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('aramo_refresh_token='))!
        .split(';')[0]!;
      const r1 = await request(app.getHttpServer())
        .post('/auth/recruiter/refresh')
        .set('Cookie', refreshCookie);
      expect(r1.status).toBe(200);
      const r2 = await request(app.getHttpServer())
        .post('/auth/recruiter/refresh')
        .set('Cookie', refreshCookie);
      expect(r2.status).toBe(401);

      const reuse = await identityPrisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.session.reuse_detected', actor_id: FIXED_USER_ID },
      });
      expect(reuse.length).toBeGreaterThanOrEqual(1);
      unstubCognito();
    });

    // Test 43
    it('test 43 — /logout revokes row, emits revoked audit, clears cookies', async () => {
      stubCognitoVerifyOnly();
      const { pkceCookie, state } = await prepareLogin('recruiter');
      const cb = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      const refreshCookie = (cb.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('aramo_refresh_token='))!
        .split(';')[0]!;
      const res = await request(app.getHttpServer())
        .post('/auth/recruiter/logout')
        .set('Cookie', refreshCookie);
      expect(res.status).toBe(204);
      const audits = await identityPrisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.session.revoked', actor_id: FIXED_USER_ID },
      });
      expect(audits.length).toBeGreaterThan(0);
      unstubCognito();
    });

    // Test 43b — §5 D3: GET /logout 302-redirects to the Cognito hosted-UI
    // /logout with client_id + the REGISTERED logout_uri (open-redirect-safe).
    // Cookie-less + idempotent: it reveals nothing and needs no session.
    it('test 43b — GET /logout redirects 302 to Cognito /logout with registered logout_uri', async () => {
      const res = await request(app.getHttpServer()).get(
        '/auth/recruiter/logout',
      );
      expect(res.status).toBe(302);
      const location = res.headers['location'] as string;
      const url = new URL(location);
      expect(url.origin).toBe('https://auth.example.com');
      expect(url.pathname).toBe('/logout');
      expect(url.searchParams.get('client_id')).toBe('test-client');
      // Inc-3 PR-3.6 (Workstream B): PR-3.1 host-derivation makes the post-
      // signout landing (logout_uri) derive from the VALIDATED request host
      // (dev-posture 127.0.0.1:<port>) rather than the legacy
      // AUTH_COGNITO_SIGNOUT_REDIRECT env. Still open-redirect-safe — the base
      // comes from the dev allowlist, never the raw Host (PR-3.1 §2). The
      // never-run spec asserted the pre-3.1 env value.
      // T2-E1-HF3 (HF3-G5-R3): the ruled post-logout landing is the public
      // /signed-out route, NOT the guarded /. Still host-derived + open-redirect-safe.
      expect(url.searchParams.get('logout_uri')).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/signed-out$/,
      );
    });

    // Test 44
    it('test 44 — /session returns 6-field SessionResponse without audit emission', async () => {
      stubCognitoVerifyOnly();
      const { pkceCookie, state } = await prepareLogin('recruiter');
      const cb = await request(app.getHttpServer())
        .get(`/auth/recruiter/callback?code=c&state=${state}`)
        .set('Cookie', pkceCookie);
      const accessCookie = (cb.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('aramo_access_token='))!
        .split(';')[0]!;
      const before = await identityPrisma.identityAuditEvent.count();
      const res = await request(app.getHttpServer())
        .get('/auth/recruiter/session')
        .set('Cookie', accessCookie);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual([
        'consumer_type',
        'exp',
        'iat',
        'scopes',
        'sub',
        'tenant_id',
      ]);
      const after = await identityPrisma.identityAuditEvent.count();
      expect(after).toBe(before);
      unstubCognito();
    });

    // Test 45
    it('test 45 — /.well-known/jwks.json returns single-key JWKS with valid kid', async () => {
      const res = await request(app.getHttpServer()).get('/.well-known/jwks.json');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('max-age=300');
      const body = res.body as { keys: Array<{ kid: string; alg: string; use: string }> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0]!.alg).toBe('RS256');
      expect(body.keys[0]!.use).toBe('sig');
      expect(typeof body.keys[0]!.kid).toBe('string');
    });
  },
);
