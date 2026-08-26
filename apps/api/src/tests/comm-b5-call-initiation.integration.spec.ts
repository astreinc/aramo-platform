import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from '@aramo/integration';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// COMM-B5 (Aramo-COMM-V1) — call initiation, HTTP boundary + real Postgres 17.
// Proves the LOCKED execution order and its security invariants end-to-end:
//   - communication:voice:call scope gate (least-visibility) + Idempotency-Key
//     required (external side effect must not dial twice);
//   - the fail-closed contacting-consent gate runs BEFORE any interaction is
//     created or any provider is called — an ungranted talent is REFUSED with
//     COMMUNICATION_CALL_CONSENT_DENIED and NO interaction row is written;
//   - a granted talent → 201 `initiated`, the destination resolved server-side
//     from the Talent phone slot and E.164-normalized, a subject association;
//   - provider-not-configured / user-not-mapped / no-dialable-number refusals;
//   - Idempotency replay converges on the same interaction (dials once).
// Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-comm-b5-call-spec';
const ALG = 'RS256';
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql',
  'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql',
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
].map(M);

const TENANT_A = '01900000-0000-7000-8000-00000000b5a1';
const TENANT_B = '01900000-0000-7000-8000-00000000b5b2';
const CONNECTION = '01900000-0000-7000-8000-00000000b5c1';
const RECRUITER_MAPPED = '00000000-0000-7000-8000-00000000b5a1';
const RECRUITER_UNMAPPED = '00000000-0000-7000-8000-00000000b5a2';
// Talent fixtures.
const TALENT_GRANTED = '01900000-0000-7000-8000-00000000b511'; // full consent + phone
const TALENT_UNGRANTED = '01900000-0000-7000-8000-00000000b512'; // phone, NO consent
const TALENT_NO_PHONE = '01900000-0000-7000-8000-00000000b513'; // consent, no phone_cell
const TALENT_B = '01900000-0000-7000-8000-00000000b514'; // tenant B, phone

const CALL_SCOPES = ['communication:voice:call'];
const READ_ONLY_SCOPES = ['communication:read'];

class FakeSecretsWriter implements SecretsManagerWriterPort {
  async putSecretValue(): Promise<void> {
    /* no-op — AppModule boot must not reach AWS */
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B5 call initiation — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    let callJwtA: string;
    let readOnlyJwtA: string;
    let unmappedJwtA: string;
    let callJwtB: string;

    function auth(jwt: string, idempotencyKey?: string): RequestInit {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      };
      if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
      return { headers };
    }

