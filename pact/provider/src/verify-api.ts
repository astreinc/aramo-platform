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

// PR-14 §4.7 + Amendment v1.0 §2 + PR-15 §4.2/§4.3 — Pact provider
// verifier for apps/api.
//
// Scope:
//   - PR-14: ingestion-consumer (2 interactions) + prohibited-source-type
//     (1 interaction)
//   - PR-15 §4.2 (F10): tenant-console-consumer (5 consent interactions)
//   - PR-15 §4.3 (F9): ats-thin (23 consent interactions)
//
// Migration set (per Gate 5 §4.7 inspection + PR-15 §3): consent +
// ingestion ONLY. The API-side AuthModule is a pure JWT validator with
// zero Prisma queries; identity / auth / auth-storage / common are NOT
// required. ConsentAuditEvent (audit schema) is created by the consent
// migration, which the decision-log interactions rely on.
//
// Auth — PR-14 Amendment §2.2: inline JWT signing with the production
// issuer 'Aramo Core Auth' so JwtAuthGuard accepts the token. Mirrors
// libs/consent/src/tests/cookie-auth.integration.spec.ts. The signing
// key is generated fresh at bootstrap; the public key is fed back via
// AUTH_PUBLIC_KEY before AppModule init.
//
// Request filter:
//   - tenant-console-consumer pacts ship Cookie: aramo_access_token=
//     eyJfake.access.token — rewritten to the real JWT cookie.
//   - ats-thin pacts ship Authorization: Bearer eyJfake.token — rewritten
//     to a real Bearer JWT. The literal 'Bearer not-a-jwt' (interaction
//     #14 of ats-thin) is intentionally NOT rewritten so JwtAuthGuard
//     returns INVALID_TOKEN 401.
//
// Run condition: ARAMO_RUN_PACT_PROVIDER=1 gating. Invoke via
// `npm run pact:provider`.

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
const TENANT_CONSOLE_PACT = resolve(
  ROOT,
  'pact/pacts/tenant-console-consumer-aramo-core.json',
);
const ATS_THIN_PACT = resolve(ROOT, 'pact/pacts/ats-thin-aramo-core.json');

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-pact-provider-api-audience';
const ALG = 'RS256';

const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const TENANT_ID = '11111111-1111-7111-8111-111111111111';

// Constants shared across the tenant-console + ats-thin pacts. The talent
// uuid matches the value the consumer tests use; the recruiter actor uuid
// matches the audit-row value the pacts assert with a regex matcher.
const PACT_TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const PACT_RECRUITER_ACTOR_ID = '00000000-0000-7000-8000-000000000bb1';

