import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { OutboxDeliveryService, PrismaService, SignWebhookRepository } from '@aramo/sign';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SignWebhookDeliveryService } from '../app/integrations/webhook-delivery.service.js';
import { encryptWebhookSecret } from '../app/integrations/webhook-secrets.js';
import { HttpWebhookEventPublisher, computeEsignWebhookSignature } from '../app/webhook-event-publisher.js';

// Sign Unified Product S-5 — end to end on real Postgres 17 with a real HTTP
// receiver: a lifecycle event in the outbox is fanned out to the envelope's
// subscriptions only, delivered with each subscription's own secret, verified by
// the receiver, deduplicated per (subscription, event), and retried on failure.

const ROOT = resolve(__dirname, '../../../..');
const esignMigrations = (): string[] => {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
};

const TENANT = randomUUID();
const ATS_SECRET = 'whs_ats_isolated_secret';
const ACME_SECRET = 'whs_acme_isolated_secret';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('Sign webhook subscriptions — end to end (S-5)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let server: Server;
  let base = '';
  let status = 204;
  const received: { path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    saved['k'] = process.env['SIGN_WEBHOOK_SECRET_KEY'];
    process.env['SIGN_WEBHOOK_SECRET_KEY'] = randomBytes(32).toString('base64');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await (prisma as unknown as { $disconnect(): Promise<void> })?.$disconnect();
    await db?.end();
    await container?.stop();
    if (saved['k'] === undefined) delete process.env['SIGN_WEBHOOK_SECRET_KEY'];
    else process.env['SIGN_WEBHOOK_SECRET_KEY'] = saved['k'];
  }, 60_000);

  async function envelope(source: string, installation: string | null): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."SignatureEnvelope" (id, tenant_id, subject, status, execution_mode, created_by, source_application, installation_id) VALUES ($1,$2,'Doc','COMPLETED','SINGLE_SIGNATURE',$3,$4,$5)`,
      [id, TENANT, randomUUID(), source, installation],
    );
    return id;
  }
  async function outbox(envelope_id: string): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "sign"."OutboxEvent" (id, tenant_id, event_type, event_payload) VALUES ($1,$2,'sign.envelope.executed.v1',$3)`,
      [id, TENANT, JSON.stringify({ envelope_id, correlation_id: 'corr', artifact_refs: { executed_document_ids: [], has_certificate: true } })],
    );
    return id;
  }

  it('fans out to the right subscriptions, signs with each one’s own secret, and dedupes', async () => {
    const ats = (await db.query(`SELECT id FROM "sign"."SignApplication" WHERE key = 'aramo-ats'`)).rows[0].id as string;
    const acmeApp = randomUUID();
    await db.query(`INSERT INTO "sign"."SignApplication" (id, key, name, kind, requested_permissions, modes) VALUES ($1,'acme-hr','Acme','THIRD_PARTY', ARRAY['sign:envelope:read'], ARRAY['APPLICATION'])`, [acmeApp]);
    const atsInst = randomUUID();
    const acmeInst = randomUUID();
    await db.query(`INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id, granted_permissions, modes, first_party_auto) VALUES ($1,$2,$3, ARRAY['sign:envelope:read'], ARRAY['USER'], true)`, [atsInst, TENANT, ats]);
    await db.query(`INSERT INTO "sign"."SignInstallation" (id, tenant_id, application_id, granted_permissions, modes, integration_role) VALUES ($1,$2,$3, ARRAY['sign:envelope:read'], ARRAY['APPLICATION'], 'sign_viewer')`, [acmeInst, TENANT, acmeApp]);
    const webhooks = new SignWebhookRepository(prisma);
    const atsSub = await webhooks.createSubscription({ application_id: ats, installation_id: null, tenant_id: null, target_url: `${base}/ats`, event_types: [], secret_ciphertext: encryptWebhookSecret(ATS_SECRET), internal: true, created_by: null });
    const acmeSub = await webhooks.createSubscription({ application_id: acmeApp, installation_id: acmeInst, tenant_id: TENANT, target_url: `${base}/acme`, event_types: [], secret_ciphertext: encryptWebhookSecret(ACME_SECRET), internal: true, created_by: null });

    const atsEnvelope = await envelope('aramo-ats', atsInst);
    const legacyAtsEnvelope = await envelope('aramo-ats', null);
    const acmeEnvelope = await envelope('acme-hr', acmeInst);
    const signEnvelope = await envelope('aramo-sign', null);
    const events = [await outbox(atsEnvelope), await outbox(legacyAtsEnvelope), await outbox(acmeEnvelope), await outbox(signEnvelope)];

    const fanout = new OutboxDeliveryService(prisma, new HttpWebhookEventPublisher(webhooks));
    expect(await fanout.deliverDueBatch()).toMatchObject({ claimed: 4, delivered: 4, failed: 0 });
    const rows = (await db.query(`SELECT subscription_id, event_id FROM "sign"."SignWebhookDelivery" ORDER BY created_at`)).rows;
    const bySub = (s: string) => rows.filter((r) => r.subscription_id === s).map((r) => r.event_id).sort();
    expect(bySub(atsSub.id)).toEqual([events[0], events[1]].sort());
    expect(bySub(acmeSub.id)).toEqual([events[2]]);
    expect(rows.some((r) => r.event_id === events[3])).toBe(false);

    // Re-fanning out the same event never duplicates a delivery.
    await db.query(`UPDATE "sign"."OutboxEvent" SET published_at = NULL, next_attempt_at = NULL WHERE id = $1`, [events[0]]);
    await fanout.deliverDueBatch();
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignWebhookDelivery" WHERE event_id = $1`, [events[0]])).rows[0].n).toBe(1);

    const delivery = new SignWebhookDeliveryService(webhooks);
    expect(await delivery.deliverDueBatch()).toMatchObject({ claimed: 3, delivered: 3, failed: 0 });
    for (const r of received) {
      const secret = r.path === '/ats' ? ATS_SECRET : ACME_SECRET;
      const ts = r.headers['x-aramo-sign-timestamp'] as string;
      expect(r.headers['x-aramo-sign-signature']).toBe(computeEsignWebhookSignature(ts, r.body, secret));
      expect(r.headers['x-aramo-sign-event-id']).toBe(JSON.parse(r.body).event_id);
    }
    expect(received.filter((r) => r.path === '/acme').map((r) => JSON.parse(r.body).envelope_id)).toEqual([acmeEnvelope]);
    expect((await db.query(`SELECT count(*)::int AS n FROM "sign"."SignWebhookDelivery" WHERE status = 'DELIVERED'`)).rows[0].n).toBe(3);
  });

  it('a failing receiver is retried later, not lost', async () => {
    status = 503;
    const ats = (await db.query(`SELECT id FROM "sign"."SignInstallation" WHERE first_party_auto = true LIMIT 1`)).rows[0].id as string;
    const webhooks = new SignWebhookRepository(prisma);
    const e = await outbox(await envelope('aramo-ats', ats));
    await new OutboxDeliveryService(prisma, new HttpWebhookEventPublisher(webhooks)).deliverDueBatch();
    const r = await new SignWebhookDeliveryService(webhooks).deliverDueBatch();
    expect(r).toMatchObject({ delivered: 0, failed: 1 });
    const row = (await db.query(`SELECT status, attempt_count, last_error_code, next_attempt_at FROM "sign"."SignWebhookDelivery" WHERE event_id = $1`, [e])).rows[0];
    expect(row).toMatchObject({ status: 'PENDING', attempt_count: 1, last_error_code: 'HTTP_503' });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    status = 204;
  });
});
