import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// Phase 3 — per-company metrics composition (company → req → pipeline). The
// service folds visible reqs (in the requested companies) into open-reqs /
// openings / filled, then folds pipeline counts grouped by requisition up to the
// company. Emits a row for EVERY requested company (zeros when none visible).

const TENANT = 't-1';

function makeService(opts: {
  reqs: ReadonlyArray<Record<string, unknown>>;
  placed: ReadonlyArray<{ requisition_id: string; count: number }>;
  submitted: ReadonlyArray<{ requisition_id: string; count: number }>;
  placedRows?: ReadonlyArray<Record<string, unknown>>;
}) {
  const requisitionRepository = {
    listForActor: vi.fn().mockResolvedValue(opts.reqs),
  };
  const pipelineRepository = {
    countByRequisition: vi.fn(async (args: { statuses: readonly string[] }) =>
      args.statuses.includes('placed') ? opts.placed : opts.submitted,
    ),
    listByRequisitionsAndStatus: vi.fn(async () => opts.placedRows ?? []),
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
    pipelineRepository as never,
  );
  return { svc, requisitionRepository, pipelineRepository };
}

const actor = {
  tenant_id: TENANT,
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

describe('ReportingService.getCompanyMetrics', () => {
  it('folds reqs + pipeline counts per company; only requested companies', async () => {
    const { svc } = makeService({
      reqs: [
        { id: 'r-a1', company_id: 'co-A', status: 'active', openings: 3, openings_available: 1 },
        { id: 'r-a2', company_id: 'co-A', status: 'closed', openings: 2, openings_available: 2 },
        { id: 'r-b1', company_id: 'co-B', status: 'on_hold', openings: 1, openings_available: 1 },
        { id: 'r-z1', company_id: 'co-Z', status: 'active', openings: 9, openings_available: 0 },
      ],
      placed: [{ requisition_id: 'r-a1', count: 1 }],
      submitted: [
        { requisition_id: 'r-a1', count: 2 },
        { requisition_id: 'r-b1', count: 1 },
      ],
    });

    const res = await svc.getCompanyMetrics(actor, ['co-A', 'co-B', 'co-missing']);
    const byId = Object.fromEntries(res.map((m) => [m.company_id, m]));

    // co-A: one OPEN req (active; closed excluded); openings 3+2=5; filled (3-1)+(2-2)=2
    expect(byId['co-A']).toMatchObject({
      open_reqs: 1,
      openings: 5,
      filled: 2,
      active_placements: 1,
      submitted: 2,
      fill_rate: 40, // round(2/5*100)
    });
    // co-B: on_hold counts as open; no placements; one submitted; 0 filled → 0%
    expect(byId['co-B']).toMatchObject({
      open_reqs: 1,
      openings: 1,
      filled: 0,
      active_placements: 0,
      submitted: 1,
      fill_rate: 0,
    });
    // requested-but-unseen company → all zeros, fill_rate null (no openings)
    expect(byId['co-missing']).toMatchObject({
      open_reqs: 0,
      active_placements: 0,
      submitted: 0,
      openings: 0,
      fill_rate: null,
    });
    // co-Z was NOT requested → absent from the result
    expect(byId['co-Z']).toBeUndefined();
  });

  it('empty company id list short-circuits to []', async () => {
    const { svc, requisitionRepository } = makeService({
      reqs: [],
      placed: [],
      submitted: [],
    });
    const res = await svc.getCompanyMetrics(actor, []);
    expect(res).toEqual([]);
    expect(requisitionRepository.listForActor).not.toHaveBeenCalled();
  });
});

describe('ReportingService.getCompanyPlacements', () => {
  it('lists placed pipelines at the company reqs with the req title joined', async () => {
    const { svc } = makeService({
      reqs: [
        { id: 'r-a1', company_id: 'co-A', status: 'active', title: 'Rust Eng', openings: 1, openings_available: 0 },
        { id: 'r-z1', company_id: 'co-Z', status: 'active', title: 'Other', openings: 1, openings_available: 1 },
      ],
      placed: [],
      submitted: [],
      placedRows: [
        { id: 'pl-1', talent_record_id: 'tr-1', requisition_id: 'r-a1', status: 'placed' },
      ],
    });
    const res = await svc.getCompanyPlacements(actor, 'co-A');
    expect(res).toEqual([
      {
        pipeline_id: 'pl-1',
        talent_record_id: 'tr-1',
        requisition_id: 'r-a1',
        requisition_title: 'Rust Eng',
      },
    ]);
  });

  it('returns [] when the company has no visible reqs', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r-z1', company_id: 'co-Z', status: 'active', title: 'X', openings: 1, openings_available: 1 }],
      placed: [],
      submitted: [],
      placedRows: [],
    });
    expect(await svc.getCompanyPlacements(actor, 'co-A')).toEqual([]);
  });
});
