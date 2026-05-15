import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { RequestIdMiddleware } from '@aramo/common';
import {
  IdentityService,
  PrismaService as IdentityPrismaService,
  RoleService,
  TenantService,
} from '@aramo/identity';

import { AuthServiceModule } from '../../../apps/auth-service/src/app/auth/auth.module.js';

import { generateTestKeyPair } from './auth-helpers.js';
import { stateHandlers } from './state-handlers.js';

// PR-M0R-1 Pact provider verifier.
//
// Per PR-M0R-1 Directive Amendment v1.0 §2.1: verifies against
// apps/auth-service test instance (NOT apps/api). The 6 auth endpoints
// are served by apps/auth-service per Architecture v2.1 §1.1 + §2.1.
//
// Per directive §4: starts apps/auth-service against a test database.
// Per amendment §2.3: state setup happens via test fixtures + auth-helpers,
// not via apps/api invocation.
//
// Per directive §11 inter-stage verification gates, this verifier exits 0
// when all interactions in the consumer pact verify against the running
// auth-service test instance.
//
// Run condition: gated on ARAMO_RUN_PACT_PROVIDER=1 so it does NOT execute
// during `npm test` (which runs unit tests across all libs). Invoke
// explicitly via `npm run pact:provider` or the Nx `pact-verify` target.

const ROOT = resolve(__dirname, '../../..');
const IDENTITY_MIGRATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
const AUTH_STORAGE_MIGRATION = resolve(
  ROOT,
  'libs/auth-storage/prisma/migrations/20260512100000_init_auth_storage/migration.sql',
);
const PACT_FILE = resolve(
  ROOT,
  'pact/pacts/auth-service-consumer-aramo-auth-service.json',
);

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — aramo-auth-service',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    const FIXED_USER_ID = uuidv7();
    const FIXED_TENANT_ID = uuidv7();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      // Apply migrations via raw SQL — same pattern as
      // apps/auth-service/src/tests/auth.integration.spec.ts.
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
      process.env['AUTH_AUDIENCE'] = 'aramo-pact-provider-audience';
      process.env['AUTH_PRIVATE_KEY'] = privatePem;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['AUTH_PKCE_STATE_KEY'] = randomBytes(32).toString('base64url');
      process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
      process.env['AUTH_COGNITO_CLIENT_ID'] = 'pact-test-client';
      process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://app.example/cb';
      process.env['AUTH_REFRESH_GRACE_SECONDS'] = '0';
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';

      // Import the production AuthServiceModule directly — this brings
      // AramoExceptionFilter (registered via APP_FILTER) so error responses
      // use the locked Phase 5 envelope shape that the consumer pact
      // expects. Overrides isolate identity/tenant/role lookups.
      module = await Test.createTestingModule({
        imports: [AuthServiceModule],
      })
        .overrideProvider(IdentityService)
        .useValue({
          resolveUser: async () => ({
            id: FIXED_USER_ID,
            email: 'pact@aramo.dev',
            display_name: 'Pact Provider User',
            is_active: true,
            deactivated_at: null,
            created_at: '',
            updated_at: '',
          }),
        })
        .overrideProvider(TenantService)
        .useValue({
          getTenantsByUser: async () => [
            {
              id: FIXED_TENANT_ID,
              name: 'Pact Provider Tenant',
              is_active: true,
              created_at: '',
              updated_at: '',
            },
          ],
        })
        .overrideProvider(RoleService)
        .useValue({
          getScopesByUserAndTenant: async () => ['auth:session:read'],
        })
        .compile();

      app = module.createNestApplication();
      app.use(cookieParser());
      // Apply the real RequestIdMiddleware so responses include the
      // X-Request-ID header the consumer pact expects.
      const requestIdMiddleware = new RequestIdMiddleware();
      app.use((req: Request, res: Response, next: NextFunction) =>
        requestIdMiddleware.use(req, res, next),
      );
      await app.init();
      const server = await app.listen(0);
      const address = server.address() as AddressInfo;
      port = address.port;
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it(
      'verifies all interactions from pact/pacts/auth-service-consumer-aramo-auth-service.json',
      async () => {
        const verifier = new Verifier({
          providerBaseUrl: `http://127.0.0.1:${port}`,
          pactUrls: [PACT_FILE],
          stateHandlers,
          logLevel: 'warn',
        });
        await verifier.verifyProvider();
      },
      120_000,
    );
  },
);
