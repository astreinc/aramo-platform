import { describe, expect, it, vi } from 'vitest';

import { SourcingService } from '../talent-identity/sourcing.service.js';

// Unit coverage for the two sourcer triggers: promote-then-associate, gate-
// deferral short-circuit, and idempotency (pipeline P2002 no-op; already-promoted
// still associates).

const TENANT = '11111111-1111-7111-8111-111111111111';
const REF = { tenant_id: TENANT, ref_type: 'SOURCED_TALENT' as const, ref_id: 'payload-1' };
const REQ_ID = 'req-1';
const RECORD_ID = 'rec-1';

function make(parts: {
  promoteOutcome?: unknown;
  pipelineThrows?: 'P2002' | 'other';
} = {}) {
  const promoteSubject = vi
    .fn()
    .mockResolvedValue(parts.promoteOutcome ?? { status: 'promoted', talent_record_id: RECORD_ID });
  const promotion = { promoteSubject } as never;

  const create = parts.pipelineThrows
    ? vi.fn().mockRejectedValue(parts.pipelineThrows === 'P2002' ? { code: 'P2002' } : new Error('boom'))
    : vi.fn().mockResolvedValue({ id: 'pipe-1' });
  const pipelines = { create } as never;

  const getOrCreateTenantBench = vi.fn().mockResolvedValue({ id: 'bench-1' });
  const addToTenantBench = vi.fn().mockResolvedValue({ added: true });
  const savedLists = { getOrCreateTenantBench, addToTenantBench } as never;

  const service = new SourcingService(promotion, pipelines, savedLists);
  return { service, promoteSubject, create, getOrCreateTenantBench, addToTenantBench };
}

describe('SourcingService.promoteAndAddToPipeline', () => {
  it('promoted → creates the pipeline row', async () => {
    const { service, create } = make();
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: 'pipe-1' });
    expect(create).toHaveBeenCalledWith({
      tenant_id: TENANT,
      input: { talent_record_id: RECORD_ID, requisition_id: REQ_ID },
    });
  });

  it('gate deferral (deferred_unresolved_identity) → short-circuit, NO pipeline write', async () => {
    const { service, create } = make({ promoteOutcome: { status: 'deferred_unresolved_identity' } });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'deferred_unresolved_identity' });
    expect(create).not.toHaveBeenCalled();
  });

  it('already-promoted → still associates the existing record to the pipeline', async () => {
    const { service, create } = make({ promoteOutcome: { status: 'already_promoted', talent_record_id: RECORD_ID } });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result.status).toBe('already_promoted');
    expect(create).toHaveBeenCalled();
  });

  it('duplicate pipeline (P2002) → idempotent no-op (no throw, pipeline_id null)', async () => {
    const { service } = make({ pipelineThrows: 'P2002' });
    const result = await service.promoteAndAddToPipeline(REF, REQ_ID);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, pipeline_id: null });
  });

  it('a non-unique pipeline error propagates', async () => {
    const { service } = make({ pipelineThrows: 'other' });
    await expect(service.promoteAndAddToPipeline(REF, REQ_ID)).rejects.toThrow('boom');
  });
});

describe('SourcingService.promoteAndSaveToBench', () => {
  it('promoted → get-or-create the tenant bench + add the record', async () => {
    const { service, getOrCreateTenantBench, addToTenantBench } = make();
    const result = await service.promoteAndSaveToBench(REF);
    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, bench_id: 'bench-1' });
    expect(getOrCreateTenantBench).toHaveBeenCalledWith(TENANT);
    expect(addToTenantBench).toHaveBeenCalledWith({
      tenant_id: TENANT,
      bench_id: 'bench-1',
      talent_record_id: RECORD_ID,
    });
  });

  it('gate deferral → short-circuit, NO bench write', async () => {
    const { service, getOrCreateTenantBench, addToTenantBench } = make({
      promoteOutcome: { status: 'deferred_no_name' },
    });
    const result = await service.promoteAndSaveToBench(REF);
    expect(result).toEqual({ status: 'deferred_no_name' });
    expect(getOrCreateTenantBench).not.toHaveBeenCalled();
    expect(addToTenantBench).not.toHaveBeenCalled();
  });
});
