import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { OutboxDeliveryService } from '../lib/outbox-delivery.service.js';
import type { WebhookDeliveryPort, WebhookDeliveryResult } from '../lib/ports/webhook-delivery.port.js';

// E-Sign OC v2 (DEC-A/B) — durable outbound-delivery retry/backoff on real
// Postgres 17. Proves: failure advances attempt_count + a backoff next_attempt_at
// + a bounded last_error_code (never published); a not-yet-due row is not
// re-claimed; a later successful attempt stamps published_at.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

class ScriptedDelivery implements WebhookDeliveryPort {
  constructor(private outcome: WebhookDeliveryResult) {}
  set(outcome: WebhookDeliveryResult): void {
    this.outcome = outcome;
  }
  async deliver(): Promise<WebhookDeliveryResult> {
    return this.outcome;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('OutboxDeliveryService — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let raw: Client;
  let prisma: PrismaService;
  const TENANT = randomUUID();

  async function insertOutboxRow(): Promise<string> {
    const id = randomUUID();
    await raw.query(
      `INSERT INTO "esign"."OutboxEvent" (id, tenant_id, event_type, event_payload)
       VALUES ($1,$2,'esign.envelope.executed.v1',$3)`,
      [id, TENANT, JSON.stringify({ envelope_id: randomUUID(), correlation_id: randomUUID(), artifact_refs: { executed_document_ids: [], has_certificate: true } })],
    );
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    raw = new Client({ connectionString: container.getConnectionUri() });
    await raw.connect();
    for (const m of esignMigrations()) await raw.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await raw?.end();
    await container?.stop();
  });

  it('failure advances attempt_count + backoff next_attempt_at + bounded last_error_code, stays unpublished', async () => {
    const id = await insertOutboxRow();
    const delivery = new ScriptedDelivery({ ok: false, error_code: 'HTTP_503' });
    const svc = new OutboxDeliveryService(prisma, delivery);

    const t0 = new Date();
    const r = await svc.deliverDueBatch({ now: t0 });
    expect(r).toEqual({ claimed: 1, delivered: 0, failed: 1 });

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.published_at).toBeNull();
    expect(row.attempt_count).toBe(1);
    expect(row.last_error_code).toBe('HTTP_503');
    expect(row.next_attempt_at).not.toBeNull();
    // ~ +30s backoff after the first failure.
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(t0.getTime() + 20_000);
  });

  it('does not re-claim a row whose next_attempt_at is still in the future', async () => {
    const delivery = new ScriptedDelivery({ ok: true });
    const svc = new OutboxDeliveryService(prisma, delivery);
    // now is BEFORE the backoff window set by the previous test.
    const r = await svc.deliverDueBatch({ now: new Date(Date.now() - 60_000) });
    expect(r.claimed).toBe(0);
  });

  it('a later successful attempt stamps published_at (delivered once)', async () => {
    const id = await insertOutboxRow();
    const delivery = new ScriptedDelivery({ ok: true });
    const svc = new OutboxDeliveryService(prisma, delivery);

    const r = await svc.deliverDueBatch({ now: new Date() });
    expect(r.delivered).toBe(1);

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.published_at).not.toBeNull();
    expect(row.attempt_count).toBe(1);
    expect(row.last_error_code).toBeNull();

    // Already published -> not claimed again.
    const again = await svc.deliverDueBatch({ now: new Date() });
    expect(again.claimed).toBe(0);
  });
});
