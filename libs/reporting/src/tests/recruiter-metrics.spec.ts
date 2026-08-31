import type { VisibilityContextShape } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import { ReportingService } from '../lib/reporting.service.js';

const TENANT = 't-1';

// Fixed wall clock so the windowing is deterministic.
const NOW = new Date('2026-06-18T12:00:00Z');

function makeService(opts: {
  reqs: ReadonlyArray<Record<string, unknown>>;
  pipelines: ReadonlyArray<{ id: string; requisition_id: string; created_at: Date }>;
  transitions: ReadonlyArray<{
    pipeline_id: string;
    status_to: string;
    changed_at: Date;
  }>;
  settingRow?: { value: unknown } | null;
}) {
  const requisitionRepository = {
    listForActor: vi.fn().mockResolvedValue(opts.reqs),
  };
  const pipelineRepository = {
    listForRequisitions: vi.fn().mockResolvedValue(opts.pipelines),
  };
  const tenantSettingRepository = {
    findOne: vi.fn().mockResolvedValue(opts.settingRow ?? null),
  };
  // Lane 2 / L2-E (SB-5) — the submitted stream is now event-sourced via the port.
  // Reproduce the seeded `submitted` transitions AS grains (pipeline_id +
  // first_submitted_at = the transition's changed_at), since-filtered exactly as the
  // real port would — so submittals_weekly + avg_time_to_submit stay identical to the
  // pre-repoint values (the R3 timestamp-parity proof, AC-2/3).
  const submittedHistory = {
    findFirstSubmittedByGrain: vi.fn(async (q: { since?: Date }) =>
      opts.transitions
        .filter((t) => t.status_to === 'submitted')
        .filter((t) => q.since === undefined || t.changed_at >= q.since)
        .map((t) => ({
          talent_id: 't',
          requisition_id: 'r',
          pipeline_id: t.pipeline_id,
          first_submitted_at: t.changed_at,
        })),
    ),
  };
  // Lane 2 / L2-G — placements_monthly is now canonical: the actor's requisitions'
  // *established* PlacementProcess (D-1), bucketed by the established instant. Reproduce
  // each seeded `placed` transition AS an established fill row (first_established_at =
  // the transition's changed_at), window-filtered exactly as the real readFillCohort —
  // so placements_monthly stays identical to the pre-flip values.
  const placementEventRepository = {
    readFillCohort: vi.fn(async (q: { from?: Date; to?: Date }) =>
      opts.transitions
        .filter((t) => t.status_to === 'established')
        .filter(
          (t) =>
            (q.from === undefined || t.changed_at >= q.from) &&
            (q.to === undefined || t.changed_at < q.to),
        )
        .map((t, i) => ({
          requisition_id: `r-${String(i)}`,
          talent_record_id: `t-${String(i)}`,
          first_placement_process_id: `pp-${String(i)}`,
          first_established_at: t.changed_at,
          first_started_at: null,
        })),
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
    tenantSettingRepository as never,
    {} as never, // capacity (T4-B1 access; recruiter-metrics does not use it)
    placementEventRepository as never, // L2-G: canonical fill read (readFillCohort)
    {} as never, // placementPipelineRepository (T9-B3; unused here)
    {} as never, // T7-P4 guaranteeExposureRepository (unused here)
    {} as never, // commercialMarginRepository (T9-B4; unused here)
    submittedHistory as never, // L2-E submitted-history port
    { findFirstInterviewByGrain: async () => [] } as never, // L2-I D4b interview-history port
  );
  return { svc, requisitionRepository, pipelineRepository, tenantSettingRepository };
}

const actor = {
  tenant_id: TENANT,
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

describe('ReportingService.getRecruiterMetrics', () => {
  it('computes value, prior-period delta, series + goal from real history transitions', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r1', company_id: 'c1', status: 'open' }],
      pipelines: [
        { id: 'p1', requisition_id: 'r1', created_at: new Date('2026-06-15T12:00:00Z') },
        { id: 'p2', requisition_id: 'r1', created_at: new Date('2026-06-01T12:00:00Z') },
      ],
      transitions: [
        // submitted: p1 in the last 7d (1d to submit), p2 in the PRIOR 7d (9d).
        { pipeline_id: 'p1', status_to: 'submitted', changed_at: new Date('2026-06-16T12:00:00Z') },
        { pipeline_id: 'p2', status_to: 'submitted', changed_at: new Date('2026-06-10T12:00:00Z') },
        // an established placement this calendar month (drives readFillCohort).
        { pipeline_id: 'p2', status_to: 'established', changed_at: new Date('2026-06-05T12:00:00Z') },
      ],
    });

    const items = await svc.getRecruiterMetrics(actor, {
      now: NOW,
      goals: { submittals_weekly: 10 },
    });
    const byKey = Object.fromEntries(items.map((m) => [m.key, m]));

    expect(byKey['submittals_weekly']).toMatchObject({
      value: 1, // p1 only (last 7 days)
      previous: 1, // p2 (prior 7 days)
      period: 'week',
      goal: 10,
    });
    expect(byKey['submittals_weekly'].series).toHaveLength(8);

    // Legacy-Pipeline-Canonicalization — interviews_weekly is removed (no key emitted).
    expect(byKey['interviews_weekly']).toBeUndefined();

    expect(byKey['placements_monthly']).toMatchObject({
      value: 1, // placed 06-05 is in June MTD
      previous: 0, // none in the prior-month comparable span
      period: 'month',
    });
    expect(byKey['placements_monthly'].series).toHaveLength(6);

    expect(byKey['avg_time_to_submit']).toMatchObject({
      value: 1, // p1: 06-16 − 06-15 = 1.0 day
      previous: 9, // p2: 06-10 − 06-01 = 9.0 days
      period: 'week',
    });
  });

  it('returns null avg-time-to-submit when no submittals in the window (no fabrication)', async () => {
    const { svc } = makeService({
      reqs: [{ id: 'r1', company_id: 'c1', status: 'open' }],
      pipelines: [
        { id: 'p1', requisition_id: 'r1', created_at: new Date('2026-06-15T12:00:00Z') },
      ],
      transitions: [], // nothing happened
    });
    const items = await svc.getRecruiterMetrics(actor, { now: NOW });
    const byKey = Object.fromEntries(items.map((m) => [m.key, m]));
    expect(byKey['avg_time_to_submit'].value).toBeNull();
    expect(byKey['submittals_weekly'].value).toBe(0);
    expect(byKey['submittals_weekly'].goal).toBeNull();
  });
});

