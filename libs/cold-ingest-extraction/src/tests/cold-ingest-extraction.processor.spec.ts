import { describe, expect, it, vi } from 'vitest';

import { ColdIngestExtractionProcessor } from '../lib/cold-ingest-extraction.processor.js';

// Unit coverage for the poll processor's drain seam: batch fetch → per-arrival
// service call → outcome tally, and the Redis-gated bootstrap registration.
// The service is stubbed (its own outcomes are covered in the service spec).

function makeProcessor(parts: {
  arrivals?: unknown[];
  extractResults?: Array<{ outcome: string }>;
  isConfigured?: boolean;
  register?: ReturnType<typeof vi.fn>;
}) {
  const findArrivalsNeedingExtraction = vi.fn().mockResolvedValue(parts.arrivals ?? []);
  const extractArrival = vi.fn();
  for (const r of parts.extractResults ?? []) {
    extractArrival.mockResolvedValueOnce({ payload_id: 'p', entry_count: 0, ...r });
  }
  const service = { extractArrival } as never;
  const ingestionRepo = { findArrivalsNeedingExtraction } as never;
  const register = parts.register ?? vi.fn();
  const registrar = { register } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? false } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

  const processor = new ColdIngestExtractionProcessor(
    service,
    ingestionRepo,
    registrar,
    redisConfig,
    logger,
  );
  return { processor, findArrivalsNeedingExtraction, extractArrival, register };
}

describe('ColdIngestExtractionProcessor.drainBatch', () => {
  it('empty batch → zeroed result, no service calls', async () => {
    const { processor, extractArrival } = makeProcessor({ arrivals: [] });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 0, extracted: 0, done_no_identity: 0, transient_retry: 0 });
    expect(extractArrival).not.toHaveBeenCalled();
  });

  it('tallies each per-arrival outcome (extracted / done_no_identity / transient_retry)', async () => {
    const { processor, findArrivalsNeedingExtraction } = makeProcessor({
      arrivals: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      extractResults: [
        { outcome: 'extracted' },
        { outcome: 'done_no_identity' },
        { outcome: 'transient_retry' },
      ],
    });
    const result = await processor.drainBatch({ batchSize: 100, jobId: 'j1' });
    expect(result).toEqual({ attempted: 3, extracted: 1, done_no_identity: 1, transient_retry: 1 });
    expect(findArrivalsNeedingExtraction).toHaveBeenCalledWith({ limit: 100, maxAttempts: 5 });
  });
});

describe('ColdIngestExtractionProcessor.onApplicationBootstrap', () => {
  it('registers the worker when Redis is configured', () => {
    const { processor, register } = makeProcessor({ isConfigured: true });
    processor.onApplicationBootstrap();
    expect(register).toHaveBeenCalledOnce();
  });

  it('stays silent (no registration) when Redis is unconfigured', () => {
    const { processor, register } = makeProcessor({ isConfigured: false });
    processor.onApplicationBootstrap();
    expect(register).not.toHaveBeenCalled();
  });
});
