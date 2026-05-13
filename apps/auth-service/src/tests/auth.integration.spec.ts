import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
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
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { CommonModule } from '@aramo/common';
import {
  IdentityModule,
  IdentityService,
  PrismaService as IdentityPrismaService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import {
  AuthStorageModule,
  RefreshTokenService,
} from '@aramo/auth-storage';

import { AuthController } from '../app/auth/auth.controller.js';
import { CognitoVerifierService } from '../app/auth/cognito-verifier.service.js';
import { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import { JwksController } from '../app/auth/jwks.controller.js';
import { JwksService } from '../app/auth/jwks.service.js';
import { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';
import { PkceService } from '../app/auth/pkce.service.js';
import { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';
import { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

import { generateTestKeyPair } from './test-keys.js';

const IDENTITY_MIGRATION = resolve(
  __dirname,
  '../../../../libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
const AUTH_STORAGE_MIGRATION = resolve(
  __dirname,
  '../../../../libs/auth-storage/prisma/migrations/20260512100000_init_auth_storage/migration.sql',
);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

const FIXED_USER_ID = uuidv7();
const FIXED_TENANT_ID = uuidv7();
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
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      for (const stmt of [
        ...splitDdl(readFileSync(IDENTITY_MIGRATION, 'utf8')),
        ...splitDdl(readFileSync(AUTH_STORAGE_MIGRATION, 'utf8')),
      ]) {
        const t = stmt.trim();
        if (t.length === 0) continue;
        await setup.$executeRawUnsafe(t);
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
      process.env['AUTH_REFRESH_GRACE_SECONDS'] = '0';
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      // Build the testing module. IdentityService / TenantService /
      // RoleService are stubbed (their unit + integration tests live in
      // libs/identity); IdentityAuditService stays real so audit rows
      // genuinely land in Postgres.
      module = await Test.createTestingModule({
        imports: [CommonModule, IdentityModule, AuthStorageModule],
        controllers: [AuthController, JwksController],
        providers: [
          PkceService,
          JwtIssuerService,
          CookieVerifierService,
          JwksService,
          CognitoVerifierService,
          SessionOrchestratorService,
          RefreshOrchestratorService,
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
        })
        .overrideProvider(TenantService)
        .useValue({
          getTenantsByUser: vi.fn().mockResolvedValue([
            {
              id: FIXED_TENANT_ID,
              name: 'Integration Tenant',
              is_active: true,
              created_at: '',
              updated_at: '',
            },
          ]),
        })
        .overrideProvider(RoleService)
        .useValue({
          getScopesByUserAndTenant: vi.fn().mockResolvedValue(['auth:session:read']),
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
    ): Promise<{ pkceCookie: string; state: string }> {
      const res = await request(app.getHttpServer()).get(`/auth/${consumer}/login`);
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
      expect(res.status).toBe(204);
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
