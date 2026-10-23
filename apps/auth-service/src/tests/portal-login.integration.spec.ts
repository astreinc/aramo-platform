import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { RolesGuard, RequireScopes } from '@aramo/authorization';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { decodeJwt } from 'jose';
import { v7 as uuidv7 } from 'uuid';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  CommonModule,
  resolveIdentityMigrations,
  resolveAuthStorageMigrations,
} from '@aramo/common';
import { IdentityCoreModule, PrismaService as IdentityPrismaService } from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { MailerModule, MAILER_PORT } from '@aramo/mailer';
import { PortalAuthController, PORTAL_SESSION_SCOPES } from '@aramo/auth-core';
import { EMAIL_SENDER } from '@aramo/auth-core';
import { ELIGIBILITY_POLICY } from '@aramo/auth-core';
import { HostAuthProfileService } from '@aramo/auth-core';
import { HostBaseResolver } from '@aramo/auth-core';
import { CognitoVerifierService } from '@aramo/auth-core';
import { CookieVerifierService } from '@aramo/auth-core';
import { JwksController } from '@aramo/auth-core';
import { JwksService } from '@aramo/auth-core';
import { JwtIssuerService } from '@aramo/auth-core';
import { PkceService } from '@aramo/auth-core';
import { PortalLoginBudget } from '@aramo/auth-core';
import { PortalLoginService } from '@aramo/auth-core';
import { AUDIT_SINK } from '@aramo/auth-core';
import { HOST_CONTEXT_DIRECTORY } from '@aramo/auth-core';
import { PORTAL_IDENTITY_STORE } from '@aramo/auth-core';
import { PRINCIPAL_DIRECTORY } from '@aramo/auth-core';
import { RefreshOrchestratorService } from '@aramo/auth-core';
import { SessionOrchestratorService } from '@aramo/auth-core';

import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';
import { PortalIdentityRepositoryAdapter } from '../app/auth/portal-identity-repository.adapter.js';
import { MailerEmailSenderAdapter } from '../app/auth/mailer-email-sender.adapter.js';
import { PortalDeferredEligibilityAdapter } from '../app/auth/portal-deferred-eligibility.adapter.js';

import { generateTestKeyPair } from './test-keys.js';

// Portal P1 PR-1 — the required HTTP-boot integration. Boots the auth module
// against Postgres 17 (identity + auth_storage + portal_identity provisioned),
// with a mock mailer, and drives the passwordless flow end to end.
//
// ATI-SEP-1 T10 WP4 (Addendum A4, GAP-PORTAL-ID-1) — the retired identity index
// no longer supplies eligibility; ELIGIBILITY_POLICY is the portal-deferred
// adapter (always null). Eligibility therefore comes ONLY from an existing
// PortalUser: request-link writes a token row + sends mail for one; consume
// finds that PortalUser (cluster_id untouched — no destructive change) + sets
// the session cookies + a correct portal JWT; an unknown email writes no row,
// sends no mail, and returns the identical neutral response.

const REPO_ROOT = resolve(__dirname, '../../../..');
const IDENTITY_MIGRATIONS = resolveIdentityMigrations(REPO_ROOT);
const AUTH_STORAGE_MIGRATIONS = resolveAuthStorageMigrations(REPO_ROOT);
const PORTAL_IDENTITY_MIGRATION = resolve(
  REPO_ROOT,
  'libs/portal-identity/prisma/migrations/20260714120000_init_portal_identity/migration.sql',
);
const ELIGIBLE_EMAIL = 'known@example.com';
const ELIGIBLE_PORTAL_ID = uuidv7();
const UNKNOWN_EMAIL = 'nobody@example.com';

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

// FIX-PORTAL-SCOPES-1 (D3) — dummy handlers carrying the SAME @RequireScopes a real
// portal surface class declares, so the REAL RolesGuard (the production 403/pass
// gate) evaluates a REAL-session JWT against each surface class:
//   READ  = portal:verification:read   (absent from the pre-fix 2-scope stamp)
//   WRITE = portal:consent:write        (absent from the pre-fix 2-scope stamp)
//   RTBF  = no @RequireScopes           (Option A — scope-free)
// The pre-fix PORTAL_SESSION_SCOPES would leave READ + WRITE unsatisfied → 403.
class PortalReadSurface {
  @RequireScopes('portal:verification:read')
  read(): void {
    /* handler body is irrelevant — RolesGuard runs before it */
  }
}
class PortalWriteSurface {
  @RequireScopes('portal:consent:write')
  write(): void {
    /* handler body is irrelevant — RolesGuard runs before it */
  }
}
class PortalRtbfSurface {
  erase(): void {
    /* scope-free (Option A) — RolesGuard adds no constraint */
  }
}