describe('ReportingService.getRecruiterGoals', () => {
  const base = { reqs: [], pipelines: [], transitions: [] };

  it('falls back to the registry default when no tenant override is set', async () => {
    const { svc } = makeService({ ...base, settingRow: null });
    const goals = await svc.getRecruiterGoals(TENANT, 'u-1');
    // The KNOWN_SETTINGS['metrics.goals'] default ships real targets.
    expect(goals.submittals_weekly).toBe(10);
    expect(goals.placements_monthly).toBe(3);
    // avg-time has no count target.
    expect(goals.avg_time_to_submit).toBeUndefined();
  });

  it('uses a valid tenant override and drops keys the FE does not know', async () => {
    const { svc } = makeService({
      ...base,
      settingRow: { value: { submittals_weekly: 15, bogus_key: 99 } },
    });
    const goals = await svc.getRecruiterGoals(TENANT, 'u-1');
    expect(goals.submittals_weekly).toBe(15); // override applied
    expect('bogus_key' in goals).toBe(false); // unknown key dropped
    expect(goals.placements_monthly).toBeUndefined(); // not in this override
  });

  it('rejects a malformed override (a non-positive value) and uses the default', async () => {
    const { svc } = makeService({
      ...base,
      settingRow: { value: { submittals_weekly: 0 } }, // invalid (≤ 0)
    });
    const goals = await svc.getRecruiterGoals(TENANT, 'u-1');
    expect(goals.submittals_weekly).toBe(10); // registry default
  });
});
