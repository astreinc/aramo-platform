import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { DocumentsRepository } from '@aramo/documents';

import { EsignExecutedArtifactsClient } from '../documents/esign-writeback.js';
import { EsignEnvelopePurgedError, EsignPurgeRecorder, isPurgeEvent, purgeFieldsOf } from '../documents/esign-purge.js';
import { EsignEventsController } from '../integrations/sign/esign-events.controller.js';
import { computeEsignWebhookSignature } from '../integrations/sign/esign-webhook-signature.js';

// Aramo Sign Retention and Purge directive (ebd41d99) W11 — the ATS consumer of
// sign.envelope.purge.v1 and of a 410 ENVELOPE_PURGED executed-artifact pull. A purge
// concerns Sign's copy only: it is recorded on the routed Document (idempotent per event),
// the ATS's own stored copy is never touched, and a purged pull is terminal (no retry storm).

const SECRET = 'legacy-shared';

function harness(body: object, opts: { recorder?: Partial<EsignPurgeRecorder>; orchestrator?: object } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-aramo-sign-timestamp': ts, 'x-aramo-sign-signature': computeEsignWebhookSignature(ts, raw, SECRET) };
  const orchestrator = opts.orchestrator ?? { writeBackEnvelope: vi.fn(async () => ({ envelope_id: 'E1', documents_written: 1 })) };
  const signingEnded = { record: vi.fn() };
  const recorder = { record: vi.fn(async () => 'recorded' as const), ...opts.recorder };
  const ctl = new EsignEventsController(orchestrator as never, signingEnded as never, recorder as never);
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; } };
  return { run: () => ctl.events({ body: raw, headers } as never, res as never, 'req-1'), res, recorder, orchestrator, signingEnded };
}

const PURGE_EVENT = {
  event_id: 'ev-purge-1',
  event_type: 'sign.envelope.purge.v1',
  tenant_id: 't1',
  envelope_id: 'E1',
  correlation_id: '11111111-1111-4111-8111-111111111111',
  artifact_refs: { executed_document_ids: [], has_certificate: false },
  purge: { purge_state: 'executed', purge_due_at: null, reason: 'retention' },
};

let keep: string | undefined;
beforeEach(() => {
  keep = process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
  process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = SECRET;
});
afterEach(() => {
  if (keep === undefined) delete process.env['SIGN_WEBHOOK_SIGNING_SECRET'];
  else process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = keep;
});

describe('purge event parsing', () => {
  it('recognizes the purge event prefix-agnostically and validates the DocuSign-parity states', () => {
    expect(isPurgeEvent('sign.envelope.purge.v1')).toBe(true);
    expect(isPurgeEvent('esign.envelope.purge.v1')).toBe(true);
    expect(isPurgeEvent('sign.envelope.executed.v1')).toBe(false);
    for (const s of ['documents_queued', 'documents_and_metadata_queued', 'documents_and_metadata_and_redact_queued', 'documents_dequeued', 'executed']) {
      expect(purgeFieldsOf({ purge: { purge_state: s, reason: 'manual' } })).toEqual({ purge_state: s, reason: 'manual', purge_due_at: null });
    expect(purgeFieldsOf({ purge: { purge_state: 'documents_queued', reason: 'retention', purge_due_at: '2026-11-14T00:00:00.000Z' } })?.purge_due_at).toBe('2026-11-14T00:00:00.000Z');
    }
    expect(purgeFieldsOf({})).toBeNull();
    expect(purgeFieldsOf({ purge: { purge_state: 'deleted' } })).toBeNull();
  });
});

