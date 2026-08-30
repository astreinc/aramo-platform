import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B1 — fill-rate + time-to-fill semantic unit matrix (directive §15).
//
// The service is exercised with MOCKED repositories: `listCohortForActor`
// returns the already-[from,to)+A3-scoped cohort; L2-G — `readFillCohort` returns the
// per-(talent, req) FIRST-ESTABLISHED instant (canonical fill = PlacementProcess
// established, D-1; the MIN/dedup is applied in-repo). This spec proves the PURE
// aggregation semantics: the placement-established fill authority, the openings clamp,
// Nth-distinct completion, status handling, null denominator, and averaging. Time-to-Fill
// is opened→established.
//
// The SQL-level guarantees are proven in the bearing libs/reporting integration
// spec (real Postgres): the [from,to) cohort boundary, REOPEN-uses-original-
// created_at, duplicate-episode MIN/dedup, and tenant/site/A3 scoping.
//
// Every unused constructor dependency is a `{} as never` stub — so a test only
// passes if `getFillPerformance` touches EXCLUSIVELY the two new reads and never
// the rejected capacity-derived path (which would throw on the stub).

const TENANT = 't-1';
const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
const day = (n: number): Date => new Date(FROM.getTime() + n * DAY_MS);

type Cohort = ReadonlyArray<{
  id: string;
  openings: number;
  status: string;
  created_at: Date;
}>;
// L2-G — fill authority = PlacementProcess *established* (D-1). The fixture instant is
// the FIRST-established (fill) instant; makeService maps it into the readFillCohort shape
// (adds a synthetic placement id + first_started_at=null; Time-to-Fill uses the
// established instant, not a STARTED instant).
type Placed = ReadonlyArray<{
  requisition_id: string;
  talent_record_id: string;
  first_established_at: Date;
}>;

function makeService(cohort: Cohort, placed: Placed) {
  const requisitionRepository = {
    listCohortForActor: vi.fn().mockResolvedValue(cohort),
  };
  const fillRows = placed.map((p, i) => ({
    requisition_id: p.requisition_id,
    talent_record_id: p.talent_record_id,
    first_placement_process_id: `pp-${String(i)}`,
    first_established_at: p.first_established_at,
    first_started_at: null,
  }));
  const placementEventRepository = {
    readFillCohort: vi.fn().mockResolvedValue(fillRows),
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
    stub, // pipelineRepository — L2-G: fill authority is no longer pipeline `placed`
    stub, // tenantSettingRepository
    stub, // capacity — the REJECTED path; must never be touched
    placementEventRepository as never, // L2-G: the canonical fill read (readFillCohort)
    stub, // placementPipelineRepository (T9-B3; unused here)
    {} as never, // T7-P4 guaranteeExposureRepository (unused here)
    stub, // commercialMarginRepository (T9-B4; unused here)
    { findFirstSubmittedByGrain: async () => [] } as never, // L2-E submitted-history port
  );
  return { svc, requisitionRepository, placementEventRepository };
}

const actor = {
  tenant_id: TENANT,
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: {
    see_all_requisition: true,
  } as unknown as VisibilityContextShape,
};

const run = (cohort: Cohort, placed: Placed) => {
  const { svc, requisitionRepository, placementEventRepository } = makeService(
    cohort,
    placed,
  );
  return {
    result: svc.getFillPerformance(actor, { from: FROM, to: TO }),
    requisitionRepository,
    placementEventRepository,
  };
};

describe('ReportingService.getFillPerformance — fill rate', () => {
  it('single-opening filled → 100% and fully-filled', async () => {
    const { result } = run(
      [{ id: 'r1', openings: 1, status: 'open', created_at: day(0) }],
      [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(5) }],
    );
    const v = await result;
    expect(v.openings).toBe(1);
    expect(v.filled_openings).toBe(1);
    expect(v.fill_rate).toBe(100);
    expect(v.fully_filled_requisitions).toBe(1);
    // L2-G — provenance stamped: fill authority is the placement spine.
    expect(v.canonical_fill_source).toBe('PLACEMENT_PROCESS');
  });

  it('single-opening unfilled → 0% and not fully-filled', async () => {
    const v = await run(
      [{ id: 'r1', openings: 1, status: 'open', created_at: day(0) }],
      [],
    ).result;
    expect(v.openings).toBe(1);
    expect(v.filled_openings).toBe(0);
    expect(v.fill_rate).toBe(0);
    expect(v.fully_filled_requisitions).toBe(0);
  });

  it('multi-opening fully filled → filled == openings', async () => {
    const v = await run(
      [{ id: 'r1', openings: 3, status: 'open', created_at: day(0) }],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r1', talent_record_id: 't2', first_established_at: day(6) },
        { requisition_id: 'r1', talent_record_id: 't3', first_established_at: day(4) },
      ],
    ).result;
    expect(v.openings).toBe(3);
    expect(v.filled_openings).toBe(3);
    expect(v.fill_rate).toBe(100);
    expect(v.fully_filled_requisitions).toBe(1);
  });

  it('multi-opening partial → fractional fill, not fully-filled', async () => {
    const v = await run(
      [{ id: 'r1', openings: 3, status: 'open', created_at: day(0) }],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r1', talent_record_id: 't2', first_established_at: day(4) },
      ],
    ).result;
    expect(v.openings).toBe(3);
    expect(v.filled_openings).toBe(2);
    expect(v.fill_rate).toBe(67); // round(2/3*100)
    expect(v.fully_filled_requisitions).toBe(0);
  });

  it('over-placed → filled clamped to declared openings', async () => {
    const v = await run(
      [{ id: 'r1', openings: 1, status: 'open', created_at: day(0) }],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r1', talent_record_id: 't2', first_established_at: day(3) },
      ],
    ).result;
    expect(v.filled_openings).toBe(1); // min(2, 1)
    expect(v.fill_rate).toBe(100);
    expect(v.fully_filled_requisitions).toBe(1);
  });

  it('canceled requisition excluded from numerator AND denominator', async () => {
    const v = await run(
      [
        { id: 'rc', openings: 2, status: 'canceled', created_at: day(0) },
        { id: 'ro', openings: 2, status: 'open', created_at: day(1) },
      ],
      [
        // placements on the canceled req must be ignored entirely
        { requisition_id: 'rc', talent_record_id: 'tc', first_established_at: day(4) },
        { requisition_id: 'ro', talent_record_id: 't1', first_established_at: day(3) },
        { requisition_id: 'ro', talent_record_id: 't2', first_established_at: day(5) },
      ],
    ).result;
    expect(v.openings).toBe(2); // only the open req's openings
    expect(v.filled_openings).toBe(2);
    expect(v.fill_rate).toBe(100);
    expect(v.fully_filled_requisitions).toBe(1);
  });

  it('closed-unfilled stays denominator-only (closed ≠ filled)', async () => {
    const v = await run(
      [{ id: 'r1', openings: 2, status: 'closed', created_at: day(0) }],
      [],
    ).result;
    expect(v.openings).toBe(2);
    expect(v.filled_openings).toBe(0);
    expect(v.fill_rate).toBe(0);
    expect(v.fully_filled_requisitions).toBe(0);
    expect(v.time_to_fill.count).toBe(0);
  });

  it('zero denominator (all canceled) → null fill_rate', async () => {
    const v = await run(
      [{ id: 'rc', openings: 2, status: 'canceled', created_at: day(0) }],
      [],
    ).result;
    expect(v.openings).toBe(0);
    expect(v.filled_openings).toBe(0);
    expect(v.fill_rate).toBeNull();
    expect(v.time_to_fill.average_days).toBeNull();
  });
});

