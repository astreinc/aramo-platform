import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { Verifier } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { AppModule } from '@aramo/api';

// Direct file imports for the two per-module PrismaService classes: each
// module ships its own PrismaService (consent + ingestion). In production
// those constructors are reached through Nest DI without an arg, so they
// fall through to process.env['DATABASE_URL']; the test harness needs to
// override both with explicit-URL factory bindings (the optional `string`
// parameter trips reflect-metadata when Nest tries to inject it). The
// classes are not exported through @aramo/consent or @aramo/ingestion's
// public surface (PR-2 precedent: PrismaService is an internal wiring
// detail of each module). Test-only relative import — narrowly scoped to
// this provider-verification harness.
// eslint-disable-next-line @nx/enforce-module-boundaries
import { PrismaService as ConsentPrismaService } from '../../../libs/consent/src/lib/prisma/prisma.service.js';
// eslint-disable-next-line @nx/enforce-module-boundaries
import { PrismaService as IngestionPrismaService } from '../../../libs/ingestion/src/lib/prisma/prisma.service.js';

// PR-14 §4.7 + Amendment v1.0 §2 — Pact provider verifier for apps/api.
//
// Scope (Amendment v1.0 §2.1): the apps/api provider-verification
// infrastructure + PR-14's own two ingestion pacts:
//   - pact/pacts/ingestion-consumer-aramo-core.json (2 interactions)
//   - pact/pacts/prohibited-source-type-aramo-core.json (1 interaction)
// Tenant-console-consumer's 5 consent interactions are de-scoped per
// Amendment §2.3 and deferred to F10 (pinned PR-15).
//
// Migration set (per Gate 5 §4.7 inspection, confirmed clean by
// Amendment §2.1): consent + ingestion ONLY. The API-side AuthModule
// (@aramo/auth) is a pure JWT validator with zero Prisma queries;
// identity / auth / auth-storage / common are NOT required.
//
// Gap 1 resolution (Amendment §2.2): inline JWT signing — issuer
// 'Aramo Core Auth' (production), signed with a fresh test RSA key
// pair, mirroring libs/consent/src/tests/cookie-auth.integration.spec.ts
// exactly. auth-helpers.ts is untouched (its test-issuer invariant
// stands per the load-bearing comment); production-issuer JWT issuance
// is contained to this provider-verification module.
//
// Request filter: the consumer pacts ship Cookie: aramo_access_token=
// eyJfake.access.token (a literal fake string matched by type matcher).
// The Pact Verifier's requestFilter rewrites the Cookie header before
// the request reaches apps/api, injecting the real signed JWT issued
// at bootstrap.
//
// Run condition: ARAMO_RUN_PACT_PROVIDER=1 gating, matching the
// auth-service verifier. Invoke via `npm run pact:provider`.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../..');
const CONSENT_MIGRATION = resolve(
  ROOT,
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);
const INGESTION_INIT_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516130715_init_ingestion_model/migration.sql',
);
const INGESTION_SURFACE_MIGRATION = resolve(
  ROOT,
  'libs/ingestion/prisma/migrations/20260516183528_add_skill_surface_forms/migration.sql',
);
const INGESTION_PACT = resolve(
  ROOT,
  'pact/pacts/ingestion-consumer-aramo-core.json',
);
const PROHIBITED_PACT = resolve(
  ROOT,
  'pact/pacts/prohibited-source-type-aramo-core.json',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-pact-provider-api-audience';
const ALG = 'RS256';

const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';

// Migration files contain dollar-quoted PL/pgSQL bodies (the
// TalentConsentEvent immutability trigger), so the naive ;-split used by
// the auth-service verifier doesn't work here. pg's Client.query()
// accepts multi-statement strings via the simple query protocol — we
// hand each migration file in whole, which preserves the dollar quotes.

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — aramo-core (apps/api)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let accessJwt: string;
    // Assigned in beforeAll before any state handler runs; initialized empty
    // for strict null-checks compliance.
    let dbUrl = '';

    // State reset: each ingestion-pact interaction expects a fresh-acceptance
    // path (dedup.match_signal: null, status: 'accepted' / 'shortlisted_not_unlocked').
    // The Pact verifier runs interactions in sequence; without a reset the
    // second sha256 would see the first call's row as a duplicate. Delete
    // the ingestion table contents before each state setup.
    async function resetIngestionRows(): Promise<void> {
      const c = new Client({ connectionString: dbUrl });
      await c.connect();
      await c.query('TRUNCATE TABLE ingestion."RawPayloadReference" CASCADE');
      // Also reset consent tables so the indeed source-consent
      // registration doesn't accumulate across interactions.
      await c.query('TRUNCATE TABLE consent."TalentConsentEvent" CASCADE');
      await c.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
      await c.query('TRUNCATE TABLE consent."OutboxEvent" CASCADE');
      await c.query('TRUNCATE TABLE audit."ConsentAuditEvent" CASCADE');
      await c.end();
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      dbUrl = url;

      // Apply consent + ingestion migrations via raw SQL. Prisma 7 uses
      // driver adapters (PR-2 precedent surfaced) and its constructor
      // signature differs from the legacy datasourceUrl shape; using
      // node-postgres directly here keeps the migration apply small and
      // dependency-free of the consent module's PrismaService wrapper.
      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const migrationPath of [
        CONSENT_MIGRATION,
        INGESTION_INIT_MIGRATION,
        INGESTION_SURFACE_MIGRATION,
      ]) {
        await setup.query(readFileSync(migrationPath, 'utf8'));
      }
      await setup.end();

      // Inline JWT signing per Amendment §2.2 — production issuer
      // 'Aramo Core Auth' so JwtAuthGuard accepts the token. Mirrors
      // libs/consent/src/tests/cookie-auth.integration.spec.ts.
      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      accessJwt = await new SignJWT({
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: ['ingestion:write'],
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

      module = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(ConsentPrismaService)
        .useFactory({ factory: () => new ConsentPrismaService(url) })
        .overrideProvider(IngestionPrismaService)
        .useFactory({ factory: () => new IngestionPrismaService(url) })
        .compile();

      app = module.createNestApplication();
      // Mirror apps/api/src/main.ts: cookieParser() before ValidationPipe
      // so JwtAuthGuard sees request.cookies and class-validator runs at
      // the controller boundary with the same whitelist + transform
      // settings as production.
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
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

    // State handlers for the 3 interactions across the 2 PR-14 pacts.
    // No per-state DB setup is required: the testcontainer is freshly
    // initialized, the ingestion table is empty (so every sha256 the
    // pacts submit is a fresh acceptance — interaction 1 of ingestion
    // pact and 1 of indeed pact); the prohibited-source value is
    // rejected by class-validator before reaching the repository (so
    // no DB state matters for the prohibited-source-type interaction).
    // The recruiter JWT is signed once at bootstrap and the requestFilter
    // injects it for every authenticated interaction.
    const stateHandlers = {
      'a recruiter session and a prohibited source value at the wire':
        async () => undefined,
      'an ingestion session with no prior payload matching the submitted sha256':
        async () => {
          await resetIngestionRows();
        },
      'an ingestion session and a talent record with no prior indeed shortlist for the submitted sha256':
        async () => {
          await resetIngestionRows();
        },
    };

    // Cookie injection per Amendment §2.2: the pacts ship a literal
    // fake access-token string; replace it with the real JWT before
    // the request reaches apps/api's JwtAuthGuard.
    function requestFilter(
      req: { headers: Record<string, string | string[] | undefined> },
      _res: unknown,
      next: () => void,
    ): void {
      const cookieHeader = req.headers['cookie'] ?? req.headers['Cookie'];
      if (
        typeof cookieHeader === 'string' &&
        cookieHeader.includes('aramo_access_token=')
      ) {
        req.headers['cookie'] = `aramo_access_token=${accessJwt}`;
      }
      next();
    }

    it(
      'verifies all interactions from the two PR-14 ingestion pacts',
      async () => {
        const verifier = new Verifier({
          providerBaseUrl: `http://127.0.0.1:${port}`,
          pactUrls: [INGESTION_PACT, PROHIBITED_PACT],
          stateHandlers,
          requestFilter: requestFilter as never,
          logLevel: 'warn',
        });
        await verifier.verifyProvider();
      },
      120_000,
    );
  },
);
