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
  CommonModule,
  computeEmailFingerprint,
  resolveIdentityMigrations,
  resolveAuthStorageMigrations,
} from '@aramo/common';
import { IdentityCoreModule, PrismaService as IdentityPrismaService } from '@aramo/identity';
import { AuthStorageModule } from '@aramo/auth-storage';
import { PortalIdentityModule } from '@aramo/portal-identity';
import { IdentityIndexModule } from '@aramo/identity-index';
import { MailerModule, MAILER_PORT } from '@aramo/mailer';

import { PortalAuthController } from '../app/auth/portal-auth.controller.js';
import { EMAIL_SENDER } from '../app/auth/email-sender.port.js';
import { ELIGIBILITY_POLICY } from '../app/auth/eligibility-policy.port.js';
import { HostAuthProfileService } from '../app/auth/host-auth-profile.service.js';
import { IdentityIndexEligibilityAdapter } from '../app/auth/identity-index-eligibility.adapter.js';
import { MailerEmailSenderAdapter } from '../app/auth/mailer-email-sender.adapter.js';
import { HostBaseResolver } from '../app/auth/host-base-resolver.service.js';
import { CognitoVerifierService } from '../app/auth/cognito-verifier.service.js';
import { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import { JwksController } from '../app/auth/jwks.controller.js';
import { JwksService } from '../app/auth/jwks.service.js';
import { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';
import { PkceService } from '../app/auth/pkce.service.js';
import { PortalLoginBudget } from '../app/auth/portal-login-budget.js';
import { PortalLoginService } from '../app/auth/portal-login.service.js';
import { AUDIT_SINK } from '../app/auth/audit-sink.port.js';
import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';
import { PRINCIPAL_DIRECTORY } from '../app/auth/principal-directory.port.js';
import { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';
import { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

import { generateTestKeyPair } from './test-keys.js';

// Portal P1 PR-1 — the required HTTP-boot integration. Boots the auth module
// against Postgres 17 (identity + auth_storage + portal_identity + identity_index
// provisioned), with a mock mailer, and drives the passwordless flow end to end:
// request-link writes a token row + sends mail; consume mints the PortalUser +
// sets the session cookies + a correct portal JWT; an unknown email writes no
// row, sends no mail, and returns the identical neutral response.

const REPO_ROOT = resolve(__dirname, '../../../..');
const IDENTITY_MIGRATIONS = resolveIdentityMigrations(REPO_ROOT);
const AUTH_STORAGE_MIGRATIONS = resolveAuthStorageMigrations(REPO_ROOT);
const PORTAL_IDENTITY_MIGRATION = resolve(
  REPO_ROOT,
  'libs/portal-identity/prisma/migrations/20260714120000_init_portal_identity/migration.sql',
);
const IDENTITY_INDEX_MIGRATION = resolve(
  REPO_ROOT,
  'libs/identity-index/prisma/migrations/20260630000000_init_identity_index/migration.sql',
);

const TEST_PEPPER = 'portal-login-integration-pepper';
const ELIGIBLE_EMAIL = 'known@example.com';
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
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new IdentityPrismaService(url);
      await setup.$connect();
      const migrations = [
        ...IDENTITY_MIGRATIONS,
        ...AUTH_STORAGE_MIGRATIONS,
        PORTAL_IDENTITY_MIGRATION,
        IDENTITY_INDEX_MIGRATION,
      ];
      for (const migrationPath of migrations) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      // Seed eligibility: a ClusterFingerprint for the eligible email (aperture 1).
      const clusterId = uuidv7();
      await setup.$executeRawUnsafe(
        `INSERT INTO "identity_index"."PersonCluster" (id, updated_at) VALUES ('${clusterId}', NOW())`,
      );
      const fp = computeEmailFingerprint(ELIGIBLE_EMAIL, TEST_PEPPER);
      await setup.$executeRawUnsafe(
        `INSERT INTO "identity_index"."ClusterFingerprint" (id, cluster_id, fingerprint, kind) VALUES ('${uuidv7()}', '${clusterId}', '${fp}', 'email')`,
      );
      await setup.$disconnect();

      const { privatePem, publicPem } = generateTestKeyPair();
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PRIVATE_KEY: process.env['AUTH_PRIVATE_KEY'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        ARAMO_IDENTITY_PEPPER: process.env['ARAMO_IDENTITY_PEPPER'],
        AUTH_ALLOW_INSECURE_COOKIES: process.env['AUTH_ALLOW_INSECURE_COOKIES'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
      process.env['AUTH_PRIVATE_KEY'] = privatePem;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_IDENTITY_PEPPER'] = TEST_PEPPER;
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      module = await Test.createTestingModule({
        imports: [
          CommonModule,
          IdentityCoreModule,
          AuthStorageModule,
          PortalIdentityModule,
          IdentityIndexModule,
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
          HostAuthProfileService,
          HostBaseResolver,
          PortalLoginService,
          PortalLoginBudget,
          // Auth-Decoupling PR-2/3 — the port bindings (DI ripple, §4 D-1). The
          // MAILER_PORT override below still reaches the send via the adapter.
          MailerEmailSenderAdapter,
          IdentityIndexEligibilityAdapter,
          { provide: EMAIL_SENDER, useClass: MailerEmailSenderAdapter },
          { provide: ELIGIBILITY_POLICY, useClass: IdentityIndexEligibilityAdapter },
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

    it('request-link for an eligible email → 200 neutral, a token row is written, mail is sent', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/portal/request-link')
        .send({ email: ELIGIBLE_EMAIL });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: NEUTRAL });
      expect(await tokenRowCount(ELIGIBLE_EMAIL)).toBe(1);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(mailer.send.mock.calls[0][0].to).toBe(ELIGIBLE_EMAIL);
    });

    it('consume the emailed token → 302, session cookies set, PortalUser minted, portal JWT correct', async () => {
      // Extract the raw token from the mail the previous test captured.
      const sent = mailer.send.mock.calls[0][0] as { text: string };
      const raw = /token=([^&\s"]+)/.exec(sent.text)?.[1];
      expect(raw).toBeTruthy();

      const res = await request(app.getHttpServer()).get(
        `/auth/portal/consume?token=${raw}`,
      );
      expect(res.status).toBe(302);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const access = cookies.find((c) => c.startsWith('aramo_access_token='));
      const refresh = cookies.find((c) => c.startsWith('aramo_refresh_token='));
      expect(access).toBeTruthy();
      expect(refresh).toBeTruthy();

      // The PortalUser was lazily minted with the eligible email + the cluster.
      const users = await db.$queryRawUnsafe<{ id: string; cluster_id: string | null }[]>(
        `SELECT id, cluster_id FROM "portal_identity"."PortalUser" WHERE email_normalized = $1`,
        ELIGIBLE_EMAIL,
      );
      expect(users).toHaveLength(1);
      expect(users[0].cluster_id).not.toBeNull();

      // The access JWT is a portal token whose sub is the PortalUser id.
      const jwt = /aramo_access_token=([^;]+)/.exec(access!)?.[1];
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

    // TR-2b B2b (Directive §PR-2.3, ruling 2) — login-time cluster re-link, the
    // full circle: a portal user whose orphaned cluster was purged (B2a/B2b) has a
    // PortalUser with cluster_id NULL. When their cluster re-appears in the index
    // (a fresh arrival re-mints it), the NEXT consume fills cluster_id — one write,
    // same user, monotonic fill (never overwrites a non-null cluster).
    it('re-links a NULL-cluster PortalUser at next consume (purged → re-linked)', async () => {
      const RELINK_EMAIL = 'relink@example.com';
      const portalId = uuidv7();
      // The purged-cluster portal user: an existing PortalUser with cluster_id NULL.
      await db.$executeRawUnsafe(
        `INSERT INTO "portal_identity"."PortalUser" (id, email_normalized, cluster_id, updated_at)
         VALUES ($1, $2, NULL, NOW())`,
        portalId,
        RELINK_EMAIL,
      );
      // The fresh cluster re-appears in the PII-free index (the eligibility hit).
      const clusterId = uuidv7();
      await db.$executeRawUnsafe(
        `INSERT INTO "identity_index"."PersonCluster" (id, updated_at) VALUES ($1, NOW())`,
        clusterId,
      );
      const fp = computeEmailFingerprint(RELINK_EMAIL, TEST_PEPPER);
      await db.$executeRawUnsafe(
        `INSERT INTO "identity_index"."ClusterFingerprint" (id, cluster_id, fingerprint, kind)
         VALUES ($1, $2, $3, 'email')`,
        uuidv7(),
        clusterId,
        fp,
      );

      const before = await db.$queryRawUnsafe<{ cluster_id: string | null }[]>(
        `SELECT cluster_id FROM "portal_identity"."PortalUser" WHERE id = $1`,
        portalId,
      );
      expect(before[0]!.cluster_id).toBeNull();

      // request-link + consume for the re-linkable portal user.
      mailer.send.mockClear();
      await request(app.getHttpServer())
        .post('/auth/portal/request-link')
        .send({ email: RELINK_EMAIL });
      const sent = mailer.send.mock.calls[0]![0] as { text: string };
      const raw = /token=([^&\s"]+)/.exec(sent.text)?.[1];
      const res = await request(app.getHttpServer()).get(
        `/auth/portal/consume?token=${raw}`,
      );
      expect(res.status).toBe(302);

      // The SAME PortalUser now carries the fresh cluster (re-linked, one write).
      const after = await db.$queryRawUnsafe<{ id: string; cluster_id: string | null }[]>(
        `SELECT id, cluster_id FROM "portal_identity"."PortalUser" WHERE email_normalized = $1`,
        RELINK_EMAIL,
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(portalId); // re-linked, NOT a new mint
      expect(after[0]!.cluster_id).toBe(clusterId);
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
      const scopes = (decodeJwt(accessJwt).scopes as string[]) ?? [];
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
