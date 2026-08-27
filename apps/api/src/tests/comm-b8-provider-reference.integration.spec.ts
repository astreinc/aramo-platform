import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { ZoomWebhookSecretResolver } from '../communications/zoom-webhook-secret.resolver.js';
import { ZOOM_WEBHOOK_ROUTE, ZOOM_WEBHOOK_MAX_BODY_BYTES } from '../communications/zoom-webhook.constants.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// COMM-B8 — provider-reference capture (embed→provider-id), HTTP boundary + real
// Postgres 17. Proves the capture closes the dial-time correlation gap: attach a
// provider id to a B5-style interaction, then a synthetic Zoom webhook NOW
// correlates and transitions it (before the attach, nothing matched). Also proves
// convergent-or-conflict, tenant+owner-safe 404, ≥1-required 400, and the scope
// gate. Skipped unless ARAMO_RUN_INTEGRATION=1.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-comm-b8-spec';
const ALG = 'RS256';
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql',
  'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql',
].map(M);

const TENANT = '01900000-0000-7000-8000-00000000b8a1';
const CONNECTION = '01900000-0000-7000-8000-00000000b8c1';
const ACCOUNT_ID = 'zoom-acct-b8';
const SECRET = 'zoom-webhook-signing-secret-b8';
const RECRUITER = '00000000-0000-7000-8000-00000000b8a1';
const OTHER_RECRUITER = '00000000-0000-7000-8000-00000000b8a2';
// A B5-style interaction (initiated, NULL correlation ids) owned by RECRUITER.
const INTX = '01900000-0000-7000-8000-00000000d801';
// A second interaction owned by OTHER_RECRUITER (owner-safety).
const INTX_OTHER = '01900000-0000-7000-8000-00000000d802';

const CALL = ['communication:voice:call'];
const READ_ONLY = ['communication:read'];

class FakeSecretsWriter implements SecretsManagerWriterPort {
  async putSecretValue(): Promise<void> {
    /* no-op */
  }
}
const fakeSecretResolver = { resolve: async (): Promise<string | null> => SECRET };

