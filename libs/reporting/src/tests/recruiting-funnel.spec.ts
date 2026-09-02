import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// Lane 2 / L2-I (D4) — the RECRUITING funnel report (Pipeline-owned). Proves the R3 projection of
// the canonical PipelineStatus registry onto the six recruiting stages, and the separation
// invariant: the recruiting family carries NO hiring stage (AC-5 negative control).
const actor = {
  tenant_id: 't-1', user_id: 'u-1', scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

function makeService(byStatus: ReadonlyArray<{ status: string; count: number }>) {
  const countByStatus = vi.fn().mockResolvedValue(byStatus);
  const pipelineRepository = { countByStatus };
  const stub = {} as never;
  const svc = new ReportingService(
    stub, stub, stub, stub, stub, stub,
    stub, // requisitionRepository (unused for see-all)
    pipelineRepository as never,
    stub, stub, stub, stub, {} as never, stub,
    { findFirstSubmittedByGrain: async () => [] } as never,
    { findFirstInterviewByGrain: async () => [] } as never, // L2-I D4b interview-history port
    {} as never, // L5-P8 pre-start reporting read repo (unused here)
  );
  return { svc };
}

describe('L2-I D4 — recruiting funnel (Pipeline-owned)', () => {
  it('projects the canonical status registry onto the six recruiting stages (R3); downstream/legacy statuses excluded', async () => {
    const { svc } = makeService([
      { status: 'no_contact', count: 2 },
      { status: 'contacted', count: 3 },
      { status: 'talent_responded', count: 1 },
      { status: 'qualifying', count: 4 },
      { status: 'qualified', count: 5 },
      { status: 'not_in_consideration', count: 2 },
      { status: 'completed', count: 1 }, // system success terminal — NOT a recruiting stage
    ]);
    const view = await svc.getRecruitingFunnel(actor);
    expect(view.canonical_source).toBe('PIPELINE');
    expect(view.stages).toEqual([
      { stage: 'considered', count: 2 },
      { stage: 'contacted', count: 3 },
      { stage: 'responded', count: 1 },
      { stage: 'qualifying', count: 4 },
      { stage: 'qualified', count: 5 },
      { stage: 'dispositioned', count: 2 },
    ]);
  });

  it('NEGATIVE CONTROL — the recruiting family carries NO hiring stage (submitted/interview/offer/accepted/placement/start)', async () => {
    const { svc } = makeService([{ status: 'qualified', count: 1 }, { status: 'completed', count: 9 }]);
    const view = await svc.getRecruitingFunnel(actor);
    const stageNames = view.stages.map((s) => s.stage);
    for (const hiring of ['submitted', 'interview', 'offer', 'accepted', 'placement', 'start']) {
      expect(stageNames).not.toContain(hiring);
    }
    // and `completed` (9, the system terminal) never leaks in as a recruiting count.
    expect(view.stages.reduce((n, s) => n + s.count, 0)).toBe(1);
  });
});
