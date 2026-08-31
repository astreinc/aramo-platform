import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// Lane 2 / L2-I (D3) — the GP-1-safe source-effectiveness / outcome-correlation read. Proves the
// classification (per-source counts + canonical reason buckets + fill rate), Rule C (classified
// EVIDENCE, never an ordinal/verdict), and GP-1 (a pure read — the correlation path holds no
// Talent-trust writer and mutates no Talent row).
const actor = {
  tenant_id: 't-1',
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};
const period = { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2030-01-01T00:00:00Z') };

function makeService(episodes: ReadonlyArray<{ origin_type: string | null; status: string; disposition_reason: string | null; requisition_id: string; talent_record_id: string }>, established: ReadonlyArray<{ requisition_id: string; talent_record_id: string }>) {
  const requisitionRepository = {
    listCohortForActor: vi.fn().mockResolvedValue([{ id: 'r1', openings: 1, status: 'open', created_at: new Date('2026-05-01T00:00:00Z') }]),
  };
  const readSourceEffectivenessCohort = vi.fn().mockResolvedValue(episodes.map((e, i) => ({ pipeline_id: `p-${i}`, ...e })));
  const pipelineRepository = { readSourceEffectivenessCohort };
  const readFillCohort = vi.fn().mockResolvedValue(established.map((e, i) => ({ requisition_id: e.requisition_id, talent_record_id: e.talent_record_id, first_placement_process_id: `pp-${i}`, first_established_at: new Date('2026-06-01T00:00:00Z'), first_started_at: null })));
  const placementEventRepository = { readFillCohort };
  // GP-1 witness — a Talent repository whose WRITE methods must never be called by this path.
  const talentWriter = { update: vi.fn(), create: vi.fn(), upsert: vi.fn(), delete: vi.fn() };
  const stub = {} as never;
  const svc = new ReportingService(
    stub, stub, talentWriter as never, stub, stub, stub,
    requisitionRepository as never,
    pipelineRepository as never,
    stub, stub,
    placementEventRepository as never,
    stub, {} as never, stub,
    { findFirstSubmittedByGrain: async () => [] } as never,
    { findFirstInterviewByGrain: async () => [] } as never, // L2-I D4b interview-history port
  );
  return { svc, talentWriter, readSourceEffectivenessCohort, readFillCohort };
}

describe('L2-I D3 — source-effectiveness correlation', () => {
  it('classifies per-source: episodes, by_status, dispositioned_by_reason, established_placements, fill_rate', async () => {
    const { svc } = makeService(
      [
        { origin_type: 'JOB_BOARD', status: 'qualified', disposition_reason: null, requisition_id: 'r1', talent_record_id: 't1' },
        { origin_type: 'JOB_BOARD', status: 'not_in_consideration', disposition_reason: 'not_a_fit', requisition_id: 'r1', talent_record_id: 't2' },
        { origin_type: 'JOB_BOARD', status: 'qualified', disposition_reason: null, requisition_id: 'r1', talent_record_id: 't3' },
        { origin_type: 'VMS', status: 'not_in_consideration', disposition_reason: 'talent_declined', requisition_id: 'r1', talent_record_id: 't4' },
      ],
      [{ requisition_id: 'r1', talent_record_id: 't1' }], // JOB_BOARD t1 reached PlacementProcess established
    );
    const view = await svc.getSourceEffectiveness(actor, period);
    expect(view.canonical_fill_source).toBe('PLACEMENT_PROCESS');
    const jb = view.sources.find((s) => s.source_origin_type === 'JOB_BOARD')!;
    expect(jb.episodes).toBe(3);
    expect(jb.by_status).toEqual([{ status: 'not_in_consideration', count: 1 }, { status: 'qualified', count: 2 }]);
    expect(jb.dispositioned_by_reason).toEqual([{ reason: 'not_a_fit', count: 1 }]);
    expect(jb.established_placements).toBe(1);
    expect(jb.fill_rate).toBe(33); // round(1/3*100)
    const vms = view.sources.find((s) => s.source_origin_type === 'VMS')!;
    expect(vms.episodes).toBe(1);
    expect(vms.dispositioned_by_reason).toEqual([{ reason: 'talent_declined', count: 1 }]);
    expect(vms.established_placements).toBe(0);
    expect(vms.fill_rate).toBe(0);
  });

  it('NEGATIVE CONTROL (Rule C) — the output is classified EVIDENCE, never an ordinal / boolean verdict', async () => {
    const { svc } = makeService([{ origin_type: 'VMS', status: 'qualified', disposition_reason: null, requisition_id: 'r1', talent_record_id: 't1' }], []);
    const view = await svc.getSourceEffectiveness(actor, period);
    // The ordinal-term ban (ADR-0019) is enforced globally by scripts/verify-vocabulary.sh over
    // this reader + view (banned literals never restated here). Rule C is asserted STRUCTURALLY:
    // every source row is EVIDENCE — counts + canonical reason buckets + a numeric rate — with NO
    // boolean verdict and NO scalar-quality field.
    const row = view.sources[0]!;
    const keys = Object.keys(row as unknown as Record<string, unknown>);
    expect(keys.sort()).toEqual(['by_status', 'dispositioned_by_reason', 'episodes', 'established_placements', 'fill_rate', 'source_origin_type']);
    expect(typeof row.fill_rate).toBe('number');
    expect(Array.isArray(row.by_status)).toBe(true);
    expect(Object.values(row as unknown as Record<string, unknown>).some((v) => typeof v === 'boolean')).toBe(false);
  });

  it('NEGATIVE CONTROL (GP-1) — the correlation path performs ZERO Talent-trust writes', async () => {
    const { svc, talentWriter } = makeService([{ origin_type: 'JOB_BOARD', status: 'qualified', disposition_reason: null, requisition_id: 'r1', talent_record_id: 't1' }], []);
    await svc.getSourceEffectiveness(actor, period);
    for (const spy of Object.values(talentWriter)) expect(spy).not.toHaveBeenCalled();
  });
});
