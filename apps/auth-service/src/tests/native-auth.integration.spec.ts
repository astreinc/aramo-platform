import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { decodeJwt } from 'jose';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  AramoExceptionFilter,
  CommonModule,
  resolveAuthStorageMigrations,
  resolveIdentityMigrations,
} from '@aramo/common';
import {
  AuthorizationResolverModule,
  IdentityCoreModule,
  IdentityProviderPolicyService,
  IdentityService,
  PrismaService as IdentityPrismaService,
  RoleService,
  TenantEntitlementReader,
  TenantService,
} from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { JwtAuthGuard } from '@aramo/auth';
import {
  AUDIT_SINK,
  AuthController,
  CognitoVerifierService,
  CookieVerifierService,
  HOST_CONTEXT_DIRECTORY,
  HostAuthProfileService,
  HostBaseResolver,
  JwtIssuerService,
  NATIVE_CODE_EXCHANGE,
  NativeAuthController,
  NativeAuthService,
  PORTAL_SESSION_SCOPES,
  PRINCIPAL_DIRECTORY,
  PkceService,
  RefreshOrchestratorService,
  SessionOrchestratorService,
} from '@aramo/auth-core';

import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

import {
  APP_LINK_CALLBACK,
  FakeCognito,
  SCHEME_CALLBACK,
  ensureVerifierLoaded,
  localJwksVerifier,
  nativeEnv,
  newVerifier,
  type FakeIdentity,
} from './native-auth.test-fixtures.js';
import { generateTestKeyPair } from './test-keys.js';

// AUTH-SIGNIN-1 Amendment M-A1 — the native authentication consumer end to end:
// real HTTP through NativeAuthController, real Postgres 17 (identity + the
// auth_storage chain incl. the additive native migration), real refresh-token,
// device-session, ledger and audit storage, the real principal adapter, the real
// CognitoVerifierService (local JWKS) and a FAKE Cognito token endpoint behind
// NATIVE_CODE_EXCHANGE (never the network). Identity reads are stubbed as in
// auth.integration.spec.ts; the provider policy is stubbed per case.

const REPO_ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  ...resolveIdentityMigrations(REPO_ROOT),
  ...resolveAuthStorageMigrations(REPO_ROOT),
];
function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}
const sha = (s: string): string => createHash('sha256').update(s).digest('base64url');