describe('ReportingService.getFillPerformance — time-to-fill', () => {
  it('single-opening → created_at → first placed instant', async () => {
    const v = await run(
      [{ id: 'r1', openings: 1, status: 'open', created_at: day(0) }],
      [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(5) }],
    ).result;
    expect(v.time_to_fill.count).toBe(1);
    expect(v.time_to_fill.average_days).toBe(5);
  });

  it('multi-opening → completion is the Nth (last-required) distinct placed', async () => {
    // openings=3, placed at days 2,6,4 → completion = 3rd smallest = day 6.
    const v = await run(
      [{ id: 'r1', openings: 3, status: 'open', created_at: day(0) }],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r1', talent_record_id: 't2', first_established_at: day(6) },
        { requisition_id: 'r1', talent_record_id: 't3', first_established_at: day(4) },
      ],
    ).result;
    expect(v.time_to_fill.count).toBe(1);
    expect(v.time_to_fill.average_days).toBe(6);
  });

  it('partial fill → no time-to-fill value', async () => {
    const v = await run(
      [{ id: 'r1', openings: 3, status: 'open', created_at: day(0) }],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r1', talent_record_id: 't2', first_established_at: day(4) },
      ],
    ).result;
    expect(v.time_to_fill.count).toBe(0);
    expect(v.time_to_fill.average_days).toBeNull();
  });

  it('fully filled before a later close → retains the completed time-to-fill', async () => {
    const v = await run(
      [{ id: 'r1', openings: 1, status: 'closed', created_at: day(0) }],
      [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(3) }],
    ).result;
    expect(v.fully_filled_requisitions).toBe(1);
    expect(v.time_to_fill.count).toBe(1);
    expect(v.time_to_fill.average_days).toBe(3);
  });

  it('averages time-to-fill across multiple fully-filled requisitions', async () => {
    const v = await run(
      [
        { id: 'r1', openings: 1, status: 'open', created_at: day(0) },
        { id: 'r2', openings: 1, status: 'open', created_at: day(0) },
      ],
      [
        { requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(2) },
        { requisition_id: 'r2', talent_record_id: 't1', first_established_at: day(4) },
      ],
    ).result;
    expect(v.time_to_fill.count).toBe(2);
    expect(v.time_to_fill.average_days).toBe(3); // mean(2, 4)
  });
});

describe('ReportingService.getFillPerformance — contract & authority', () => {
  it('echoes the period and forwards [from,to) to the cohort read', async () => {
    const { result, requisitionRepository } = run(
      [{ id: 'r1', openings: 1, status: 'open', created_at: day(0) }],
      [{ requisition_id: 'r1', talent_record_id: 't1', first_established_at: day(1) }],
    );
    const v = await result;
    expect(v.period.from).toBe(FROM.toISOString());
    expect(v.period.to).toBe(TO.toISOString());
    expect(requisitionRepository.listCohortForActor).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, from: FROM, to: TO }),
    );
  });

  it('empty cohort → null fill_rate, zero everything, no repo placed read', async () => {
    const { result, placementEventRepository } = run([], []);
    const v = await result;
    expect(v.openings).toBe(0);
    expect(v.fill_rate).toBeNull();
    expect(v.fully_filled_requisitions).toBe(0);
    expect(v.time_to_fill.count).toBe(0);
    // No cohort → the canonical fill read is short-circuited.
    expect(
      placementEventRepository.readFillCohort,
    ).not.toHaveBeenCalled();
  });
});
