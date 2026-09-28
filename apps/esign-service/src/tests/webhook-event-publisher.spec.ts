import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EsignLifecycleEvent } from '@aramo/esign';

import { HttpWebhookEventPublisher, computeEsignWebhookSignature } from '../app/webhook-event-publisher.js';

const EVENT: EsignLifecycleEvent = {
  event_id: 'outbox-1',
  event_type: 'esign.envelope.executed.v1',
  event_version: 1,
  occurred_at: '2026-09-27T12:00:00.000Z',
  tenant_id: 't1',
  envelope_id: 'env-1',
  correlation_id: 'corr-1',
  artifact_refs: { executed_document_ids: ['d1'], has_certificate: true },
};

describe('HttpWebhookEventPublisher (HMAC + timestamp signed webhook)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['ESIGN_WEBHOOK_SIGNING_SECRET'];
    delete process.env['ESIGN_WEBHOOK_TARGET_URL'];
  });

  it('computeEsignWebhookSignature signs `timestamp.rawBody` deterministically', () => {
    const a = computeEsignWebhookSignature('1790550123', '{"x":1}', 'secret');
    const b = computeEsignWebhookSignature('1790550123', '{"x":1}', 'secret');
    expect(a).toBe(b);
    // A different timestamp or body changes the signature.
    expect(computeEsignWebhookSignature('1790550124', '{"x":1}', 'secret')).not.toBe(a);
    expect(computeEsignWebhookSignature('1790550123', '{"x":2}', 'secret')).not.toBe(a);
  });

  it('signs the EXACT posted body with the sent timestamp and posts to the receiver', async () => {
    process.env['ESIGN_WEBHOOK_SIGNING_SECRET'] = 'shhh';
    process.env['ESIGN_WEBHOOK_TARGET_URL'] = 'http://core.local/v1/integrations/esign/events';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const res = await new HttpWebhookEventPublisher().deliver(EVENT);
    expect(res).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://core.local/v1/integrations/esign/events');
    const ts = init.headers['x-aramo-esign-timestamp'];
    const sig = init.headers['x-aramo-esign-signature'];
    const body = init.body as string;
    // Signature is over the exact bytes sent — recomputing from the captured
    // timestamp + captured body must match.
    expect(sig).toBe(computeEsignWebhookSignature(ts, body, 'shhh'));
    expect(body).toBe(JSON.stringify(EVENT));
  });

  it('fails closed (never delivers unsigned) when no signing secret is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await new HttpWebhookEventPublisher().deliver(EVENT);
    expect(res).toEqual({ ok: false, error_code: 'NO_SIGNING_SECRET' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a bounded error code on a non-2xx response', async () => {
    process.env['ESIGN_WEBHOOK_SIGNING_SECRET'] = 'shhh';
    process.env['ESIGN_WEBHOOK_TARGET_URL'] = 'http://core.local/hook';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    const res = await new HttpWebhookEventPublisher().deliver(EVENT);
    expect(res).toEqual({ ok: false, error_code: 'HTTP_503' });
  });
});