const USER_A = '01900000-0000-7000-8000-0000000000a1';
const USER_B = '01900000-0000-7000-8000-0000000000b1';
const TENANT = '01900000-0000-7000-8000-0000000000c1';
const ALICE: FakeIdentity = { sub: 'int-sub-a', email: 'alice@example.com', idp: 'google' };
const BOB: FakeIdentity = { sub: 'int-sub-b', email: 'bob@example.com', idp: 'google' };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-service — native authentication consumer (M-A1) integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: IdentityPrismaService;
    let fake: FakeCognito;
    let port = 0;
    const capabilities = new Set<string>(['core', 'sign']);
    const policy = { googleOnly: false };
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();

      const { privatePem, publicPem } = generateTestKeyPair();
      const env: Record<string, string> = {
        ...nativeEnv(),
        DATABASE_URL: url,
        AUTH_AUDIENCE: 'aramo-native-int',
        AUTH_PRIVATE_KEY: privatePem,
        AUTH_PUBLIC_KEY: publicPem,
        AUTH_PKCE_STATE_KEY: randomBytes(32).toString('base64url'),
        AUTH_REFRESH_GRACE_SECONDS: '0',
        AUTH_ALLOW_INSECURE_COOKIES: 'true',
      };
      for (const k of [...Object.keys(env), 'AUTH_COGNITO_ISSUER', 'SIGN_NATIVE_REDIRECT_URIS', 'AUTH_HOST_TENANT_BINDING', 'AUTH_ALLOW_UNBOUND_HOST']) {
        saved[k] = process.env[k];
      }
      Object.assign(process.env, env);
      delete process.env['AUTH_COGNITO_ISSUER'];
      delete process.env['SIGN_NATIVE_REDIRECT_URIS'];
      delete process.env['AUTH_HOST_TENANT_BINDING'];
      delete process.env['AUTH_ALLOW_UNBOUND_HOST'];

      fake = new FakeCognito();
      const verifier = localJwksVerifier(fake);
      await ensureVerifierLoaded(verifier);
      const bySub: Record<string, string> = { [ALICE.sub]: USER_A, [BOB.sub]: USER_B };

      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          IdentityCoreModule,
          AuthStorageModule,
          AuthorizationResolverModule.forRoot({ portalScopes: PORTAL_SESSION_SCOPES, scopeCacheTtlSeconds: 300 }),
        ],
        controllers: [AuthController, NativeAuthController],
        providers: [
          PkceService,
          JwtIssuerService,
          CookieVerifierService,
          SessionOrchestratorService,
          RefreshOrchestratorService,
          NativeAuthService,
          JwtAuthGuard,
          { provide: NATIVE_CODE_EXCHANGE, useValue: fake },
          { provide: CognitoVerifierService, useValue: verifier },
          IdentityPrincipalDirectoryAdapter,
          IdentityAuditSinkAdapter,
          { provide: PRINCIPAL_DIRECTORY, useClass: IdentityPrincipalDirectoryAdapter },
          { provide: AUDIT_SINK, useClass: IdentityAuditSinkAdapter },
          IdentityHostContextAdapter,
          { provide: HOST_CONTEXT_DIRECTORY, useClass: IdentityHostContextAdapter },
          HostAuthProfileService,
          HostBaseResolver,
          { provide: APP_FILTER, useClass: AramoExceptionFilter },
        ],
      })
        .overrideProvider(IdentityService)
        .useValue({
          resolveUser: vi.fn(async ({ provider_subject }: { provider_subject: string }) =>
            bySub[provider_subject] === undefined
              ? null
              : { id: bySub[provider_subject], email: 'x@example.com', is_active: true, deactivated_at: null, created_at: '', updated_at: '' },
          ),
          findUserByEmail: vi.fn(async () => null),
          findUserById: vi.fn(async (id: string) => ({ id, is_active: true })),
        })
        .overrideProvider(TenantService)
        .useValue({
          getTenantsByUser: vi.fn(async () => [{ id: TENANT, name: 'Personal', is_active: true, status: 'ACTIVE', created_at: '', updated_at: '' }]),
          findActiveBySlug: vi.fn(async () => null),
        })
        .overrideProvider(RoleService)
        .useValue({
          findActiveMembershipSite: vi.fn(async () => null),
          getScopesByUserAndTenant: vi.fn(async () => ['esign:envelope:read']),
          getScopesByUserTenantAndSite: vi.fn(async () => ['esign:envelope:read']),
        })
        .overrideProvider(TenantEntitlementReader)
        .useValue({ getCapabilities: vi.fn(async () => new Set(capabilities)) })
        // A Personal tenant pins Google (Personal Free Launch v1.1 §5); the real
        // pin logic is unit-tested in libs/identity — here it is switchable.
        .overrideProvider(IdentityProviderPolicyService)
        .useValue({
          evaluate: vi.fn(async ({ idp }: { idp: string | null }) =>
            policy.googleOnly && idp !== 'google' ? { ok: false, reason: 'idp_not_permitted_for_tenant' } : { ok: true, pinned_now: false },
          ),
          recordLinkIdp: vi.fn(async () => undefined),
        })
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
        req.requestId = 'native-int-req';
        next();
      });
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      db = module.get(IdentityPrismaService);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    afterEach(() => {
      policy.googleOnly = false;
      capabilities.clear();
      capabilities.add('core');
      capabilities.add('sign');
      delete process.env['AUTH_HOST_TENANT_BINDING'];
    });

    function body(identity: FakeIdentity, device = { installation_id: 'inst-1', platform: 'ios', app_version: '1.0.0' }) {
      const code_verifier = newVerifier();
      const nonce = `nonce-${randomBytes(8).toString('hex')}`;
      const code = fake.authorize({ verifier: code_verifier, nonce, identity });
      return { code, code_verifier, redirect_uri: APP_LINK_CALLBACK, nonce, device };
    }

    async function token(identity: FakeIdentity = ALICE) {
      const res = await request(app.getHttpServer()).post('/auth/native/sign/token').send(body(identity));
      expect(res.status).toBe(200);
      return res.body as { access_token: string; refresh_token: string; device_session_id: string };
    }

    async function auditRows(event_type: string) {
      return db.identityAuditEvent.findMany({ where: { event_type } });
    }

    it('lifecycle: token (no-store, no cookies, hashed at rest, native audit) → sessions → rotated refresh → reuse cascade', async () => {
      const res = await request(app.getHttpServer()).post('/auth/native/sign/token').send(body(ALICE));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['set-cookie']).toBeUndefined();
      const t1 = res.body as { access_token: string; refresh_token: string; device_session_id: string; token_type: string; expires_in: number };
      expect(t1.token_type).toBe('Bearer');
      expect(t1.expires_in).toBe(900);
      expect(decodeJwt(t1.access_token)).toMatchObject({ sub: USER_A, consumer_type: 'sign', tenant_id: TENANT, client: 'native', dsid: t1.device_session_id });

      const rows = (await db.$queryRawUnsafe(
        `SELECT token_hash, consumer_type FROM "auth_storage"."RefreshToken"`,
      )) as { token_hash: string; consumer_type: string }[];
      expect(rows.some((r) => r.token_hash === sha(t1.refresh_token) && r.consumer_type === 'sign_native')).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(t1.refresh_token);
      const issued = await auditRows('identity.session.issued');
      expect(issued.some((e) => (e.event_payload as Record<string, unknown>)['device_session_id'] === t1.device_session_id && (e.event_payload as Record<string, unknown>)['client'] === 'native')).toBe(true);

      const list = await request(app.getHttpServer())
        .get('/auth/native/sign/sessions')
        .set('Authorization', `Bearer ${t1.access_token}`)
        .set('X-Aramo-Consumer', 'sign');
      expect(list.status).toBe(200);
      expect(list.headers['cache-control']).toBe('no-store');
      expect(list.body.items).toEqual([expect.objectContaining({ device_session_id: t1.device_session_id, current: true, platform: 'ios' })]);

      const r2 = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: t1.refresh_token });
      expect(r2.status).toBe(200);
      expect(r2.headers['cache-control']).toBe('no-store');
      expect(r2.body.refresh_token).not.toBe(t1.refresh_token);
      expect(r2.body.device_session_id).toBe(t1.device_session_id);

      await new Promise((r) => setTimeout(r, 25)); // past the 0 s grace window
      const reuse = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: t1.refresh_token });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error).toMatchObject({ code: 'REFRESH_TOKEN_INVALID', details: { reason: 'reuse_detected' } });
      const reuseAudit = await auditRows('identity.session.reuse_detected');
      expect(reuseAudit.some((e) => e.actor_id === USER_A && (e.event_payload as Record<string, unknown>)['client'] === 'native')).toBe(true);
      const live = (await db.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "auth_storage"."NativeDeviceSession" WHERE user_id = '${USER_A}'::uuid AND revoked_at IS NULL`,
      )) as { n: number }[];
      expect(live[0]!.n).toBe(0);
      const after = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: r2.body.refresh_token });
      expect(after.status).toBe(401);
    });

    it('code replay across device, client and redirect URI is refused (one ledger row, one session)', async () => {
      const b = body(BOB);
      const first = await request(app.getHttpServer()).post('/auth/native/sign/token').send(b);
      expect(first.status).toBe(200);
      const otherDevice = await request(app.getHttpServer())
        .post('/auth/native/sign/token')
        .send({ ...b, device: { installation_id: 'stolen-phone', platform: 'android', app_version: '9.9.9' } });
      expect(otherDevice.status).toBe(401);
      expect(otherDevice.body.error.details.reason).toBe('code_already_redeemed');
      const otherRedirect = await request(app.getHttpServer()).post('/auth/native/sign/token').send({ ...b, redirect_uri: SCHEME_CALLBACK });
      expect(otherRedirect.body.error.details.reason).toBe('code_already_redeemed');
      const unlisted = await request(app.getHttpServer()).post('/auth/native/sign/token').send({ ...b, redirect_uri: 'https://evil.example/cb' });
      expect(unlisted.status).toBe(400);
      expect(unlisted.body.error.details.reason).toBe('redirect_uri_not_allowed');
      const ledger = (await db.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "auth_storage"."NativeRedeemedCode" WHERE code_hash = '${sha(b.code)}'`,
      )) as { n: number }[];
      expect(ledger[0]!.n).toBe(1);
      // Another CLIENT's code (issued to the browser app client) never mints.
      const v = newVerifier();
      const browserCode = fake.authorize({ client_id: 'aramo-browser-test', verifier: v, nonce: 'n-browser', identity: BOB });
      const crossClient = await request(app.getHttpServer()).post('/auth/native/sign/token').send({ ...body(BOB), code: browserCode, code_verifier: v, nonce: 'n-browser' });
      expect(crossClient.status).toBe(401);
      expect(crossClient.body.error.details.reason).toBe('code_exchange_rejected');
    });

    it('Personal Microsoft is refused (403 TENANT_ACCESS_DENIED idp_not_permitted_for_tenant) and creates no device session', async () => {
      policy.googleOnly = true;
      const before = (await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "auth_storage"."NativeDeviceSession"`)) as { n: number }[];
      const res = await request(app.getHttpServer()).post('/auth/native/sign/token').send(body({ ...ALICE, idp: 'microsoft' }));
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'TENANT_ACCESS_DENIED', details: { reason: 'idp_not_permitted_for_tenant' } });
      const after = (await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "auth_storage"."NativeDeviceSession"`)) as { n: number }[];
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it('another user\'s device session: never listed, revoke → 404, untouched', async () => {
      const a = await token(ALICE);
      const b = await token(BOB);
      const list = await request(app.getHttpServer()).get('/auth/native/sign/sessions').set('Authorization', `Bearer ${a.access_token}`);
      expect(JSON.stringify(list.body)).not.toContain(b.device_session_id);
      const del = await request(app.getHttpServer())
        .delete(`/auth/native/sign/sessions/${b.device_session_id}`)
        .set('Authorization', `Bearer ${a.access_token}`);
      expect(del.status).toBe(404);
      expect(del.body.error).toMatchObject({ code: 'NOT_FOUND', details: { reason: 'device_session_not_found' } });
      const ok = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: b.refresh_token });
      expect(ok.status).toBe(200);
      // Own device revoke works and kills that device's refresh family.
      const a2 = await token(ALICE);
      const mine = await request(app.getHttpServer())
        .delete(`/auth/native/sign/sessions/${a2.device_session_id}`)
        .set('Authorization', `Bearer ${a.access_token}`);
      expect(mine.status).toBe(204);
      const dead = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: a2.refresh_token });
      expect(dead.status).toBe(401);
      // A browser (cookie-only) caller cannot use the device routes.
      const noBearer = await request(app.getHttpServer()).get('/auth/native/sign/sessions').set('Cookie', `aramo_access_token_sign=${a.access_token}`);
      expect(noBearer.status).toBe(401);
      expect(noBearer.body.error.details.reason).toBe('bearer_required');
    });

    it('capability loss at refresh: 401 consumer_not_entitled and the device session is revoked in the database', async () => {
      const a = await token(ALICE);
      capabilities.delete('sign');
      const res = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: a.refresh_token });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: 'REFRESH_TOKEN_INVALID', details: { reason: 'consumer_not_entitled' } });
      const row = (await db.$queryRawUnsafe(
        `SELECT revoked_at, revoke_reason FROM "auth_storage"."NativeDeviceSession" WHERE id = '${a.device_session_id}'::uuid`,
      )) as { revoked_at: Date | null; revoke_reason: string | null }[];
      expect(row[0]!.revoked_at).not.toBeNull();
      expect(row[0]!.revoke_reason).toBe('refresh_denied:consumer_not_entitled');
    });

    it('native context with NO Host header, under AUTH_HOST_TENANT_BINDING=enforce: the exchange mints (no browser host binding, none simulated)', async () => {
      process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
      const payload = JSON.stringify(body(ALICE));
      // A raw HTTP/1.0 request with NO Host header at all (Node's server refuses a
      // Host-less HTTP/1.1 request before it reaches the app, so 1.0 is used).
      const raw = await new Promise<string>((done, fail) => {
        const sock = connect(port, '127.0.0.1', () => {
          sock.write(
            `POST /auth/native/sign/token HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
          );
        });
        let data = '';
        sock.on('data', (c: Buffer) => (data += c.toString()));
        sock.on('end', () => done(data));
        sock.on('error', fail);
      });
      expect(raw).not.toMatch(/\r\nhost:/i);
      const [head, resBody] = raw.split('\r\n\r\n');
      const res = {
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head!)?.[1]),
        cacheControl: /\r\ncache-control: ([^\r\n]+)/i.exec(head!)?.[1],
        body: resBody!,
      };
      expect(res.status).toBe(200);
      expect(res.cacheControl).toBe('no-store');
      expect(decodeJwt((JSON.parse(res.body) as { access_token: string }).access_token)).toMatchObject({ client: 'native' });
    });

    it('browser behaviour unchanged: a native refresh token is refused by the browser cookie refresh; a native access token is refused as the browser session', async () => {
      const a = await token(ALICE);
      const refresh = await request(app.getHttpServer()).post('/auth/sign/refresh').set('Cookie', `aramo_refresh_token_sign=${a.refresh_token}`);
      expect(refresh.status).toBe(401);
      expect(refresh.body.error).toMatchObject({ code: 'REFRESH_TOKEN_INVALID', details: { reason: 'consumer_mismatch' } });
      const session = await request(app.getHttpServer()).get('/auth/sign/session').set('Cookie', `aramo_access_token_sign=${a.access_token}`);
      expect(session.status).toBe(401);
      expect(session.body.error.details.reason).toBe('native_token_on_browser_route');
      // The native session is untouched by the refused browser attempt.
      const still = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: a.refresh_token });
      expect(still.status).toBe(200);
    });

    it('logout revokes this device; an unknown token is a silent 204', async () => {
      const a = await token(ALICE);
      const out = await request(app.getHttpServer()).post('/auth/native/sign/logout').send({ refresh_token: a.refresh_token });
      expect(out.status).toBe(204);
      const again = await request(app.getHttpServer()).post('/auth/native/sign/logout').send({ refresh_token: 'never-issued' });
      expect(again.status).toBe(204);
      const dead = await request(app.getHttpServer()).post('/auth/native/sign/refresh').send({ refresh_token: a.refresh_token });
      expect(dead.body.error.details.reason).toBe('explicitly_revoked');
      const list = await request(app.getHttpServer()).get('/auth/native/sign/sessions').set('Authorization', `Bearer ${a.access_token}`);
      expect(list.status).toBe(401);
      expect(list.body.error.details.reason).toBe('device_session_revoked');
    });
  },
);
