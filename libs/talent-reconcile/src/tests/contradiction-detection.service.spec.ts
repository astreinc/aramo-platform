import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { ContradictionDetectionService } from '../lib/contradiction-detection.service.js';

// Unit coverage for the B2 resolve orchestration: contradict()→markResolved
// ordering, the no-incumbent invariant guard, and transient-retry (never throws).

const ROW = {
  id: 'pend-1',
  tenant_id: 'ten-1',
  talent_record_id: 'rec-1',
  field_name: 'email1',
  new_evidence_id: 'ev-new',
  incumbent_evidence_id: 'ev-incumbent',
};

function make(parts: { contradictThrows?: boolean; contradictRefuses?: 'NOT_FOUND' | 'INVALID_REQUEST' } = {}) {
  const contradict = parts.contradictRefuses
    ? vi.fn().mockRejectedValue(new AramoError(parts.contradictRefuses, 'refused', parts.contradictRefuses === 'NOT_FOUND' ? 404 : 400, { requestId: 'r' }))
    : parts.contradictThrows
      ? vi.fn().mockRejectedValue(new Error('db down'))
      : vi.fn().mockResolvedValue(undefined);
  const trust = { contradict } as never;
  const markContradictionResolved = vi.fn().mockResolvedValue(undefined);
  const reconcileRepo = { markContradictionResolved } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const service = new ContradictionDetectionService(trust, reconcileRepo, logger);
  return { service, contradict, markContradictionResolved };
}

describe('ContradictionDetectionService.resolvePending', () => {
  it('contradicted: raises contradict(incumbent, new) THEN marks resolved (order load-bearing)', async () => {
    const { service, contradict, markContradictionResolved } = make();
    const calls: string[] = [];
    contradict.mockImplementation(async () => { calls.push('contradict'); });
    markContradictionResolved.mockImplementation(async () => { calls.push('markResolved'); });

    const result = await service.resolvePending(ROW);

    expect(result.outcome).toBe('contradicted');
    // Security S1b — the acting tenant is the pending row's own tenant.
    expect(contradict).toHaveBeenCalledWith('ten-1', 'ev-incumbent', 'ev-new', expect.stringContaining("field 'email1'"));
    expect(markContradictionResolved).toHaveBeenCalledWith('pend-1');
    expect(calls).toEqual(['contradict', 'markResolved']);
  });

  it('reason is PII-free (field name + pending id only, no values)', async () => {
    const { service, contradict } = make();
    await service.resolvePending(ROW);
    const reason = contradict.mock.calls[0][3] as string;
    expect(reason).toContain('email1');
    expect(reason).toContain('pend-1');
    expect(reason).not.toContain('@'); // no email value leaked
  });

  it('no_incumbent: missing incumbent provenance → no contradict, no markResolved, left pending', async () => {
    const { service, contradict, markContradictionResolved } = make();
    const result = await service.resolvePending({ ...ROW, incumbent_evidence_id: null });
    expect(result.outcome).toBe('no_incumbent');
    expect(contradict).not.toHaveBeenCalled();
    expect(markContradictionResolved).not.toHaveBeenCalled();
  });

  it.each(['NOT_FOUND', 'INVALID_REQUEST'] as const)(
    'refused (%s): a tenant/relationship refusal → outcome refused, NOT marked resolved, logged distinctly',
    async (code) => {
      const { service, markContradictionResolved } = make({ contradictRefuses: code });
      const result = await service.resolvePending(ROW);
      expect(result.outcome).toBe('refused');
      expect(markContradictionResolved).not.toHaveBeenCalled();
    },
  );

  it('transient_retry: contradict throws → NOT marked resolved (re-polled next tick)', async () => {
    const { service, markContradictionResolved } = make({ contradictThrows: true });
    const result = await service.resolvePending(ROW);
    expect(result.outcome).toBe('transient_retry');
    expect(markContradictionResolved).not.toHaveBeenCalled();
  });

  it('never throws — a failure resolves to a counted outcome', async () => {
    const { service } = make({ contradictThrows: true });
    await expect(service.resolvePending(ROW)).resolves.toMatchObject({ outcome: 'transient_retry' });
  });
});
