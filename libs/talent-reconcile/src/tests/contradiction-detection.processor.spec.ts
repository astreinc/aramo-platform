import { describe, expect, it, vi } from 'vitest';

import { ContradictionDetectionProcessor } from '../lib/contradiction-detection.processor.js';

// Unit coverage for the B2 poll drain seam + the Redis-gated bootstrap. Service
// outcomes are covered in the service spec.

function make(parts: {
  pending?: unknown[];
  outcomes?: Array<{ outcome: string }>;
  isConfigured?: boolean;
  register?: ReturnType<typeof vi.fn>;
} = {}) {
  const findPendingContradictions = vi.fn().mockResolvedValue(parts.pending ?? []);
  const reconcileRepo = { findPendingContradictions } as never;

  const resolvePending = vi.fn();
  for (const o of parts.outcomes ?? []) {
    resolvePending.mockResolvedValueOnce({ pending_id: 'p', ...o });
  }
  const service = { resolvePending } as never;

  const register = parts.register ?? vi.fn();
  const registrar = { register } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? false } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  const processor = new ContradictionDetectionProcessor(service, reconcileRepo, registrar, redisConfig, logger);
  return { processor, findPendingContradictions, resolvePending, register };
}

describe('ContradictionDetectionProcessor.drainBatch', () => {
  it('empty → zeroed, no service calls', async () => {
    const { processor, resolvePending } = make({ pending: [] });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 0, contradicted: 0, no_incumbent: 0, transient_retry: 0 });
    expect(resolvePending).not.toHaveBeenCalled();
  });

  it('tallies each outcome', async () => {
    const { processor, findPendingContradictions } = make({
      pending: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      outcomes: [{ outcome: 'contradicted' }, { outcome: 'no_incumbent' }, { outcome: 'transient_retry' }],
    });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 3, contradicted: 1, no_incumbent: 1, transient_retry: 1 });
    expect(findPendingContradictions).toHaveBeenCalledWith({ limit: 100 });
  });
});

describe('ContradictionDetectionProcessor.onApplicationBootstrap', () => {
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
