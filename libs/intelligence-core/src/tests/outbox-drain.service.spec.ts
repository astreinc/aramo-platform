import {
  INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER,
  INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER,
  isIntelligenceProfileUpdatedWebhook,
  verifyIntelligenceWebhook,
} from '@aramo/intelligence-contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { EntitlementService, backoffMs, type DrainConfig } from '../index.js';

import { VERIFIED, snapshot } from './support/fixtures.js';
import { ATS, services } from './support/services.js';

// ATI-SEP-1 T7 — the lease-safe outbox drain: one signed webhook per ACTIVE
// reference of an ENTITLED tenant, at-least-once with backoff and quarantine,
// fail-closed without a secret, verification facts routed to the delivery port
// (never the webhook), and lease-guarded writes.

const SECRET = 'w'.repeat(40);
const URL = 'http://api:3000/v1/integrations/intelligence/events';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const cfg = (over: Partial<DrainConfig> = {}): DrainConfig => ({
  batchSize: 25,
  leaseMs: 60_000,
  maxAttempts: 3,
  baseBackoffMs: 5_000,
  maxBackoffMs: 3_600_000,
  webhookUrl: URL,
  signingSecret: SECRET,
  ...over,
});

describe('IntelligenceOutboxDrainService', () => {
  let s: ReturnType<typeof services>;

  beforeEach(async () => {
    s = services();
    const email = [{ value: 'priya@x.io', is_primary: true, verification: { ...VERIFIED } }];
    for (const [tenant, talent] of [
      ['tenant-a', 'a-1'],
      ['tenant-b', 'b-1'],
      ['tenant-c', 'c-1'],
      ['tenant-a', 'a-2'],
    ] as const) {
      await s.ingest.ingest(snapshot({ tenant, talent, identity: { names: { first: 'Priya', last: 'Raman' }, emails: email } }), ATS);
    }
    // tenant-c is not entitled; tenant-a's a-2 is erased.
    await new EntitlementService(s.mem).sync({ source_system_id: 'ARAMO_ATS', mode: 'UPSERT', tenants: [{ tenant_id: 'tenant-a', active: true }, { tenant_id: 'tenant-b', active: true }] }, ATS);
    await s.ingest.erase({ source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-2', source_event_id: 'erase-a2', occurred_at: '2026-10-23T00:00:00.000Z' }, ATS);
    // only the last projection event matters for these specs
    s.mem.state.outbox.splice(0, s.mem.state.outbox.length - 1);
  });

  it('fans one profile_updated out to ONE signed delivery per ACTIVE reference of an ENTITLED tenant', async () => {
    const report = await s.drain.drainOnce(NOW, cfg());
    expect(report).toMatchObject({ outbox_published: 1, deliveries_created: 2, deliveries_delivered: 2 });
    expect(s.mem.state.outbox[0]?.published_at).toEqual(NOW);
    const bodies = s.transport.posts.map((p) => JSON.parse(p.body) as Record<string, unknown>);
    expect(bodies.map((b) => `${b['source_tenant_id']}/${b['external_talent_id']}`).sort()).toEqual(['tenant-a/a-1', 'tenant-b/b-1']);
    for (const p of s.transport.posts) {
      expect(p.url).toBe(URL);
      const body = JSON.parse(p.body) as unknown;
      expect(isIntelligenceProfileUpdatedWebhook(body)).toBe(true);
      expect(
        verifyIntelligenceWebhook({
          rawBody: p.body,
          timestampHeader: p.headers[INTELLIGENCE_WEBHOOK_TIMESTAMP_HEADER],
          signatureHeader: p.headers[INTELLIGENCE_WEBHOOK_SIGNATURE_HEADER],
          secret: SECRET,
          nowSec: Math.floor(NOW.getTime() / 1000),
        }),
      ).toEqual({ ok: true });
      expect(p.body).not.toContain('priya');
    }
    expect(new Set(bodies.map((b) => b['event_id'])).size).toBe(2);
    expect(s.mem.state.deliveries.every((d) => d.delivered_at !== null)).toBe(true);
    // a second pass does nothing
    expect(await s.drain.drainOnce(NOW, cfg())).toMatchObject({ outbox_published: 0, deliveries_delivered: 0 });
  });

  it('retries with exponential backoff, then quarantines after the attempt cap', async () => {
    s.transport.status = 503;
    expect(await s.drain.drainOnce(NOW, cfg())).toMatchObject({ deliveries_retried: 2 });
    const d = s.mem.state.deliveries[0];
    expect(d).toMatchObject({ attempts: 1, last_error: 'HTTP_503', lease_expires_at: new Date(NOW.getTime() + 5_000) });
    // still backing off → not claimed
    expect(await s.drain.drainOnce(new Date(NOW.getTime() + 1_000), cfg())).toMatchObject({ deliveries_retried: 0 });
    s.transport.fail = new Error('connect ECONNREFUSED');
    expect(await s.drain.drainOnce(new Date(NOW.getTime() + 6_000), cfg())).toMatchObject({ deliveries_retried: 2 });
    expect(s.mem.state.deliveries[0]).toMatchObject({ attempts: 2, last_error: 'NETWORK' });
    expect(await s.drain.drainOnce(new Date(NOW.getTime() + 60_000), cfg())).toMatchObject({ deliveries_quarantined: 2 });
    expect(s.mem.state.deliveries.every((x) => x.quarantined_at !== null && x.delivered_at === null)).toBe(true);
    expect(backoffMs(1, cfg())).toBe(5_000);
    expect(backoffMs(4, cfg())).toBe(40_000);
    expect(backoffMs(40, cfg())).toBe(3_600_000);
  });

  it('fails closed without a signing secret or URL: nothing is sent, no attempt is consumed', async () => {
    const report = await s.drain.drainOnce(NOW, cfg({ signingSecret: null }));
    expect(report).toMatchObject({ deliveries_created: 2, deliveries_deferred: 2, deliveries_delivered: 0 });
    expect(s.transport.posts).toHaveLength(0);
    expect(s.mem.state.deliveries.every((d) => d.attempts === 0 && d.delivered_at === null)).toBe(true);
    // after the lease, a configured drain delivers them
    expect(await s.drain.drainOnce(new Date(NOW.getTime() + 61_000), cfg())).toMatchObject({ deliveries_delivered: 2 });
  });

  it('a worker that lost its lease writes nothing (claim token guard)', async () => {
    const [row] = await s.mem.run((r) => r.outbox.claim(10, NOW, 60_000));
    // another worker re-claims after the lease
    await s.mem.run((r) => r.outbox.claim(10, new Date(NOW.getTime() + 61_000), 60_000));
    expect(await s.mem.run((r) => r.outbox.markPublished(row?.id as string, row?.claimed_at as Date, NOW))).toBe(false);
  });

  it("'identifier_verification.requested' goes to the delivery port with the code — never to the webhook", async () => {
    s.mem.state.outbox.length = 0;
    const r = await s.verification.create(
      { source_reference: { source_system_id: 'ARAMO_ATS', source_tenant_id: 'tenant-a', external_talent_id: 'a-1' }, identifier_type: 'EMAIL', value: 'priya@x.io' },
      ATS,
      NOW,
    );
    const report = await s.drain.drainOnce(NOW, cfg());
    expect(report).toMatchObject({ outbox_published: 1, deliveries_created: 0 });
    expect(s.transport.posts).toHaveLength(0);
    expect(s.delivery.sent).toHaveLength(1);
    const row = s.mem.state.verifications.get(r.verification_id) as NonNullable<ReturnType<typeof s.mem.state.verifications.get>>;
    expect(s.delivery.sent[0]).toMatchObject({ verification_id: r.verification_id, channel: 'EMAIL', destination: 'priya@x.io', code: s.codes.codeFor(row.id, row.code_salt) });
  });

  it('SMS → quarantined NOT_AVAILABLE; a transient adapter failure retries', async () => {
    s.mem.state.outbox.length = 0;
    const ref = { source_system_id: 'ARAMO_ATS' as const, source_tenant_id: 'tenant-a', external_talent_id: 'a-1' };
    await s.verification.create({ source_reference: ref, identifier_type: 'PHONE', value: '+1 555 010 2000' }, ATS, NOW);
    expect(await s.drain.drainOnce(NOW, cfg())).toMatchObject({ outbox_quarantined: 1 });
    expect(s.mem.state.outbox[0]).toMatchObject({ last_publish_error: 'NOT_AVAILABLE' });

    s.delivery.next = { status: 'RETRY', error: 'SMTP_421' };
    await s.verification.create({ source_reference: ref, identifier_type: 'EMAIL', value: 'priya@x.io' }, ATS, NOW);
    expect(await s.drain.drainOnce(NOW, cfg())).toMatchObject({ outbox_retried: 1 });
    expect(s.mem.state.outbox[1]).toMatchObject({ publish_attempts: 1, last_publish_error: 'SMTP_421' });
  });

  it('an unknown event type is quarantined', async () => {
    s.mem.state.outbox.length = 0;
    await s.mem.run((r) => r.outbox.enqueue({ event_type: 'something.else', subject_id: 'x', payload: {}, occurred_at: NOW }));
    expect(await s.drain.drainOnce(NOW, cfg())).toMatchObject({ outbox_quarantined: 1 });
  });
});
