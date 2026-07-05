import { describe, expect, it, vi } from 'vitest';

import { TalentReconcileProcessor } from '../lib/talent-reconcile.processor.js';

// Unit coverage for the poll drain seam + the Redis-gated bootstrap. The service
// outcomes are covered in the service spec.

function make(parts: {
  subjects?: unknown[];
  outcomes?: Array<{ outcome: string }>;
  isConfigured?: boolean;
  register?: ReturnType<typeof vi.fn>;
} = {}) {
  const findSubjectsNeedingReconcile = vi.fn().mockResolvedValue(parts.subjects ?? []);
  const trust = { findSubjectsNeedingReconcile } as never;

  const reconcileSubject = vi.fn();
  for (const o of parts.outcomes ?? []) {
    reconcileSubject.mockResolvedValueOnce({ subject_id: 's', fields_filled: 0, contradictions_recorded: 0, ...o });
  }
  const service = { reconcileSubject } as never;

  const register = parts.register ?? vi.fn();
  const registrar = { register } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? false } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  const processor = new TalentReconcileProcessor(service, trust, registrar, redisConfig, logger);
  return { processor, findSubjectsNeedingReconcile, reconcileSubject, register };
}

describe('TalentReconcileProcessor.drainBatch', () => {
  it('empty → zeroed, no service calls', async () => {
    const { processor, reconcileSubject } = make({ subjects: [] });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 0, reconciled: 0, record_gone: 0, transient_retry: 0 });
    expect(reconcileSubject).not.toHaveBeenCalled();
  });

  it('tallies each outcome', async () => {
    const { processor, findSubjectsNeedingReconcile } = make({
      subjects: [{ subject_id: 'a' }, { subject_id: 'b' }, { subject_id: 'c' }],
      outcomes: [{ outcome: 'reconciled' }, { outcome: 'record_gone' }, { outcome: 'transient_retry' }],
    });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 3, reconciled: 1, record_gone: 1, transient_retry: 1 });
    expect(findSubjectsNeedingReconcile).toHaveBeenCalledWith({ limit: 100, maxAttempts: 5 });
  });
});

describe('TalentReconcileProcessor.onApplicationBootstrap', () => {
  it('registers when Redis configured', () => {
    const { processor, register } = make({ isConfigured: true });
    processor.onApplicationBootstrap();
    expect(register).toHaveBeenCalledOnce();
  });

  it('silent when Redis unconfigured', () => {
    const { processor, register } = make({ isConfigured: false });
    processor.onApplicationBootstrap();
    expect(register).not.toHaveBeenCalled();
  });
});
