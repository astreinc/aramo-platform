import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import express from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { ZoomWebhookSecretResolver } from '../communications/zoom-webhook-secret.resolver.js';
import { ZOOM_WEBHOOK_ROUTE, ZOOM_WEBHOOK_MAX_BODY_BYTES } from '../communications/zoom-webhook.constants.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// COMM-B6 — Zoom webhook lifecycle, HTTP boundary + real Postgres 17. Proves the
// LOCKED anti-oracle flow end-to-end against SYNTHETIC Zoom-shaped events whose
// correlation ids are KNOWN (the real embed→id capture is the explicit B8 gap):
//   503 dark-secret · 401 bad/stale signature · 200 url_validation challenge ·
//   400 malformed-post-auth · 204 unknown-account/unmatched/unsupported/dup/OK ·
//   matched → legal transition using occurred_at · illegal → recorded, no mutation.
// Tenant is resolved ONLY from the SIGNED account id. Skipped unless
// ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/communications/prisma/migrations/20260825120000_init_communications/migration.sql',
  'libs/integration/prisma/migrations/20260814170000_init_integration_connection/migration.sql',
].map(M);

const TENANT = '01900000-0000-7000-8000-00000000b6a1';
const CONNECTION = '01900000-0000-7000-8000-00000000b6c1';
const ACCOUNT_ID = 'zoom-acct-b6';
const SECRET = 'zoom-webhook-signing-secret-b6';

// Interaction fixtures (pre-populated with a KNOWN provider_call_element_id,
// simulating the B8 embed→id capture that B6 itself does not perform).
const INTX_RINGABLE = '01900000-0000-7000-8000-00000000d101'; // initiated, elem-ring
const ELEM_RINGABLE = 'elem-ring-1';
const INTX_ENDONLY = '01900000-0000-7000-8000-00000000d102'; // initiated, elem-end (illegal ->completed)
const ELEM_ENDONLY = 'elem-end-1';

class FakeSecretsWriter implements SecretsManagerWriterPort {
  async putSecretValue(): Promise<void> {
    /* no-op — boot must not reach AWS */
  }
}

// Test-controlled fake secret resolver (directive: tests inject a fake resolver).
let webhookSecret: string | null = SECRET;
const fakeSecretResolver = { resolve: async (): Promise<string | null> => webhookSecret };

