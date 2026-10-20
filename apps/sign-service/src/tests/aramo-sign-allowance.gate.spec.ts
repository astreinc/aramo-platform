import { AramoError } from '@aramo/common';
import type { EsignRepository } from '@aramo/sign';
import type { AllowanceService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { AramoSignAllowanceGate } from '../app/aramo-sign-allowance.gate.js';

// Multi-Provider directive §B/§C — the Aramo Sign allowance is checked and charged
// at the native send seam (outside the envelope lifecycle), for every caller.

const STATUS = { subscribed: true, plan_key: 'p', allowance_key: 'sign.envelopes', limit: 100, used: 100, remaining: 0, period_start: new Date('2026-10-01T00:00:00Z'), period_end: new Date('2026-11-01T00:00:00Z'), threshold: 'EXHAUSTED' };

function mk(over: Partial<Record<keyof AllowanceService, unknown>> = {}, envelopeStatus = 'DRAFT') {
  const allowance = {
    resolveStale: vi.fn(async () => ({ consumed: 0, released: 0, unknown: 0 })),
    reserve: vi.fn(async () => ({ ok: true, already: false, status: STATUS })),
    consume: vi.fn(async () => 'CONSUMED'),
    release: vi.fn(async () => true),
    ...over,
  } as unknown as AllowanceService;
  let status = envelopeStatus;
  const repo = { getEnvelope: vi.fn(async () => ({ status })) } as unknown as EsignRepository;
  return { gate: new AramoSignAllowanceGate(allowance, repo), allowance, repo, setStatus: (s: string) => (status = s) };
}

describe('AramoSignAllowanceGate', () => {
  it('reserves before the send and consumes once the envelope is SENT', async () => {
    const { gate, allowance, setStatus } = mk();
    const send = vi.fn(async () => {
      setStatus('SENT');
      return 'sent';
    });
    await expect(gate.guardSend('t1', 'env-1', send)).resolves.toBe('sent');
    expect(allowance.reserve).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't1', allowance_key: 'sign.envelopes', send_key: 'aramo-sign:envelope:env-1' }));
    expect(allowance.consume).toHaveBeenCalledWith(expect.objectContaining({ send_key: 'aramo-sign:envelope:env-1', usage_event_type: 'sign.envelope.sent' }));
    expect(allowance.release).not.toHaveBeenCalled();
  });

  it('refuses at the limit with a typed reason and never calls the send', async () => {
    const { gate } = mk({ reserve: vi.fn(async () => ({ ok: false, reason: 'LIMIT_REACHED', status: STATUS })) });
    const send = vi.fn();
    const err = await gate.guardSend('t1', 'env-1', send).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect(err).toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED', statusCode: 409 });
    expect((err as AramoError).context.details).toMatchObject({ reason: 'LIMIT_REACHED', limit: 100, used: 100, period_end: '2026-11-01T00:00:00.000Z' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a tenant without a subscription as NOT_SUBSCRIBED', async () => {
    const { gate } = mk({ reserve: vi.fn(async () => ({ ok: false, reason: 'NOT_SUBSCRIBED', status: { subscribed: false } })) });
    await expect(gate.guardSend('t1', 'env-1', vi.fn())).rejects.toMatchObject({ code: 'ESIGN_NOT_SUBSCRIBED', statusCode: 403, context: { details: { reason: 'NOT_SUBSCRIBED' } } });
  });

  it('releases the reservation when the send failed and the envelope is still a draft', async () => {
    const { gate, allowance } = mk();
    await expect(gate.guardSend('t1', 'env-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(allowance.release).toHaveBeenCalled();
    expect(allowance.consume).not.toHaveBeenCalled();
  });

  it('keeps the charge when the send was accepted but a later step failed', async () => {
    const { gate, allowance, setStatus } = mk();
    await expect(gate.guardSend('t1', 'env-1', async () => { setStatus('SENT'); throw new Error('email down'); })).rejects.toThrow('email down');
    expect(allowance.consume).toHaveBeenCalled();
    expect(allowance.release).not.toHaveBeenCalled();
  });

  it('resolves overdue reservations from the envelope record before counting', async () => {
    const { gate, allowance } = mk({}, 'IN_PROGRESS');
    await gate.guardSend('t1', 'env-1', async () => 'x').catch(() => undefined);
    const call = (allowance.resolveStale as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { outcome: (k: string) => Promise<string> };
    expect(await call.outcome('aramo-sign:envelope:env-9')).toBe('ACCEPTED');
    expect(await call.outcome('something-else')).toBe('UNKNOWN');
  });
});
