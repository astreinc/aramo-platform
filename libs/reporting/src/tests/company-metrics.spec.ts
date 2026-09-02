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
  // Legacy-Pipeline-Canonicalization — getCompanyMetrics reads NO pipeline status.
  // active_placements = readFillCohort (PlacementProcess); submitted = the Submittal
  // grain count (below). pipelineRepository is unused here.
  const pipelineRepository = {};
  // Expand opts.submitted {req,count} into distinct first-Submittal grains per req.
  const submittedGrains = opts.submitted.flatMap((s) =>
    Array.from({ length: s.count }, (_unused, j) => ({
      talent_id: `sub-${s.requisition_id}-${String(j)}`,
      requisition_id: s.requisition_id,
      first_submitted_at: new Date('2026-01-01T00:00:00.000Z'),
      pipeline_id: `pipe-${s.requisition_id}-${String(j)}`,
    })),
  );
  // Lane 2 / L2-G — active_placements + company-placements both derive from the canonical
  // fill read. Reproduce the seeded placements AS readFillCohort rows: `placedRows` map
  // 1:1 (id → first_placement_process_id) for the placements list; otherwise `placed`
  // {req,count} expands into `count` distinct (talent, req) established rows for the count.
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');
  const establishedRows =
    opts.placedRows !== undefined && opts.placedRows.length > 0
      ? opts.placedRows.map((r) => ({
          requisition_id: r['requisition_id'] as string,
          talent_record_id: r['talent_record_id'] as string,
          first_placement_process_id: r['id'] as string,
          first_established_at: EPOCH,
          first_started_at: null,
        }))
      : opts.placed.flatMap((p) =>
          Array.from({ length: p.count }, (_unused, j) => ({
            requisition_id: p.requisition_id,
            talent_record_id: `t-${p.requisition_id}-${String(j)}`,
            first_placement_process_id: `pp-${p.requisition_id}-${String(j)}`,
            first_established_at: EPOCH,
            first_started_at: null,
          })),
        );
  const placementEventRepository = {
    readFillCohort: vi.fn(async (q: { requisition_ids?: readonly string[] }) =>
      q.requisition_ids === undefined
        ? establishedRows
        : establishedRows.filter((r) => q.requisition_ids!.includes(r.requisition_id)),
    ),
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
    stub, // tenantSettingRepository (unused by company-metrics)
    stub, // capacity (T4-B1 access; company-metrics still uses the stored column)
    placementEventRepository as never, // L2-G: the canonical fill read (readFillCohort)
    stub, // placementPipelineRepository (T9-B3; unused here)
    {} as never, // T7-P4 guaranteeExposureRepository (unused here)
    stub, // commercialMarginRepository (T9-B4; unused here)
    { findFirstSubmittedByGrain: async () => submittedGrains } as never, // Submittal-only submitted count
    { findFirstInterviewByGrain: async () => [] } as never, // L2-I D4b interview-history port
    {} as never, // L5-P8 pre-start reporting read repo (unused here)
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
        { id: 'r-a1', company_id: 'co-A', status: 'open', openings: 3, openings_available: 1 },
        { id: 'r-a2', company_id: 'co-A', status: 'closed', openings: 2, openings_available: 2 },
        { id: 'r-b1', company_id: 'co-B', status: 'on_hold', openings: 1, openings_available: 1 },
        { id: 'r-z1', company_id: 'co-Z', status: 'open', openings: 9, openings_available: 0 },
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
  it('lists established placements at the company reqs with the req title joined', async () => {
    const { svc } = makeService({
      reqs: [
        { id: 'r-a1', company_id: 'co-A', status: 'open', title: 'Rust Eng', openings: 1, openings_available: 0 },
        { id: 'r-z1', company_id: 'co-Z', status: 'open', title: 'Other', openings: 1, openings_available: 1 },
      ],
      placed: [],
      submitted: [],
      placedRows: [
        { id: 'pl-1', talent_record_id: 'tr-1', requisition_id: 'r-a1', status: 'established' },
      ],
    });
    const res = await svc.getCompanyPlacements(actor, 'co-A');
    // L2-G — identity is now the established placement (placement_process_id); pipeline_id
    // is retired from this shape (the placement spine carries no pipeline id).
    expect(res).toEqual([
      {
        placement_process_id: 'pl-1',
        talent_record_id: 'tr-1',
        requisition_id: 'r-a1',
        requisition_title: 'Rust Eng',
      },
    ]);
  });

  it('returns [] when the company has no visible reqs', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r-z1', company_id: 'co-Z', status: 'open', title: 'X', openings: 1, openings_available: 1 }],
      placed: [],
      submitted: [],
      placedRows: [],
    });
    expect(await svc.getCompanyPlacements(actor, 'co-A')).toEqual([]);
  });
});