function sign(rawBody: string, ts: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'COMM-B6 Zoom webhook — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function seedInteraction(id: string, elementId: string): Promise<void> {
      await db.query(
        `INSERT INTO communications."CommunicationInteraction"
           (id, tenant_id, channel, direction, status, integration_connection_id, from_address, to_address, provider_call_element_id, started_at)
         VALUES ($1::uuid, $2::uuid, 'voice', 'outbound', 'initiated', $3::uuid, '+15715550100', '+17035550111', $4, now())`,
        [id, TENANT, CONNECTION, elementId],
      );
    }

    async function statusOf(id: string): Promise<string> {
      const r = await db.query(`SELECT status FROM communications."CommunicationInteraction" WHERE id = $1::uuid`, [id]);
      return (r.rows[0] as { status: string }).status;
    }
    async function inboxRow(eventKey: string): Promise<{ status: string; interaction_id: string | null } | null> {
      const r = await db.query(
        `SELECT status, interaction_id FROM communications."CommunicationProviderEvent" WHERE provider_event_key = $1`,
        [eventKey],
      );
      return r.rows.length === 0 ? null : (r.rows[0] as { status: string; interaction_id: string | null });
    }
    async function inboxCount(): Promise<number> {
      const r = await db.query(`SELECT count(*)::int AS n FROM communications."CommunicationProviderEvent"`);
      return (r.rows[0] as { n: number }).n;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO integration."IntegrationConnection"
           (id, tenant_id, provider_key, status, secret_ref, provider_account_id, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'zoom_phone', 'configured', 'connector:v1:seed', $3, 0, now(), now())`,
        [CONNECTION, TENANT, ACCOUNT_ID],
      );
      await seedInteraction(INTX_RINGABLE, ELEM_RINGABLE);
      await seedInteraction(INTX_ENDONLY, ELEM_ENDONLY);

      savedEnv = { DATABASE_URL: process.env['DATABASE_URL'], ARAMO_ENV: process.env['ARAMO_ENV'] };
      process.env['DATABASE_URL'] = url;
      process.env['ARAMO_ENV'] = 'itest';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SECRETS_MANAGER_WRITER)
        .useValue(new FakeSecretsWriter())
        .overrideProvider(ZoomWebhookSecretResolver)
        .useValue(fakeSecretResolver)
        .compile();
      app = module.createNestApplication();
      // Mirror main.ts: the webhook route needs a raw body BEFORE json.
      app.use(ZOOM_WEBHOOK_ROUTE, express.raw({ type: () => true, limit: ZOOM_WEBHOOK_MAX_BODY_BYTES }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      webhookSecret = SECRET;
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    const url = () => `http://127.0.0.1:${port}${ZOOM_WEBHOOK_ROUTE}`;

    async function postSigned(rawBody: string, opts: { ts?: string; sig?: string } = {}): Promise<Response> {
      const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
      const sig = opts.sig ?? sign(rawBody, ts);
      return fetch(url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-zm-request-timestamp': ts,
          'x-zm-signature': sig,
        },
        body: rawBody,
      });
    }

    function ringing(elementId: string, account = ACCOUNT_ID, tsMs = 1_800_000_000_000): string {
      return JSON.stringify({
        event: 'phone.callee_ringing',
        event_ts: tsMs,
        payload: { account_id: account, object: { call_element_id: elementId } },
      });
    }

    it('503 when the webhook secret is unresolvable (dark by construction)', async () => {
      webhookSecret = null;
      const res = await postSigned(ringing(ELEM_RINGABLE));
      expect(res.status).toBe(503);
      webhookSecret = SECRET;
    });

    it('401 on an invalid signature', async () => {
      const res = await postSigned(ringing(ELEM_RINGABLE), { sig: 'v0=deadbeef' });
      expect(res.status).toBe(401);
    });

    it('401 on a stale (replayed) timestamp outside the window', async () => {
      const res = await postSigned(ringing(ELEM_RINGABLE), { ts: String(Math.floor(Date.now() / 1000) - 4000) });
      expect(res.status).toBe(401);
    });

    it('200 endpoint.url_validation returns plainToken + HMAC-SHA256 encryptedToken', async () => {
      const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'tok-xyz' } });
      const res = await postSigned(body);
      expect(res.status).toBe(200);
      const out = (await res.json()) as { plainToken: string; encryptedToken: string };
      expect(out.plainToken).toBe('tok-xyz');
      expect(out.encryptedToken).toBe(createHmac('sha256', SECRET).update('tok-xyz').digest('hex'));
      // No inbox row was created for the validation handshake.
      expect(await inboxRow('endpoint.url_validation:none:0')).toBeNull();
    });

    it('400 on a malformed body after a valid signature', async () => {
      const res = await postSigned('not json at all');
      expect(res.status).toBe(400);
    });

    it('204 no-op for an authentic event whose account maps to no connection (no oracle)', async () => {
      const res = await postSigned(ringing(ELEM_RINGABLE, 'unknown-account'));
      expect(res.status).toBe(204);
    });

    it('matched: 204 + legal transition initiated→ringing using occurred_at, inbox processed', async () => {
      expect(await statusOf(INTX_RINGABLE)).toBe('initiated');
      const res = await postSigned(ringing(ELEM_RINGABLE));
      expect(res.status).toBe(204);
      expect(await statusOf(INTX_RINGABLE)).toBe('ringing');
      const inbox = await inboxRow('phone.callee_ringing:elem-ring-1:1800000000000');
      expect(inbox?.status).toBe('processed');
      expect(inbox?.interaction_id).toBe(INTX_RINGABLE);
    });

    it('duplicate redelivery: 204 no-op, no re-transition, single inbox row', async () => {
      const before = await inboxCount();
      const res = await postSigned(ringing(ELEM_RINGABLE));
      expect(res.status).toBe(204);
      expect(await statusOf(INTX_RINGABLE)).toBe('ringing'); // unchanged
      expect(await inboxCount()).toBe(before); // no new row
    });

    it('unmatched correlation: 204, inbox ignored, no interaction mutation', async () => {
      const res = await postSigned(ringing('elem-does-not-exist'));
      expect(res.status).toBe(204);
      const inbox = await inboxRow('phone.callee_ringing:elem-does-not-exist:1800000000000');
      expect(inbox?.status).toBe('ignored');
      expect(inbox?.interaction_id).toBeNull();
    });

    it('unsupported event type: 204, inbox ignored (no forced transition)', async () => {
      const body = JSON.stringify({
        event: 'phone.recording_completed',
        event_ts: 1_800_000_000_001,
        payload: { account_id: ACCOUNT_ID, object: { call_element_id: ELEM_RINGABLE } },
      });
      const res = await postSigned(body);
      expect(res.status).toBe(204);
      expect((await inboxRow('phone.recording_completed:elem-ring-1:1800000000001'))?.status).toBe('ignored');
    });

    it('mapped-but-illegal transition: 204, inbox failed, NO mutation', async () => {
      expect(await statusOf(INTX_ENDONLY)).toBe('initiated');
      const body = JSON.stringify({
        event: 'phone.call_ended',
        event_ts: 1_800_000_000_002,
        payload: { account_id: ACCOUNT_ID, object: { call_element_id: ELEM_ENDONLY } },
      });
      const res = await postSigned(body);
      expect(res.status).toBe(204);
      expect(await statusOf(INTX_ENDONLY)).toBe('initiated'); // initiated→completed is illegal
      const inbox = await inboxRow('phone.call_ended:elem-end-1:1800000000002');
      expect(inbox?.status).toBe('failed');
    });
  },
);
