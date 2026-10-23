import { describe, expect, it, vi } from 'vitest';
import { signIntelligenceWebhook } from '@aramo/intelligence-contracts';

import { IntelligenceWebhookReceiver } from '../lib/intelligence-webhook.receiver.js';

// ATI-SEP-1 T8 — the TI → ATS webhook receiver: HMAC accept / reject / replay.

const SECRET = 'w'.repeat(40);
const NOW = 1_800_000_000;
const BODY = {
  event_id: '0190bbbb-0000-7000-8000-000000000001',
  event_type: 'golden_talent.profile_updated',
  event_version: 'v1',
  intelligence_subject_id: '33333333-3333-7333-8333-333333333333',
  occurred_at: '2026-10-23T10:00:00.000Z',
  source_system_id: 'ARAMO_ATS',
  source_tenant_id: '11111111-1111-7111-8111-111111111111',
  external_talent_id: '22222222-2222-7222-8222-222222222222',
  changed_fact_types: ['TITLE'],
};

function signed(body: unknown, opts: { secret?: string; nowSec?: number } = {}) {
  const rawBody = JSON.stringify(body);
  const h = signIntelligenceWebhook({ rawBody, secret: opts.secret ?? SECRET, nowSec: opts.nowSec ?? NOW });
  return { rawBody: Buffer.from(rawBody), timestampHeader: h['x-aramo-intelligence-timestamp'], signatureHeader: h['x-aramo-intelligence-signature'] };
}

function receiver() {
  const seen = new Set<string>();
  const records = {
    recordInboundEvent: vi.fn(async (row: { event_id: string }) => {
      if (seen.has(row.event_id)) return 'duplicate' as const;
      seen.add(row.event_id);
      return 'created' as const;
    }),
  };
  return { r: new IntelligenceWebhookReceiver(records as never), records };
}

describe('ATI-SEP-1 T8 — IntelligenceWebhookReceiver', () => {
  it('ACCEPTS a valid signature → 202 and records the delivery (ids only)', async () => {
    const { r, records } = receiver();
    await expect(r.receive({ ...signed(BODY), secret: SECRET, nowSec: NOW })).resolves.toEqual({ status: 202, body: { received: true, event_id: BODY.event_id } });
    expect(records.recordInboundEvent).toHaveBeenCalledWith({
      event_id: BODY.event_id,
      tenant_id: BODY.source_tenant_id,
      talent_record_id: BODY.external_talent_id,
      intelligence_subject_id: BODY.intelligence_subject_id,
      changed_fact_types: ['TITLE'],
      occurred_at: new Date(BODY.occurred_at),
    });
  });

  it('REPLAY of the same event_id → 200 duplicate, nothing else recorded', async () => {
    const { r } = receiver();
    await r.receive({ ...signed(BODY), secret: SECRET, nowSec: NOW });
    await expect(r.receive({ ...signed(BODY), secret: SECRET, nowSec: NOW + 10 })).resolves.toEqual({ status: 200, body: { received: true, duplicate: true, event_id: BODY.event_id } });
  });

  it('REJECTS 401 — no secret configured / wrong secret / stale timestamp / missing headers / tampered body; nothing recorded', async () => {
    const { r, records } = receiver();
    const good = signed(BODY);
    const cases = [
      { ...good, secret: undefined },
      { ...good, secret: '' },
      { ...signed(BODY, { secret: 'x'.repeat(40) }), secret: SECRET },
      { ...signed(BODY, { nowSec: NOW - 301 }), secret: SECRET },
      { ...good, signatureHeader: undefined, secret: SECRET },
      { ...good, timestampHeader: undefined, secret: SECRET },
      { ...good, rawBody: Buffer.from(JSON.stringify({ ...BODY, external_talent_id: '44444444-4444-7444-8444-444444444444' })), secret: SECRET },
    ];
    for (const c of cases) {
      const prev = process.env['INTELLIGENCE_WEBHOOK_SIGNING_SECRET'];
      delete process.env['INTELLIGENCE_WEBHOOK_SIGNING_SECRET'];
      await expect(r.receive({ ...c, nowSec: NOW })).resolves.toEqual({ status: 401 });
      if (prev !== undefined) process.env['INTELLIGENCE_WEBHOOK_SIGNING_SECRET'] = prev;
    }
    expect(records.recordInboundEvent).not.toHaveBeenCalled();
  });

  it('a validly signed but malformed body → 400 (extra key, non-uuid talent, wrong event type)', async () => {
    const { r, records } = receiver();
    for (const body of [{ ...BODY, extra: 1 }, { ...BODY, external_talent_id: 'not-a-uuid' }, { ...BODY, event_type: 'talent.created' }]) {
      await expect(r.receive({ ...signed(body), secret: SECRET, nowSec: NOW })).resolves.toEqual({ status: 400 });
    }
    expect(records.recordInboundEvent).not.toHaveBeenCalled();
  });
});
