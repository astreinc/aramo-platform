import { describe, expect, it } from 'vitest';

import { parseZoomWebhookEnvelope } from '../lib/provider/zoom/zoom-webhook-envelope.js';
import {
  ZoomPhoneAdapter,
  ZoomUnsupportedWebhookEventError,
} from '../lib/provider/zoom/zoom-phone.adapter.js';

// COMM-B6 — envelope parse + normalizeWebhook canonical mapping. B6 maps ONLY
// provider events that fit UNAMBIGUOUSLY into the currently governed 8-state
// machine (the outbound spine ringing→connected→completed). No speculative enum
// expansion (busy/canceled and extra failure edges stay B8). An unsupported
// event type is signalled (ZoomUnsupportedWebhookEventError) so the consumer can
// record-and-ignore it WITHOUT forcing an illegal transition. Real Zoom is
// NOT-VERIFIED in CI — these use synthetic Zoom-shaped payloads with KNOWN ids.

function body(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseZoomWebhookEnvelope', () => {
  it('extracts event, account_id, correlation ids, occurred_at, and a stable key', () => {
    const env = parseZoomWebhookEnvelope(
      body({
        event: 'phone.callee_ringing',
        event_ts: 1_800_000_000_000,
        payload: {
          account_id: 'zoom-acct-1',
          object: { call_id: 'c-1', call_history_id: 'h-1', call_element_id: 'e-1' },
        },
      }),
    );
    expect(env).not.toBeNull();
    expect(env?.event).toBe('phone.callee_ringing');
    expect(env?.account_id).toBe('zoom-acct-1');
    expect(env?.object.call_element_id).toBe('e-1');
    expect(env?.object.call_history_uuid).toBe('h-1');
    expect(env?.object.call_id).toBe('c-1');
    expect(env?.event_ts).toBe(1_800_000_000_000);
    // A redelivery of the same event yields the SAME dedup key (idempotency).
    const again = parseZoomWebhookEnvelope(
      body({
        event: 'phone.callee_ringing',
        event_ts: 1_800_000_000_000,
        payload: { account_id: 'zoom-acct-1', object: { call_id: 'c-1', call_history_id: 'h-1', call_element_id: 'e-1' } },
      }),
    );
    expect(again?.provider_event_key).toBe(env?.provider_event_key);
  });

  it('surfaces a url_validation plainToken', () => {
    const env = parseZoomWebhookEnvelope(
      body({ event: 'endpoint.url_validation', payload: { plainToken: 'tok-123' } }),
    );
    expect(env?.event).toBe('endpoint.url_validation');
    expect(env?.plain_token).toBe('tok-123');
  });

  it('returns null for malformed JSON or a missing event', () => {
    expect(parseZoomWebhookEnvelope('not json')).toBeNull();
    expect(parseZoomWebhookEnvelope(body({ payload: {} }))).toBeNull();
  });
});

describe('ZoomPhoneAdapter.normalizeWebhook', () => {
  const adapter = new ZoomPhoneAdapter();

  it('maps the outbound spine to canonical states and carries correlation ids + occurred_at', async () => {
    const ringing = await adapter.normalizeWebhook(
      parseZoomWebhookEnvelope(
        body({ event: 'phone.callee_ringing', event_ts: 1_800_000_000_000, payload: { account_id: 'a', object: { call_element_id: 'e-1' } } }),
      ),
    );
    expect(ringing.target_status).toBe('ringing');
    expect(ringing.provider_call_element_id).toBe('e-1');
    expect(ringing.occurred_at?.getTime()).toBe(1_800_000_000_000);

    const answered = await adapter.normalizeWebhook(
      parseZoomWebhookEnvelope(body({ event: 'phone.callee_answered', payload: { object: { call_element_id: 'e-1' } } })),
    );
    expect(answered.target_status).toBe('connected');

    const ended = await adapter.normalizeWebhook(
      parseZoomWebhookEnvelope(body({ event: 'phone.call_ended', payload: { object: { call_element_id: 'e-1' } } })),
    );
    expect(ended.target_status).toBe('completed');
  });

  it('throws ZoomUnsupportedWebhookEventError for an unmapped event type', async () => {
    await expect(
      adapter.normalizeWebhook(
        parseZoomWebhookEnvelope(body({ event: 'phone.recording_completed', payload: { object: {} } })),
      ),
    ).rejects.toBeInstanceOf(ZoomUnsupportedWebhookEventError);
  });
});
