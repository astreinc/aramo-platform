import { describe, expect, it, vi } from 'vitest';

import { PipelineRepository } from '../lib/pipeline.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

function repoWith(findMany: ReturnType<typeof vi.fn>): PipelineRepository {
  return new PipelineRepository({
    pipeline: { findMany },
  } as unknown as PrismaService);
}

describe('PipelineRepository.findTalentIdsSubmittedSince (Segment 4c)', () => {
  it('maps submitted-history rows to DISTINCT talent ids via the intra-schema relation', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { pipeline: { talent_record_id: 't1' } },
      { pipeline: { talent_record_id: 't2' } },
      { pipeline: { talent_record_id: 't1' } }, // same talent, 2nd submitted pipeline → folds
    ]);
    const repo = new PipelineRepository({
      pipelineStatusHistory: { findMany },
    } as unknown as PrismaService);
    const since = new Date('2026-06-08T00:00:00.000Z');

    const out = await repo.findTalentIdsSubmittedSince({
      tenant_id: 'T',
      since,
      limit: 5000,
    });

    expect(out).toEqual(['t1', 't2']);
    const arg = findMany.mock.calls[0]![0];
    expect(arg.where).toMatchObject({
      tenant_id: 'T',
      status_to: 'submitted', // transition INTO submitted only
      changed_at: { gte: since },
    });
    expect(arg.distinct).toEqual(['pipeline_id']);
    expect(arg.take).toBe(5001); // limit+1 → over-guard detectable
  });
});

describe('PipelineRepository.findCurrentStageForTalentIds', () => {
  it('picks the most-advanced ACTIVE stage per talent; tie-break = lowest req_id', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { talent_record_id: 't1', requisition_id: 'rB', status: 'submitted' },
      { talent_record_id: 't1', requisition_id: 'rA', status: 'interviewing' }, // more advanced
      { talent_record_id: 't2', requisition_id: 'rZ', status: 'qualifying' },
      { talent_record_id: 't2', requisition_id: 'rA', status: 'qualifying' }, // tie → rA
    ]);
    const m = await repoWith(findMany).findCurrentStageForTalentIds({
      tenant_id: 't',
      talent_record_ids: ['t1', 't2', 't3'],
      visible_requisition_ids: null,
    });
    expect(m.get('t1')).toEqual({ stage: 'interviewing', requisition_id: 'rA' });
    expect(m.get('t2')).toEqual({ stage: 'qualifying', requisition_id: 'rA' });
    expect(m.has('t3')).toBe(false); // in no active pipeline → "none"
  });

  it('returns empty without querying for an empty id set', async () => {
    const findMany = vi.fn();
    const m = await repoWith(findMany).findCurrentStageForTalentIds({
      tenant_id: 't',
      talent_record_ids: [],
      visible_requisition_ids: null,
    });
    expect(m.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('constrains the query to ACTIVE stages and the visible-requisition set', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await repoWith(findMany).findCurrentStageForTalentIds({
      tenant_id: 't',
      talent_record_ids: ['t1'],
      visible_requisition_ids: new Set(['rA', 'rB']),
    });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.status.in).toContain('offered');
    expect(where.status.in).not.toContain('placed'); // terminal excluded
    expect(where.status.in).not.toContain('no_status'); // legacy excluded
    expect(where.requisition_id.in.sort()).toEqual(['rA', 'rB']);
  });
});