// Cursor anchor reused by ats-thin #13 / #17 and the regenerated
// tenant-console-consumer pact #3 (PR-15 §4.1). c is the keyset's
// created_at edge; e is the keyset's event_id. Page-2 seeded rows must
// have created_at strictly older than CURSOR_C so the predicate
// (created_at, id) < (CURSOR_C, CURSOR_E) returns them.
const CURSOR_C = '2026-04-15T12:00:00.000Z';
const CURSOR_E = '00000000-0000-7000-8000-000000000a01';

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

    async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: dbUrl });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    }

    // Truncate every table the consent + ingestion pacts touch so each
    // interaction starts from a known-empty floor. The Pact verifier runs
    // interactions in sequence; without a reset a prior interaction's
    // rows would shadow the next.
    async function resetAllRows(c: Client): Promise<void> {
      await c.query('TRUNCATE TABLE ingestion."RawPayloadReference" CASCADE');
      await c.query('TRUNCATE TABLE consent."TalentConsentEvent" CASCADE');
      await c.query('TRUNCATE TABLE consent."IdempotencyKey" CASCADE');
      await c.query('TRUNCATE TABLE consent."OutboxEvent" CASCADE');
      await c.query('TRUNCATE TABLE audit."ConsentAuditEvent" CASCADE');
    }

    async function seedConsentEvent(
      c: Client,
      opts: {
        id: string;
        scope: string;
        action: 'granted' | 'revoked';
        occurredAt: string;
        createdAt?: string;
        expiresAt?: string | null;
      },
    ): Promise<void> {
      const createdAtSql = opts.createdAt ?? opts.occurredAt;
      await c.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_id, tenant_id, scope, action, captured_by_actor_id,
            captured_method, consent_version, occurred_at, expires_at,
            created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'recruiter_capture','v1',$7,$8,$9)`,
        [
          opts.id,
          PACT_TALENT_ID,
          TENANT_ID,
          opts.scope,
          opts.action,
          PACT_RECRUITER_ACTOR_ID,
          opts.occurredAt,
          opts.expiresAt ?? null,
          createdAtSql,
        ],
      );
    }

    async function seedAuditEvent(
      c: Client,
      opts: {
        id: string;
        actorId: string | null;
        actorType: 'recruiter' | 'system' | 'self';
        eventType: string;
        payload: Record<string, unknown>;
        createdAt: string;
      },
    ): Promise<void> {
      await c.query(
        `INSERT INTO audit."ConsentAuditEvent"
           (id, tenant_id, actor_id, actor_type, event_type, subject_id,
            event_payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          opts.id,
          TENANT_ID,
          opts.actorId,
          opts.actorType,
          opts.eventType,
          PACT_TALENT_ID,
          JSON.stringify(opts.payload),
          opts.createdAt,
        ],
      );
    }

    async function seedIdempotencyKey(
      c: Client,
      opts: { id: string; key: string; requestHash: string },
    ): Promise<void> {
      await c.query(
        `INSERT INTO consent."IdempotencyKey"
           (id, tenant_id, key, request_hash, response_status, response_body)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          opts.id,
          TENANT_ID,
          opts.key,
          opts.requestHash,
          201,
          JSON.stringify({ pact_seeded: true }),
        ],
      );
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
      }).compile();

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

    // State handlers for the 3 ingestion-pact + 5 tenant-console + 23
    // ats-thin interactions. Each handler:
    //   1. Begins by truncating every table the pacts touch (resetAllRows),
    //      ensuring no prior interaction's rows leak forward.
    //   2. Seeds the rows the state name describes.
    //
    // Ordering note: the named-given strings below are the EXACT given()
    // arguments from the consumer tests. The PR-15 vocabulary rule
    // (§8.1-B token-free state-handler strings) is satisfied because none
    // of these strings are introduced by this harness — they ship with the
    // consumer pacts (no token-free re-authoring needed beyond what the
    // consumer tests already produced).
    const stateHandlers: Record<string, () => Promise<void>> = {
      // ===== PR-14 ingestion pacts =====
      'a recruiter session and a prohibited source value at the wire':
        async () => {
          await withClient((c) => resetAllRows(c));
        },
      'an ingestion session with no prior payload matching the submitted sha256':
        async () => {
          await withClient((c) => resetAllRows(c));
        },
      'an ingestion session and a talent record with no prior indeed shortlist for the submitted sha256':
        async () => {
          await withClient((c) => resetAllRows(c));
        },

      // ===== PR-15 §4.2 tenant-console (5 interactions) =====
      'a recruiter session and a talent with decision-log entries': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          // One grant audit row; the controller returns it as the sole
          // entries[] element with next_cursor=null (default limit=50).
          await seedAuditEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { scope: 'profile_storage' },
            createdAt: '2026-04-29T00:00:00.000Z',
          });
        });
      },
      'a recruiter session and a talent with consent history': async () => {
        // §4.2 #2 — seed 1 granted TalentConsentEvent. The pact response
        // shape is events:[1 element] with next_cursor=like(CURSOR). The
        // controller returns events:[1] with next_cursor=null when only
        // one row exists under the default limit.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a00',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a recruiter session and a talent with consent history (page 2 final)':
        async () => {
          // §4.2 #3 — seed 1 revoked TalentConsentEvent with created_at
          // strictly earlier than CURSOR_C, so the keyset predicate
          // (created_at, id) < (CURSOR_C, CURSOR_E) returns exactly this
          // row. With one row returned under default limit, hasMore=false
          // and next_cursor=null (matches the pact's exact-null assertion).
          await withClient(async (c) => {
            await resetAllRows(c);
            await seedConsentEvent(c, {
              id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
              scope: 'profile_storage',
              action: 'revoked',
              occurredAt: '2026-04-14T08:00:00.000Z',
              createdAt: '2026-04-14T08:00:00.000Z',
              expiresAt: null,
            });
          });
        },
      'a recruiter session and a talent with consent state': async () => {
        // §4.2 #4 — seed profile_storage + resume_processing grants; the
        // remaining 3 scopes return no_grant by Decision D (always-5-scopes
        // shape). The pact asserts scopes[0]=profile_storage granted,
        // scopes[1]=resume_processing granted, scopes[2..4]=other 3 scopes.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a10',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a11',
            scope: 'resume_processing',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'no setup required': async () => {
        // §4.2 #5 — no seed. The requestFilter intentionally does NOT
        // inject a cookie for this interaction (its request has no
        // Cookie header), so JwtAuthGuard returns INVALID_TOKEN 401.
        await withClient((c) => resetAllRows(c));
      },

      // ===== PR-15 §4.3 ats-thin (18 unique state handlers covering 23
      // interactions; duplicates of 'a valid recruiter token' / 'a talent
      // with no consent events' / 'no valid token' are handled by a
      // single entry each) =====

      // -- /v1/consent/check ----------------------------------------------
      'a talent with contacting consent older than 12 months': async () => {
        // §4.3 — seed profile_storage + matching (recent, satisfy
        // dependency chain) + contacting grant occurred_at > 12 months
        // ago. Decision F (contacting + stale) returns
        // reason_code=stale_consent.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c02',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1c03',
            scope: 'contacting',
            action: 'granted',
            occurredAt: '2024-01-01T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with profile_storage but no matching consent': async () => {
        // §4.3 — seed profile_storage only; contacting check's dependency
        // chain (profile_storage + matching) fails on matching → 422
        // INVALID_SCOPE_COMBINATION with reason_code=scope_dependency_unmet
        // and denied_scopes=['matching'].
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a valid recruiter token': async () => {
        // §4.3 — pre-DB validation paths (missing field, missing header,
        // path-param format) and recruiter-token-only writes. Reset only;
        // the JWT injection happens in requestFilter.
        await withClient((c) => resetAllRows(c));
      },
      'a talent with all required scopes granted for matching': async () => {
        // §4.3 — seed profile_storage + matching grants; check operation=
        // matching returns result=allowed, scope=matching.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1e01',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1e02',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with no consent events': async () => {
        // §4.3 — empty ledger. Used by check (Decision K → result=error,
        // reason_code=consent_state_unknown), history (events=[]), state
        // (all 5 scopes no_grant).
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/grant ----------------------------------------------
      'a valid recruiter token and an ungranted talent': async () => {
        // §4.3 — recruiter-session write; no pre-existing grant on the
        // talent for the requested scope (Decision Z grant for ungranted
        // talent path).
        await withClient((c) => resetAllRows(c));
      },
      'no valid token': async () => {
        // §4.3 — Bearer 'not-a-jwt' bypasses the rewriting filter so
        // JwtAuthGuard returns INVALID_TOKEN 401.
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/revoke --------------------------------------------
      'a valid recruiter token and a prior grant for talent+scope': async () => {
        // §4.3 — seed a prior matching grant so Decision A (revoke
        // references the prior grant id) fires; revoked_event_id is a
        // UUID matching the regex matcher.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1a01',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-29T00:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a valid recruiter token and no prior grant for talent+scope': async () => {
        // §4.3 — no prior grant; revoke succeeds with revoked_event_id
        // null (Decision D).
        await withClient((c) => resetAllRows(c));
      },

      // -- /v1/consent/decision-log --------------------------------------
      'a talent with one consent grant audit entry': async () => {
        // §4.3 — single audit row for a grant. entries[0] returns with
        // actor_type=recruiter and event_payload={event_id, scope}.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a01',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'inner-event-id', scope: 'matching' },
            createdAt: '2026-04-15T12:00:00.000Z',
          });
        });
      },
      'a talent with no audit entries': async () => {
        // §4.3 — empty audit. entries=[], next_cursor=null.
        await withClient((c) => resetAllRows(c));
      },
      'a talent with 5 audit entries; cursor at end of first page': async () => {
        // §4.3 — 5 audit rows; the cursor (CURSOR_C, CURSOR_E) sits at
        // page-1's edge, so the page-2 query with limit=2 returns rows
        // created_at < CURSOR_C. Need >2 older rows so hasMore=true and
        // next_cursor is a non-null encoded string.
        //
        // Row layout (newest → oldest by created_at):
        //   #1 (page 1)      created_at=2026-04-17, any type
        //   #2 (page 1 end)  created_at=CURSOR_C    id=CURSOR_E (cursor anchor)
        //   #3 (page 2 row1) created_at=2026-04-14T08:00:00Z  revoke entry
        //   #4 (page 2 row2) created_at=2026-04-13T15:30:00Z  check entry
        //   #5 (page 3)      created_at=2026-04-12, triggers hasMore=true
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000aa1',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-page1', scope: 'matching' },
            createdAt: '2026-04-17T10:00:00.000Z',
          });
          await seedAuditEvent(c, {
            id: CURSOR_E,
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-cursor', scope: 'matching' },
            createdAt: CURSOR_C,
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a02',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.revoke.recorded',
            payload: {
              event_id: 'inner-revoke-id',
              revoked_event_id: 'inner-grant-id',
              scope: 'matching',
            },
            createdAt: '2026-04-14T08:00:00.000Z',
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000a03',
            actorId: null,
            actorType: 'system',
            eventType: 'consent.check.decision',
            payload: {
              decision_id: 'inner-decision-id',
              reason_code: 'consent_revoked',
              result: 'denied',
            },
            createdAt: '2026-04-13T15:30:00.000Z',
          });
          await seedAuditEvent(c, {
            id: '00000000-0000-7000-8000-000000000aa5',
            actorId: PACT_RECRUITER_ACTOR_ID,
            actorType: 'recruiter',
            eventType: 'consent.grant.recorded',
            payload: { event_id: 'grant-id-page3', scope: 'matching' },
            createdAt: '2026-04-12T10:00:00.000Z',
          });
        });
      },

      // -- /v1/consent/history -------------------------------------------
      'a talent with one consent grant event': async () => {
        // §4.3 — single grant event. events=[1], next_cursor=null.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a01',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-15T12:00:00.000Z',
            createdAt: '2026-04-15T12:00:00.000Z',
            expiresAt: null,
          });
        });
      },
      'a talent with 5 consent events; cursor at end of first page': async () => {
        // §4.3 — 5 consent rows, cursor at end of page 1 (CURSOR_C,
        // CURSOR_E). Page-2 query with limit=2 returns 2 rows; >2 older
        // rows exist so next_cursor is a non-null encoded string.
        //
        // Row layout (newest → oldest by created_at):
        //   #1  page-1            created_at=2026-04-17  any
        //   #2  page-1 end        created_at=CURSOR_C  id=CURSOR_E (anchor)
        //   #3  page-2 row1       created_at=2026-04-14T08:00Z granted profile_storage
        //   #4  page-2 row2       created_at=2026-04-13T15:30Z revoked contacting
        //   #5  page-3            created_at=2026-04-12  any  → hasMore=true
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000ab1',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-17T10:00:00.000Z',
            createdAt: '2026-04-17T10:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: CURSOR_E,
            scope: 'matching',
            action: 'granted',
            occurredAt: CURSOR_C,
            createdAt: CURSOR_C,
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a02',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-14T08:00:00.000Z',
            createdAt: '2026-04-14T08:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000a03',
            scope: 'contacting',
            action: 'revoked',
            occurredAt: '2026-04-13T15:30:00.000Z',
            createdAt: '2026-04-13T15:30:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '00000000-0000-7000-8000-000000000ab5',
            scope: 'matching',
            action: 'granted',
            occurredAt: '2026-04-12T10:00:00.000Z',
            createdAt: '2026-04-12T10:00:00.000Z',
            expiresAt: null,
          });
        });
      },

      // -- /v1/consent/grant + /revoke — idempotency conflicts ----------
      'an idempotency key already used with a different body': async () => {
        // §4.3 — seed an IdempotencyKey row with a request_hash that
        // cannot collide with what the controller computes from the
        // pact-shipped body. Conflict resolves with IDEMPOTENCY_KEY_CONFLICT
        // 409 regardless of the grant route the consumer hits.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedIdempotencyKey(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d18',
            key: 'd2d7a0f0-0000-7000-8000-000000000001',
            requestHash: 'pact-seeded-conflict-hash-grant',
          });
        });
      },
      'a revoke idempotency key already used with a different body': async () => {
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedIdempotencyKey(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1d19',
            key: 'd2d7a0f0-0000-7000-8000-000000000097',
            requestHash: 'pact-seeded-conflict-hash-revoke',
          });
        });
      },

      // -- /v1/consent/state ---------------------------------------------
      'a talent with 4 consent scopes granted; cross_tenant_visibility not granted':
        async () => {
          // §4.3 + Amendment v1.1 §2.4 (Class D) — seed one grant per
          // scope EXCEPT cross_tenant_visibility. Decision D returns
          // granted for the 4 seeded scopes; cross_tenant_visibility
          // returns no_grant (no events) per the always-5-scopes shape.
          // computed_at + scopes[0..3].granted_at are matchered (regex);
          // scopes[4] is exact-match for the no_grant + null pattern.
          await withClient(async (c) => {
            await resetAllRows(c);
            const scopes = [
              'profile_storage',
              'resume_processing',
              'matching',
              'contacting',
            ] as const;
            let idx = 0;
            for (const scope of scopes) {
              idx += 1;
              await seedConsentEvent(c, {
                id: `0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f0${idx}`,
                scope,
                action: 'granted',
                occurredAt: '2026-04-01T10:00:00.000Z',
                expiresAt: null,
              });
            }
          });
        },
      'a talent with profile granted and contacting revoked': async () => {
        // §4.3 — profile_storage granted (status: granted); contacting
        // granted then revoked (Decision D: revoked). Remaining 3 scopes
        // return no_grant by Decision D.
        await withClient(async (c) => {
          await resetAllRows(c);
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f10',
            scope: 'profile_storage',
            action: 'granted',
            occurredAt: '2026-04-01T10:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f11',
            scope: 'contacting',
            action: 'granted',
            occurredAt: '2026-04-01T11:00:00.000Z',
            expiresAt: null,
          });
          await seedConsentEvent(c, {
            id: '0190d5a4-7e01-7e2a-a4d3-3d4f1c2b1f12',
            scope: 'contacting',
            action: 'revoked',
            occurredAt: '2026-04-15T14:22:00.000Z',
            expiresAt: null,
          });
        });
      },
    };

    // Request filter — rewrites the literal fake credentials the
    // consumer pacts ship into the real signed JWT, then forwards.
    //
    //   - tenant-console-consumer ships
    //     `Cookie: aramo_access_token=eyJfake.access.token` → rewrite
    //     the cookie value to the production-issuer JWT.
    //   - ats-thin ships `Authorization: Bearer eyJfake.token` → rewrite
    //     to `Bearer <real JWT>`. The literal `Bearer not-a-jwt` (the
    //     401-INVALID_TOKEN interaction) is intentionally bypassed so
    //     JwtAuthGuard rejects it.
    //   - tenant-console-consumer #5 ships NO Cookie header — the cookie
    //     branch is conditional on the literal substring, so it's a
    //     no-op for that interaction.
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
      const authHeader =
        req.headers['authorization'] ?? req.headers['Authorization'];
      if (
        typeof authHeader === 'string' &&
        authHeader === 'Bearer eyJfake.token'
      ) {
        req.headers['authorization'] = `Bearer ${accessJwt}`;
      }
      next();
    }

    it(
      'verifies all interactions from the 4 aramo-core pacts',
      async () => {
        const verifier = new Verifier({
          providerBaseUrl: `http://127.0.0.1:${port}`,
          pactUrls: [
            INGESTION_PACT,
            PROHIBITED_PACT,
            TENANT_CONSOLE_PACT,
            ATS_THIN_PACT,
          ],
          stateHandlers,
          requestFilter: requestFilter as never,
          logLevel: 'warn',
        });
        await verifier.verifyProvider();
      },
      600_000,
    );
  },
);