function signZoom(rawBody: string, ts: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B8 provider-reference capture — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let key: SignKey;

    function auth(jwt: string): RequestInit {
      return { headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } };
    }
    async function jwtFor(scopes: string[], sub = RECRUITER): Promise<string> {
      return new SignJWT({ sub, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }
    async function seedInteraction(id: string, initiatedBy: string): Promise<void> {
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address, initiated_by_id, started_at)
         VALUES ($1::uuid, $2::uuid, 'voice', 'outbound', 'initiated', $3::uuid, '+15715550100', '+17035550111', $4::uuid, now())`,
        [id, TENANT, CONNECTION, initiatedBy],
      );
    }
    async function colOf(id: string, col: string): Promise<string | null> {
      const r = await db.query(`SELECT ${col} AS v FROM communications."CommunicationInteraction" WHERE id = $1::uuid`, [id]);
      return (r.rows[0] as { v: string | null }).v;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'ats') ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      await db.query(
        `INSERT INTO integration."IntegrationConnection"
           (id, tenant_id, provider_key, status, secret_ref, provider_account_id, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'zoom_phone', 'configured', 'seed', $3, 0, now(), now())`,
        [CONNECTION, TENANT, ACCOUNT_ID],
      );
      await seedInteraction(INTX, RECRUITER);
      await seedInteraction(INTX_OTHER, OTHER_RECRUITER);

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      key = kp.privateKey as SignKey;
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

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(new FakeSecretsWriter())
        .overrideProvider(ZoomWebhookSecretResolver)
        .useValue(fakeSecretResolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.use(ZOOM_WEBHOOK_ROUTE, express.raw({ type: () => true, limit: ZOOM_WEBHOOK_MAX_BODY_BYTES }));
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
    const refPath = (id: string) => `/v1/communications/interactions/${id}/provider-reference`;

    async function attach(jwt: string, id: string, body: unknown): Promise<Response> {
      return fetch(url(refPath(id)), { method: 'POST', ...auth(jwt), body: JSON.stringify(body) });
    }

    it('DENIED without communication:voice:call (403)', async () => {
      const jwt = await jwtFor(READ_ONLY);
      const res = await attach(jwt, INTX, { provider_call_element_id: 'e-1' });
      expect(res.status).toBe(403);
    });

    it('requires at least one provider id (400 VALIDATION_ERROR)', async () => {
      const jwt = await jwtFor(CALL);
      const res = await attach(jwt, INTX, {});
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error?: { code?: string } };
      expect(err.error?.code).toBe('VALIDATION_ERROR');
    });

    it('unknown/cross-tenant interaction → 404 tenant-safe', async () => {
      const jwt = await jwtFor(CALL);
      const res = await attach(jwt, '01900000-0000-7000-8000-0000000000ff', { provider_call_id: 'c-x' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('COMMUNICATION_INTERACTION_NOT_FOUND');
    });

    it('owner-safe: a peer recruiter\'s interaction → 404 (no disclosure)', async () => {
      const jwt = await jwtFor(CALL); // sub = RECRUITER, but INTX_OTHER is OTHER_RECRUITER's
      const res = await attach(jwt, INTX_OTHER, { provider_call_element_id: 'e-peer' });
      expect(res.status).toBe(404);
    });

    it('fills a null field (200) — and CLOSES THE LOOP: a synthetic webhook now correlates', async () => {
      const jwt = await jwtFor(CALL);
      expect(await colOf(INTX, 'provider_call_element_id')).toBeNull();
      const res = await attach(jwt, INTX, { provider_call_element_id: 'elem-b8-1' });
      expect(res.status).toBe(200);
      expect(await colOf(INTX, 'provider_call_element_id')).toBe('elem-b8-1');
      expect(await colOf(INTX, 'status')).toBe('initiated'); // NO state change on attach

      // Now a real-shaped Zoom webhook carrying that element id correlates + transitions.
      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        event: 'phone.callee_ringing',
        event_ts: 1_800_000_000_000,
        payload: { account_id: ACCOUNT_ID, object: { call_element_id: 'elem-b8-1' } },
      });
      const hook = await fetch(url(ZOOM_WEBHOOK_ROUTE), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-zm-request-timestamp': ts, 'x-zm-signature': signZoom(body, ts) },
        body,
      });
      expect(hook.status).toBe(204);
      expect(await colOf(INTX, 'status')).toBe('ringing'); // the loop is closed
    });

    it('convergent: re-attaching the SAME value is a 200 no-op', async () => {
      const jwt = await jwtFor(CALL);
      const res = await attach(jwt, INTX, { provider_call_element_id: 'elem-b8-1' });
      expect(res.status).toBe(200);
      expect(await colOf(INTX, 'provider_call_element_id')).toBe('elem-b8-1');
    });

    it('conflict: replacing a set field with a DIFFERENT value → 409, no overwrite', async () => {
      const jwt = await jwtFor(CALL);
      const res = await attach(jwt, INTX, { provider_call_element_id: 'elem-DIFFERENT' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('COMMUNICATION_PROVIDER_REFERENCE_CONFLICT');
      expect(await colOf(INTX, 'provider_call_element_id')).toBe('elem-b8-1'); // unchanged
    });

    it('fills a DIFFERENT null field alongside an unchanged one (200)', async () => {
      const jwt = await jwtFor(CALL);
      expect(await colOf(INTX, 'provider_call_id')).toBeNull();
      const res = await attach(jwt, INTX, { provider_call_element_id: 'elem-b8-1', provider_call_id: 'call-b8-9' });
      expect(res.status).toBe(200);
      expect(await colOf(INTX, 'provider_call_id')).toBe('call-b8-9');
    });
  },
);
