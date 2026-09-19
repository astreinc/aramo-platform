import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

import { ColdIngestExtractionProcessor } from '../lib/cold-ingest-extraction.processor.js';

// TI-1F P0.2 — cold-ingest is PARKED. The processor is INERT: a tick performs
// no extraction, reads no arrivals, writes nothing, and stamps no markers. Only
// the Redis-gated worker registration (the dormant seam) remains active.

function makeProcessor(parts: { isConfigured?: boolean; register?: ReturnType<typeof vi.fn> }) {
  const register = parts.register ?? vi.fn();
  const registrar = { register } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? false } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
  const processor = new ColdIngestExtractionProcessor(registrar, redisConfig, logger);
  return { processor, register, logger };
}

describe('ColdIngestExtractionProcessor.process — INERT (cold-ingest PARKED, TI-1F P0.2)', () => {
  it('a tick performs no extraction and logs the parked event', async () => {
    const { processor, logger } = makeProcessor({});
    await processor.process({ id: 'job-1' } as Job);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'cold_ingest_extraction_parked', job_id: 'job-1' }),
    );
  });

  it('does not throw on a tick with no job id', async () => {
    const { processor } = makeProcessor({});
    await expect(processor.process({} as Job)).resolves.toBeUndefined();
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