function ctxFor(
  cls: new () => object,
  method: string,
  scopes: string[],
): ExecutionContext {
  const handler = (cls.prototype as Record<string, unknown>)[method];
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        authContext: {
          sub: 'd3-portal-sub',
          consumer_type: 'portal',
          tenant_id: 'd3-tenant',
          scopes,
          iat: 0,
          exp: 0,
        },
        requestId: 'req-d3',
      }),
    }),
  } as unknown as ExecutionContext;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'auth-service — passwordless portal login (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: IdentityPrismaService;
    const mailer = { send: vi.fn().mockResolvedValue({ message_id: 'm1' }) };
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      const migrations = [
        ...IDENTITY_MIGRATIONS,
        ...AUTH_STORAGE_MIGRATIONS,
        PORTAL_IDENTITY_MIGRATION,
      ];
      for (const migrationPath of migrations) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      // Seed eligibility (A4): an EXISTING PortalUser for the eligible email — the
      // only eligibility source while the policy port is portal-deferred.
      await setup.$executeRawUnsafe(
        `INSERT INTO "portal_identity"."PortalUser" (id, email_normalized, cluster_id, updated_at) VALUES ('${ELIGIBLE_PORTAL_ID}', '${ELIGIBLE_EMAIL}', NULL, NOW())`,
      );
      await setup.$disconnect();

      const { privatePem, publicPem } = generateTestKeyPair();
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PRIVATE_KEY: process.env['AUTH_PRIVATE_KEY'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        AUTH_ALLOW_INSECURE_COOKIES: process.env['AUTH_ALLOW_INSECURE_COOKIES'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
      process.env['AUTH_PRIVATE_KEY'] = privatePem;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          IdentityCoreModule,
          AuthStorageModule,
          PortalIdentityModule,
          MailerModule,
        ],
        controllers: [PortalAuthController, JwksController],
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
          // PR-5a — HostContextDirectory + PortalIdentityStore bindings (DI ripple).
          IdentityHostContextAdapter,
          PortalIdentityRepositoryAdapter,
          { provide: HOST_CONTEXT_DIRECTORY, useClass: IdentityHostContextAdapter },
          { provide: PORTAL_IDENTITY_STORE, useClass: PortalIdentityRepositoryAdapter },
          HostAuthProfileService,
          HostBaseResolver,
          PortalLoginService,
          PortalLoginBudget,
          // Auth-Decoupling PR-2/3 — the port bindings (DI ripple, §4 D-1). The
          // MAILER_PORT override below still reaches the send via the adapter.
          MailerEmailSenderAdapter,
          PortalDeferredEligibilityAdapter,
          { provide: EMAIL_SENDER, useClass: MailerEmailSenderAdapter },
          { provide: ELIGIBILITY_POLICY, useClass: PortalDeferredEligibilityAdapter },
        ],
      })
        .overrideProvider(MAILER_PORT)
        .useValue(mailer)
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      await app.init();

      db = new IdentityPrismaService(url);
      await db.$connect();
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    async function tokenRowCount(email: string): Promise<number> {
      const rows = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::int AS n FROM "portal_identity"."PortalLoginToken" WHERE email_normalized = $1`,
        email,
      );
      return Number(rows[0]?.n ?? 0);
    }

    const NEUTRAL = 'If this address is known to Aramo, a sign-in link has been sent.';

    it('request-link for an existing portal user → 200 neutral, a token row is written, mail is sent', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/portal/request-link')
        .send({ email: ELIGIBLE_EMAIL });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: NEUTRAL });
      expect(await tokenRowCount(ELIGIBLE_EMAIL)).toBe(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send.mock.calls[0][0].to).toBe(ELIGIBLE_EMAIL);
    });

    it('consume the emailed token → 302, session cookies set, existing PortalUser found, portal JWT correct', async () => {
      // Extract the raw token from the mail the previous test captured.
      const sent = mailer.send.mock.calls[0][0] as { text: string };
      const raw = /token=([^&\s"]+)/.exec(sent.text)?.[1];
      expect(raw).toBeTruthy();

      const res = await request(app.getHttpServer()).get(
        `/auth/portal/consume?token=${raw}`,
      );
      expect(res.status).toBe(302);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('aramo_access_token_portal='));
      const refresh = cookies.find((c) => c.startsWith('aramo_refresh_token_portal='));
      expect(access).toBeTruthy();
      expect(refresh).toBeTruthy();

      // The existing PortalUser was found (no new mint); A4 — no cluster is
      // resolved, so cluster_id stays as it was (null).
      const users = await db.$queryRawUnsafe<{ id: string; cluster_id: string | null }[]>(
        `SELECT id, cluster_id FROM "portal_identity"."PortalUser" WHERE email_normalized = $1`,
        ELIGIBLE_EMAIL,
      );
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe(ELIGIBLE_PORTAL_ID);
      expect(users[0].cluster_id).toBeNull();

      // The access JWT is a portal token whose sub is the PortalUser id.
      const jwt = /aramo_access_token_portal=([^;]+)/.exec(access!)?.[1];
      const claims = decodeJwt(decodeURIComponent(jwt!));
      expect(claims.consumer_type).toBe('portal');
      expect(claims.sub).toBe(users[0].id);
    });

    it('a second consume of the same token → 302 with NO cookies (replay neutral-fails)', async () => {
      const sent = mailer.send.mock.calls[0][0] as { text: string };
      const raw = /token=([^&\s"]+)/.exec(sent.text)?.[1];
      const res = await request(app.getHttpServer()).get(
        `/auth/portal/consume?token=${raw}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('request-link for an UNKNOWN email → 200 identical neutral, NO token row, NO mail', async () => {
      mailer.send.mockClear();
      const res = await request(app.getHttpServer())
        .post('/auth/portal/request-link')
        .send({ email: UNKNOWN_EMAIL });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: NEUTRAL });
      expect(await tokenRowCount(UNKNOWN_EMAIL)).toBe(0);
      expect(mailer.send).not.toHaveBeenCalled();
    });

    // ATI-SEP-1 A4 §3 — no destructive change to portal_identity data: an existing
    // PortalUser's (now inert) non-null cluster_id survives a login unchanged.
    it('keeps an existing PortalUser cluster_id unchanged at consume (A4: inert, never cleared)', async () => {
      const INERT_EMAIL = 'inert@example.com';
      const portalId = uuidv7();
      const inertCluster = uuidv7();
      await db.$executeRawUnsafe(
        `INSERT INTO "portal_identity"."PortalUser" (id, email_normalized, cluster_id, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        portalId,
        INERT_EMAIL,
        inertCluster,
      );

      mailer.send.mockClear();
      await request(app.getHttpServer())
        .post('/auth/portal/request-link')
        .send({ email: INERT_EMAIL });
      const sent = mailer.send.mock.calls[0]![0] as { text: string };
      const raw = /token=([^&\s"]+)/.exec(sent.text)?.[1];
      const res = await request(app.getHttpServer()).get(
        `/auth/portal/consume?token=${raw}`,
      );
      expect(res.status).toBe(302);

      const after = await db.$queryRawUnsafe<{ id: string; cluster_id: string | null }[]>(
        `SELECT id, cluster_id FROM "portal_identity"."PortalUser" WHERE email_normalized = $1`,
        INERT_EMAIL,
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(portalId);
      expect(after[0]!.cluster_id).toBe(inertCluster);
    });

    // FIX-PORTAL-SCOPES-1 (D3) — real-session-mint authorization coverage: the path
    // production takes. Mint a portal session via the REAL establishPortalSession,
    // then gate it through the REAL RolesGuard for each surface class. Pre-fix
    // (PORTAL_SESSION_SCOPES = the 2-read-scope stale list) BOTH the READ and the
    // WRITE would 403 here — this test was RED against the unfixed constant and is
    // GREEN after the D1 backfill (the fail-then-green in the Gate-5 evidence). It
    // also stands as a permanent regression guard: revert the backfill and it reddens.
    it('a REAL portal session (establishPortalSession) authorizes read + write + RTBF surfaces', async () => {
      const orchestrator = module.get(SessionOrchestratorService);
      const { accessJwt } = await orchestrator.establishPortalSession({
        portal_user_id: uuidv7(),
      });
      // HF-AUTH-1 — the portal access token is COMPACT: it carries NO scopes claim.
      // A portal session's effective scopes are resolved SERVER-SIDE to the fixed
      // PORTAL_SESSION_SCOPES set (the resolver's portal branch returns exactly this
      // constant). The FIX-PORTAL-SCOPES-1 regression property is preserved: this
      // asserts the guard authorizes the surfaces from that constant, so reverting
      // the D1 backfill of PORTAL_SESSION_SCOPES reddens this exactly as before.
      expect(decodeJwt(accessJwt)['scopes']).toBeUndefined();
      const scopes = [...PORTAL_SESSION_SCOPES];
      const guard = new RolesGuard(new Reflector());

      // (a) scoped READ — portal:verification:read (absent pre-fix → was 403).
      expect(guard.canActivate(ctxFor(PortalReadSurface, 'read', scopes))).toBe(true);
      // (b) scoped WRITE — portal:consent:write (absent pre-fix → was 403).
      expect(guard.canActivate(ctxFor(PortalWriteSurface, 'write', scopes))).toBe(true);
      // (c) RTBF — scope-free (Option A): authorized on any valid portal session.
      expect(guard.canActivate(ctxFor(PortalRtbfSurface, 'erase', scopes))).toBe(true);
    });
  },
);
