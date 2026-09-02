import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// Lane 2 / L2-I (D4b) — the HIRING funnel report (downstream-owner-attributed). Proves each stage
// is sourced from its OWNING aggregate via the reporting-owned ports/reads (submitted ←
// SUBMITTED_HISTORY_PORT, interview ← INTERVIEW_HISTORY_PORT, offer/accepted ← Offer read,
// placement/start ← PlacementProcess fill read), the owner labels, and the separation invariant:
// the hiring family carries NO recruiting stage (the AC-5 negative control, mirror of D4a).
const actor = {
  tenant_id: 't-1', user_id: 'u-1', scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

interface Sources {
  submitted?: Array<{ talent_record_id: string; requisition_id: string; first_submitted_at: Date }>;
  interviews?: Array<{ talent_record_id: string; requisition_id: string; first_interview_at: Date }>;
  offers?: Array<{ requisition_id: string; talent_record_id: string; accepted: boolean }>;
  fill?: Array<{ requisition_id: string; talent_record_id: string; first_started_at: Date | null }>;
}

function makeService(s: Sources) {
  const findFirstSubmittedByGrain = vi.fn().mockResolvedValue(s.submitted ?? []);
  const findFirstInterviewByGrain = vi.fn().mockResolvedValue(s.interviews ?? []);
  const readOfferReachedByGrain = vi.fn().mockResolvedValue(s.offers ?? []);
  const readFillCohort = vi.fn().mockResolvedValue(s.fill ?? []);
  const stub = {} as never;
  // listForActor drives the non-see-all visibility branch; returns [] so an actor with
  // no visible requisitions resolves to an explicit empty set.
  const requisitionRepository = { listForActor: vi.fn().mockResolvedValue([]) };
  const svc = new ReportingService(
    stub, stub, stub, stub, stub, stub,
    requisitionRepository as never, // requisitionRepository
    stub, // pipelineRepository — the hiring funnel reads NO pipeline (owner-attributed)
    stub, stub,
    { readOfferReachedByGrain, readFillCohort } as never, // placementEventRepository
    stub, stub, stub,
    { findFirstSubmittedByGrain } as never,
    { findFirstInterviewByGrain } as never,
    {} as never, // L5-P8 pre-start reporting read repo (unused here)
  );
  return { svc, findFirstSubmittedByGrain, findFirstInterviewByGrain, readOfferReachedByGrain, readFillCohort };
}

const D = (iso: string) => new Date(iso);

describe('L2-I D4b — hiring funnel (downstream-owner-attributed)', () => {
  it('sources each stage from its OWNING aggregate; reached-counts + owner labels are correct', async () => {
    const { svc } = makeService({
      submitted: [
        { talent_record_id: 't1', requisition_id: 'r1', first_submitted_at: D('2026-05-01T00:00:00Z') },
        { talent_record_id: 't2', requisition_id: 'r1', first_submitted_at: D('2026-05-02T00:00:00Z') },
        { talent_record_id: 't3', requisition_id: 'r1', first_submitted_at: D('2026-05-03T00:00:00Z') },
      ],
      interviews: [
        { talent_record_id: 't1', requisition_id: 'r1', first_interview_at: D('2026-05-04T00:00:00Z') },
        { talent_record_id: 't2', requisition_id: 'r1', first_interview_at: D('2026-05-05T00:00:00Z') },
      ],
      offers: [
        { requisition_id: 'r1', talent_record_id: 't1', accepted: true },
        { requisition_id: 'r1', talent_record_id: 't2', accepted: false },
      ],
      fill: [
        { requisition_id: 'r1', talent_record_id: 't1', first_started_at: D('2026-06-01T00:00:00Z') },
      ],
    });
    const view = await svc.getHiringFunnel(actor);
    expect(view.stages).toEqual([
      { stage: 'submitted', owner: 'SUBMITTAL', count: 3 },
      { stage: 'interview', owner: 'CLIENT_SELECTION', count: 2 },
      { stage: 'offer', owner: 'OFFER', count: 2 },
      { stage: 'accepted', owner: 'OFFER', count: 1 },
      { stage: 'placement', owner: 'PLACEMENT_PROCESS', count: 1 },
      { stage: 'start', owner: 'PLACEMENT_PROCESS', count: 1 },
    ]);
  });

  it('placement counts the fill grain; start counts only fill grains with a non-null first_started_at', async () => {
    const { svc } = makeService({
      fill: [
        { requisition_id: 'r1', talent_record_id: 't1', first_started_at: D('2026-06-01T00:00:00Z') },
        { requisition_id: 'r1', talent_record_id: 't2', first_started_at: null }, // established, never started
      ],
    });
    const view = await svc.getHiringFunnel(actor);
    const byStage = Object.fromEntries(view.stages.map((s) => [s.stage, s.count]));
    expect(byStage.placement).toBe(2);
    expect(byStage.start).toBe(1);
  });

  it('NEGATIVE CONTROL — the hiring family carries NO recruiting stage (considered/contacted/responded/qualifying/qualified/dispositioned)', async () => {
    const { svc } = makeService({ submitted: [{ talent_record_id: 't1', requisition_id: 'r1', first_submitted_at: D('2026-05-01T00:00:00Z') }] });
    const view = await svc.getHiringFunnel(actor);
    const stageNames = view.stages.map((s) => s.stage);
    for (const recruiting of ['considered', 'contacted', 'responded', 'qualifying', 'qualified', 'dispositioned']) {
      expect(stageNames).not.toContain(recruiting);
    }
  });

  it('an EXPLICIT empty visible-set (no requisitions visible) yields all-zero stages and reads nothing', async () => {
    const noneVisible = {
      tenant_id: 't-1', user_id: 'u-1', scopes: ['report:read'],
      visibility: { see_all_requisition: false, requisition_ids: [] } as unknown as VisibilityContextShape,
    };
    const { svc, findFirstSubmittedByGrain, findFirstInterviewByGrain, readOfferReachedByGrain, readFillCohort } = makeService({});
    const view = await svc.getHiringFunnel(noneVisible);
    expect(view.stages.every((s) => s.count === 0)).toBe(true);
    expect(view.stages.map((s) => s.stage)).toEqual(['submitted', 'interview', 'offer', 'accepted', 'placement', 'start']);
    // short-circuit: no owner aggregate is read when the actor sees nothing.
    expect(findFirstSubmittedByGrain).not.toHaveBeenCalled();
    expect(findFirstInterviewByGrain).not.toHaveBeenCalled();
    expect(readOfferReachedByGrain).not.toHaveBeenCalled();
    expect(readFillCohort).not.toHaveBeenCalled();
  });
});