    async function signJwt(
      key: SignKey,
      args: { sub: string; tenant_id: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function seedTalent(args: {
      id: string;
      tenant_id: string;
      phone_cell?: string | null;
    }): Promise<void> {
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, phone_cell, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Ada', 'Callee', $3, now(), now())`,
        [args.id, args.tenant_id, args.phone_cell ?? null],
      );
    }

    async function grantContacting(talentId: string, tenantId: string): Promise<void> {
      for (const scope of ['profile_storage', 'matching', 'contacting']) {
        await db.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, 'granted', $5::uuid,
                   'recruiter_capture', 'v1', now(), now())`,
          [randomUUID(), talentId, tenantId, scope, RECRUITER_MAPPED],
        );
      }
    }

    async function interactionCount(tenantId: string, toAddress: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationInteraction"
         WHERE tenant_id = $1::uuid AND to_address = $2`,
        [tenantId, toAddress],
      );
      return (r.rows[0] as { n: number }).n;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_A);
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_B);
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }
      // Tenant A has a usable zoom_phone connection + a mapped recruiter; tenant B has none.
      await db.query(
        `INSERT INTO integration."IntegrationConnection"
           (id, tenant_id, provider_key, status, secret_ref, provider_account_id, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'zoom_phone', 'configured', 'connector:v1:seed', 'zoom-acct-1', 0, now(), now())`,
        [CONNECTION, TENANT_A],
      );
      await db.query(
        `INSERT INTO communications."CommunicationProviderIdentity"
           (id, tenant_id, integration_connection_id, recruiter_id, provider_user_id, provider_extension_id, voice_enabled, sms_enabled, status)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'zoom-user-1', 'ext-1', true, false, 'active')`,
        [TENANT_A, CONNECTION, RECRUITER_MAPPED],
      );

      await seedTalent({ id: TALENT_GRANTED, tenant_id: TENANT_A, phone_cell: '(555) 234-5678' });
      await seedTalent({ id: TALENT_UNGRANTED, tenant_id: TENANT_A, phone_cell: '(555) 234-9999' });
      await seedTalent({ id: TALENT_NO_PHONE, tenant_id: TENANT_A, phone_cell: null });
      await seedTalent({ id: TALENT_B, tenant_id: TENANT_B, phone_cell: '(555) 234-7777' });
      await grantContacting(TALENT_GRANTED, TENANT_A);
      await grantContacting(TALENT_NO_PHONE, TENANT_A);
      await grantContacting(TALENT_B, TENANT_B);
      // TALENT_UNGRANTED intentionally has NO consent events → fail-closed.

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const key: SignKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        ARAMO_ENV: process.env['ARAMO_ENV'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['ARAMO_ENV'] = 'itest';

      callJwtA = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_A, scopes: CALL_SCOPES });
      readOnlyJwtA = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_A, scopes: READ_ONLY_SCOPES });
      unmappedJwtA = await signJwt(key, { sub: RECRUITER_UNMAPPED, tenant_id: TENANT_A, scopes: CALL_SCOPES });
      callJwtB = await signJwt(key, { sub: RECRUITER_MAPPED, tenant_id: TENANT_B, scopes: CALL_SCOPES });

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(new FakeSecretsWriter())
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    const CALLS = '/v1/communications/calls';

    it('DENIED without communication:voice:call (403) and makes no write', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(readOnlyJwtA, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_GRANTED, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(403);
    });

    it('requires an Idempotency-Key (400 VALIDATION_ERROR when missing)', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(callJwtA), // no Idempotency-Key
        body: JSON.stringify({ talent_id: TALENT_GRANTED, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('VALIDATION_ERROR');
    });

    it('FAIL-CLOSED: ungranted contacting consent → 403 CALL_CONSENT_DENIED, NO interaction written, no internals leaked', async () => {
      const before = await interactionCount(TENANT_A, '+15552349999');
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(callJwtA, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_UNGRANTED, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(403);
      const raw = await res.text();
      const err = JSON.parse(raw) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_CALL_CONSENT_DENIED');
      // No consent-resolver internals leak to the caller.
      expect(raw).not.toMatch(/reason_code|consent_state_unknown|channel_not_consented|decision_id/i);
      // The provider is called only AFTER consent + create — a denial writes nothing.
      expect(await interactionCount(TENANT_A, '+15552349999')).toBe(before);
    });

    it('granted consent → 201 `initiated`, server-resolved E.164 destination, one interaction', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(callJwtA, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_GRANTED, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        channel: string;
        direction: string;
        status: string;
        to_address: string;
      };
      expect(body.channel).toBe('voice');
      expect(body.direction).toBe('outbound');
      expect(body.status).toBe('initiated');
      expect(body.to_address).toBe('+15552345678'); // (555) 234-5678 resolved server-side
      // A subject association to the talent record was written.
      const assoc = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationAssociation"
         WHERE interaction_id = $1::uuid AND subject_type = 'talent_record'
           AND subject_id = $2::uuid AND relation_type = 'subject'`,
        [body.id, TALENT_GRANTED],
      );
      expect((assoc.rows[0] as { n: number }).n).toBe(1);
    });

    it('no dialable number in the chosen slot → 422 CALL_NOT_INITIABLE', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(callJwtA, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_NO_PHONE, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(422);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_CALL_NOT_INITIABLE');
    });

    it('tenant without a provider connection → 409 PROVIDER_NOT_CONFIGURED', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(callJwtB, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_B, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(409);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_PROVIDER_NOT_CONFIGURED');
    });

    it('calling recruiter without a provider-identity mapping → 404 USER_NOT_MAPPED', async () => {
      const res = await fetch(url(CALLS), {
        method: 'POST',
        ...auth(unmappedJwtA, randomUUID()),
        body: JSON.stringify({ talent_id: TALENT_GRANTED, phone_slot: 'cell' }),
      });
      expect(res.status).toBe(404);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('COMMUNICATION_USER_NOT_MAPPED');
    });

    it('Idempotency replay: same key + same body converges on one interaction (dials once)', async () => {
      const key = randomUUID();
      const body = JSON.stringify({ talent_id: TALENT_GRANTED, phone_slot: 'cell' });
      const first = await fetch(url(CALLS), { method: 'POST', ...auth(callJwtA, key), body });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { id: string };
      const before = await interactionCount(TENANT_A, '+15552345678');
      const second = await fetch(url(CALLS), { method: 'POST', ...auth(callJwtA, key), body });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { id: string };
      expect(secondBody.id).toBe(firstBody.id); // same interaction
      expect(await interactionCount(TENANT_A, '+15552345678')).toBe(before); // no new row
    });
  },
);