describe('EsignEventsController — sign.envelope.purge.v1', () => {
  it('records the executed purge on the routed document keyed by event_id, 200, never touching the write-back', async () => {
    const h = harness(PURGE_EVENT);
    expect(await h.run()).toEqual({ received: true, event_id: 'ev-purge-1' });
    expect(h.res.statusCode).toBe(200);
    expect(h.recorder.record).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't1', envelope_id: 'E1', fact_key: 'ev-purge-1', purge_state: 'executed', reason: 'retention' }));
    expect((h.orchestrator as { writeBackEnvelope: ReturnType<typeof vi.fn> }).writeBackEnvelope).not.toHaveBeenCalled();
    expect(h.signingEnded.record).not.toHaveBeenCalled();
  });

  it('acknowledges queued and dequeued states the same way, with their state', async () => {
    for (const purge_state of ['documents_queued', 'documents_dequeued']) {
      const h = harness({ ...PURGE_EVENT, purge: { purge_state, purge_due_at: '2026-11-14T00:00:00.000Z', reason: 'manual' } });
      await h.run();
      expect(h.res.statusCode).toBe(200);
      expect(h.recorder.record).toHaveBeenCalledWith(expect.objectContaining({ purge_state, reason: 'manual' }));
    }
  });

  it('a redelivered event is a 200 no-op (recorder reports duplicate)', async () => {
    const h = harness(PURGE_EVENT, { recorder: { record: vi.fn(async () => 'duplicate' as const) } });
    expect(await h.run()).toEqual({ received: true, event_id: 'ev-purge-1' });
    expect(h.res.statusCode).toBe(200);
  });

  it('an envelope not routed in this tenant is acknowledged and ignored', async () => {
    const h = harness(PURGE_EVENT, { recorder: { record: vi.fn(async () => 'unrouted' as const) } });
    expect(await h.run()).toEqual({ received: true, event_id: 'ev-purge-1', ignored: true });
  });

  it('a purge event without valid purge fields is 400; a transient recorder failure is 502 (Sign redelivers)', async () => {
    const bad = harness({ ...PURGE_EVENT, purge: { purge_state: 'gone' } });
    await bad.run();
    expect(bad.res.statusCode).toBe(400);
    const flaky = harness(PURGE_EVENT, { recorder: { record: vi.fn(async () => { throw new Error('db'); }) } });
    await flaky.run();
    expect(flaky.res.statusCode).toBe(502);
  });
});

describe('executed-artifact pull answered 410 ENVELOPE_PURGED', () => {
  it('the client raises the terminal EsignEnvelopePurgedError; other errors pass through', async () => {
    const purged = new AramoError('ENVELOPE_PURGED', 'purged', 410, { requestId: '' });
    const sign = { eventGrant: vi.fn(async () => ({ token: 'g' })), call: vi.fn(async () => { throw purged; }) };
    const client = new EsignExecutedArtifactsClient(sign as never);
    await expect(client.fetchExecuted('t1', 'E1', 'ev-1')).rejects.toBeInstanceOf(EsignEnvelopePurgedError);
    const other = new AramoError('INTERNAL_ERROR', 'boom', 500, { requestId: '' });
    sign.call.mockImplementationOnce(async () => { throw other; });
    await expect(client.fetchExecuted('t1', 'E1', 'ev-1')).rejects.toBe(other);
  });

  it('a completion event whose pull is purged is recorded and acknowledged 200 (no retry storm)', async () => {
    const orchestrator = { writeBackEnvelope: vi.fn(async () => { throw new EsignEnvelopePurgedError('E1'); }) };
    const h = harness({ event_id: 'ev-exec-1', event_type: 'sign.envelope.executed.v1', tenant_id: 't1', envelope_id: 'E1' }, { orchestrator });
    expect(await h.run()).toEqual({ received: true, event_id: 'ev-exec-1', ignored: true });
    expect(h.res.statusCode).toBe(200);
    expect(h.recorder.record).toHaveBeenCalledWith(expect.objectContaining({ fact_key: 'executed-pull-410:ev-exec-1', purge_state: 'executed', reason: null }));
  });

  it('if recording the 410 fact fails, the event is NOT acknowledged (502)', async () => {
    const orchestrator = { writeBackEnvelope: vi.fn(async () => { throw new EsignEnvelopePurgedError('E1'); }) };
    const h = harness({ event_id: 'ev-exec-2', event_type: 'sign.envelope.executed.v1', tenant_id: 't1', envelope_id: 'E1' }, { orchestrator, recorder: { record: vi.fn(async () => { throw new Error('db'); }) } });
    await h.run();
    expect(h.res.statusCode).toBe(502);
  });
});

