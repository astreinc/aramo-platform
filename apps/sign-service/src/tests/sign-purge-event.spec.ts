import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGN_ENVELOPE_PURGE_EVENT_TYPE, toLifecycleEvent, type EsignLifecycleEvent } from '@aramo/sign';

import { SIGN_WEBHOOK_EVENT_TYPES } from '../app/integrations/integration-admin.service.js';
import { ARTIFACT_EVENT_TYPES } from '../app/integrations/sign-token.service.js';
import { HttpWebhookEventPublisher } from '../app/webhook-event-publisher.js';

// Retention and Purge directive (ebd41d99) R-14 / LD-6 / LD-8 — sign.envelope.purge.v1:
// subscribable, carries the DocuSign-parity purge fields end to end (outbox row → wire
// event → subscription delivery row and the legacy ATS webhook body), and never grants
// executed-artifact access.

const PURGE = { purge_state: 'documents_queued', purge_due_at: '2026-11-14T00:00:00.000Z', reason: 'retention' } as const;

const ROW = {
  id: 'outbox-purge-1',
  tenant_id: 't1',
  event_type: SIGN_ENVELOPE_PURGE_EVENT_TYPE,
  created_at: new Date('2026-10-31T00:00:00.000Z'),
  event_payload: { envelope_id: 'env-1', correlation_id: 'corr-1', artifact_refs: { executed_document_ids: [], has_certificate: false }, purge: PURGE },
};

describe('sign.envelope.purge.v1', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
    delete process.env['SIGN_WEBHOOK_TARGET_URL'];
  });

  it('is in the subscribable vocabulary under the DocuSign-parity name', () => {
    expect(SIGN_ENVELOPE_PURGE_EVENT_TYPE).toBe('sign.envelope.purge.v1');
    expect(SIGN_WEBHOOK_EVENT_TYPES).toContain('sign.envelope.purge.v1');
  });

  it('never grants executed-artifact access (event grant)', () => {
    expect(ARTIFACT_EVENT_TYPES.has('sign.envelope.purge.v1')).toBe(false);
    expect(ARTIFACT_EVENT_TYPES.has('sign.envelope.executed.v1')).toBe(true);
  });

  it('the wire event carries the purge fields; other events carry none', () => {
    const ev = toLifecycleEvent(ROW);
    expect(ev.event_type).toBe('sign.envelope.purge.v1');
    expect(ev.purge).toEqual(PURGE);
    const executed = toLifecycleEvent({ ...ROW, event_type: 'sign.envelope.executed.v1', event_payload: { envelope_id: 'env-1', correlation_id: 'c', artifact_refs: { executed_document_ids: ['d'], has_certificate: true } } });
    expect('purge' in executed).toBe(false);
  });

  it('a subscription filtered on the purge event receives it, with the purge fields in the delivery payload', async () => {
    const repo = {
      subscriptionsForEnvelope: vi.fn(async () => ({ envelope: { source_application: 'acme-hr', installation_id: 'i' }, subscriptions: [
        { id: 's-purge', event_types: ['sign.envelope.purge.v1'] },
        { id: 's-exec', event_types: ['sign.envelope.executed.v1'] },
      ] })),
      enqueue: vi.fn(async () => undefined),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ev: EsignLifecycleEvent = toLifecycleEvent(ROW);
    expect(await new HttpWebhookEventPublisher(repo as never).deliver(ev)).toEqual({ ok: true });
    const rows = (repo.enqueue.mock.calls[0] as unknown as [{ subscription_id: string; event_type: string; payload: EsignLifecycleEvent }[]])[0];
    expect(rows.map((r) => r.subscription_id)).toEqual(['s-purge']);
    expect(rows[0]!.event_type).toBe('sign.envelope.purge.v1');
    expect(rows[0]!.payload.purge).toEqual(PURGE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the legacy ATS webhook body carries the purge fields (signed exact body)', async () => {
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'legacy';
    process.env['SIGN_WEBHOOK_TARGET_URL'] = 'http://core.local/v1/integrations/sign/events';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    const repo = { subscriptionsForEnvelope: vi.fn(async () => ({ envelope: { source_application: 'aramo-ats', installation_id: null }, subscriptions: [] })), enqueue: vi.fn() };
    expect(await new HttpWebhookEventPublisher(repo as never).deliver(toLifecycleEvent({ ...ROW, event_payload: { ...ROW.event_payload, purge: { purge_state: 'executed', purge_due_at: null, reason: 'retention' } } }))).toEqual({ ok: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.event_type).toBe('sign.envelope.purge.v1');
    expect(body.purge).toEqual({ purge_state: 'executed', purge_due_at: null, reason: 'retention' });
    vi.unstubAllGlobals();
  });
});
