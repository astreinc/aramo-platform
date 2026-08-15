import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B3 — assignment-pipeline fold (directive §3/§6/§8/§10). The placement
// snapshot read is MOCKED; this spec proves the pure fold: five live states
// zero-filled in fixed lifecycle order; total_live = exact sum of the five
// (contract_assignments NEVER contributes); the UTC + forward_materialized
// coverage labels; and the A3 visible-requisition pass-through.

const TENANT = 't-1';

type Snapshot = {
  by_state: Array<{ state: string; count: number }>;
  start_date: {
    overdue: number;
    today: number;
    next_7_days: number;
    later: number;
    unspecified: number;
  };
  contract_assignments: { active: number; ended: number };
};

function makeService(snapshot: Snapshot, visibleReqs?: ReadonlyArray<{ id: string }>) {
  const placementPipelineRepository = {
    readAssignmentPipelineSnapshot: vi.fn().mockResolvedValue(snapshot),
  };
  const requisitionRepository = {
    listForActor: vi.fn().mockResolvedValue(visibleReqs ?? []),
  };
  const stub = {} as never;
  const svc = new ReportingService(
    stub, // company
    stub, // contact
    stub, // talentRecord
    stub, // savedList
    stub, // calendar
    stub, // activity
    requisitionRepository as never,
    stub, // pipeline
    stub, // tenantSetting
    stub, // capacity
    stub, // placementEventRepository
    placementPipelineRepository as never,
  );
  return { svc, placementPipelineRepository, requisitionRepository };
}

const seeAll = {
  tenant_id: TENANT,
  user_id: 'u',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

const EMPTY_BUCKETS = { overdue: 0, today: 0, next_7_days: 0, later: 0, unspecified: 0 };

describe('ReportingService.getAssignmentPipeline', () => {
  it('zero-fills the five live states in fixed lifecycle order; total_live = their sum', async () => {
    const { svc } = makeService({
      by_state: [
        { state: 'STARTED', count: 3 },
        { state: 'PRE_START', count: 2 },
        { state: 'OFFER_ACCEPTED', count: 1 },
        // BLOCKED + READY_TO_START absent → zero-filled
      ],
      start_date: EMPTY_BUCKETS,
      contract_assignments: { active: 0, ended: 0 },
    });
    const v = await svc.getAssignmentPipeline(seeAll);
    expect(v.by_state).toEqual([
      { state: 'OFFER_ACCEPTED', count: 1 },
      { state: 'PRE_START', count: 2 },
      { state: 'BLOCKED', count: 0 },
      { state: 'READY_TO_START', count: 0 },
      { state: 'STARTED', count: 3 },
    ]);
    expect(v.total_live).toBe(6); // 1+2+0+0+3
  });

  it('total_live NEVER includes contract_assignments (§10)', async () => {
    const v = await makeService({
      by_state: [{ state: 'STARTED', count: 4 }],
      start_date: EMPTY_BUCKETS,
      contract_assignments: { active: 5, ended: 2 },
    }).svc.getAssignmentPipeline(seeAll);
    expect(v.total_live).toBe(4); // NOT 4+7
    expect(v.contract_assignments).toEqual({
      active: 5,
      ended: 2,
      coverage: 'forward_materialized',
    });
  });

  it('stamps UTC + forward_materialized labels and passes start-date buckets through', async () => {
    const v = await makeService({
      by_state: [],
      start_date: { overdue: 1, today: 2, next_7_days: 3, later: 4, unspecified: 5 },
      contract_assignments: { active: 0, ended: 0 },
    }).svc.getAssignmentPipeline(seeAll);
    expect(v.start_date).toEqual({
      overdue: 1,
      today: 2,
      next_7_days: 3,
      later: 4,
      unspecified: 5,
      timezone_basis: 'UTC',
    });
    expect(v.contract_assignments.coverage).toBe('forward_materialized');
    // empty snapshot → all five states zero, total_live 0
    expect(v.total_live).toBe(0);
    expect(v.by_state).toHaveLength(5);
  });

  it('see-all actor → no requisition filter; recruiter → passes A3 visible ids', async () => {
    const { svc: svcAll, placementPipelineRepository: repoAll } = makeService({
      by_state: [],
      start_date: EMPTY_BUCKETS,
      contract_assignments: { active: 0, ended: 0 },
    });
    await svcAll.getAssignmentPipeline(seeAll);
    const argAll = repoAll.readAssignmentPipelineSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(argAll['tenant_id']).toBe(TENANT);
    expect('requisition_ids' in argAll).toBe(false);

    const recruiter = {
      tenant_id: TENANT,
      user_id: 'u2',
      scopes: ['report:read'],
      visibility: { see_all_requisition: false } as unknown as VisibilityContextShape,
    };
    const { svc: svcRec, placementPipelineRepository: repoRec } = makeService(
      { by_state: [], start_date: EMPTY_BUCKETS, contract_assignments: { active: 0, ended: 0 } },
      [{ id: 'r-1' }, { id: 'r-2' }],
    );
    await svcRec.getAssignmentPipeline(recruiter);
    expect(repoRec.readAssignmentPipelineSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_ids: ['r-1', 'r-2'] }),
    );
  });
});