describe('EsignPurgeRecorder', () => {
  const route = (tenant_id: string) => ({ findRouteByEnvelope: vi.fn(async () => ({ tenant_id, document_id: 'doc-1' })) });

  it('records on the routed document; reports duplicates; ignores unrouted and cross-tenant envelopes', async () => {
    const documents = { recordEsignCopyPurgeFact: vi.fn(async () => ({ recorded: true })) };
    const input = { tenant_id: 't1', envelope_id: 'E1', fact_key: 'ev-1', purge_state: 'executed', reason: 'retention', requestId: 'r' };
    expect(await new EsignPurgeRecorder(documents as never, route('t1') as never).record(input)).toBe('recorded');
    expect(documents.recordEsignCopyPurgeFact).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't1', document_id: 'doc-1', fact_key: 'ev-1', envelope_id: 'E1', purge_state: 'executed', reason: 'retention' }));
    documents.recordEsignCopyPurgeFact.mockResolvedValueOnce({ recorded: false });
    expect(await new EsignPurgeRecorder(documents as never, route('t1') as never).record(input)).toBe('duplicate');
    expect(await new EsignPurgeRecorder(documents as never, route('other') as never).record(input)).toBe('unrouted');
    expect(await new EsignPurgeRecorder(documents as never, { findRouteByEnvelope: vi.fn(async () => null) } as never).record(input)).toBe('unrouted');
    expect(documents.recordEsignCopyPurgeFact).toHaveBeenCalledTimes(2);
  });
});

describe('DocumentsRepository.recordEsignCopyPurgeFact', () => {
  function repoWith(seen: boolean) {
    const tx = {
      document: { findFirst: vi.fn(async () => ({ id: 'doc-1' })), updateMany: vi.fn() },
      documentEvent: { findFirst: vi.fn(async () => (seen ? { id: 'e0' } : null)), create: vi.fn(async () => ({})) },
      documentArtifact: { update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { repo: new DocumentsRepository(prisma as never, {} as never), tx };
  }
  const input = { tenant_id: 't1', document_id: 'doc-1', fact_key: 'ev-1', envelope_id: 'E1', purge_state: 'executed', reason: 'retention', actor_id: 't1' };

  it('appends exactly one ESIGN_SOURCE_COPY_PURGED event and never changes the document or its artifacts', async () => {
    const { repo, tx } = repoWith(false);
    expect(await repo.recordEsignCopyPurgeFact(input)).toEqual({ recorded: true });
    expect(tx.documentEvent.create).toHaveBeenCalledTimes(1);
    const data = (tx.documentEvent.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ tenant_id: 't1', document_id: 'doc-1', event_type: 'ESIGN_SOURCE_COPY_PURGED', actor_type: 'SYSTEM', payload: { fact_key: 'ev-1', envelope_id: 'E1', purge_state: 'executed', reason: 'retention' } });
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    for (const fn of Object.values(tx.documentArtifact)) expect(fn).not.toHaveBeenCalled();
  });

  it('a non-executed state is recorded as ESIGN_SOURCE_COPY_PURGE_STATE; a seen fact key records nothing', async () => {
    const a = repoWith(false);
    await a.repo.recordEsignCopyPurgeFact({ ...input, purge_state: 'documents_queued' });
    expect((a.tx.documentEvent.create.mock.calls[0] as unknown as [{ data: { event_type: string } }])[0].data.event_type).toBe('ESIGN_SOURCE_COPY_PURGE_STATE');
    const b = repoWith(true);
    expect(await b.repo.recordEsignCopyPurgeFact(input)).toEqual({ recorded: false });
    expect(b.tx.documentEvent.create).not.toHaveBeenCalled();
  });
});
