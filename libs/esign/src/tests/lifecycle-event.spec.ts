import { describe, expect, it } from 'vitest';

import { ESIGN_LIFECYCLE_EVENT_VERSION, toLifecycleEvent } from '../lib/ports/lifecycle-event.js';

describe('toLifecycleEvent (generic E-Sign lifecycle event)', () => {
  const createdAt = new Date('2026-09-27T12:00:00.000Z');

  it('derives event_id from the durable outbox row id (stable across retries)', () => {
    const ev = toLifecycleEvent({
      id: 'outbox-row-1',
      tenant_id: 't1',
      event_type: 'esign.envelope.executed.v1',
      created_at: createdAt,
      event_payload: { envelope_id: 'env-1', correlation_id: 'corr-1', artifact_refs: { executed_document_ids: ['d1'], has_certificate: true } },
    });
    expect(ev.event_id).toBe('outbox-row-1');
    expect(ev.event_version).toBe(ESIGN_LIFECYCLE_EVENT_VERSION);
    expect(ev.occurred_at).toBe('2026-09-27T12:00:00.000Z');
    expect(ev.tenant_id).toBe('t1');
    expect(ev.envelope_id).toBe('env-1');
    expect(ev.correlation_id).toBe('corr-1');
    expect(ev.artifact_refs).toEqual({ executed_document_ids: ['d1'], has_certificate: true });
  });

  it('carries only generic signing vocabulary (no RTR/Offer/Submittal semantics)', () => {
    const ev = toLifecycleEvent({
      id: 'r', tenant_id: 't', event_type: 'esign.envelope.executed.v1', created_at: createdAt,
      event_payload: { envelope_id: 'e', correlation_id: 'c', artifact_refs: { executed_document_ids: [], has_certificate: false } },
    });
    const serialized = JSON.stringify(ev).toLowerCase();
    for (const forbidden of ['rtr', 'offer', 'submittal', 'placement', 'ready_to_submit']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('defaults defensively when the payload is missing fields', () => {
    const ev = toLifecycleEvent({ id: 'r', tenant_id: 't', event_type: 'x.v1', created_at: createdAt, event_payload: null });
    expect(ev.envelope_id).toBe('');
    expect(ev.artifact_refs).toEqual({ executed_document_ids: [], has_certificate: false });
  });
});
