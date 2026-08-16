import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B4 — margin fold (directive §6/§8/§19/§23). The placement commercial-margin
// aggregate read is MOCKED here; this spec proves the SERVICE contract: it PULLS
// the placement snapshot, passes the governed counts + groups through UNCHANGED
// (no margin arithmetic in reporting, §29), stamps the forward_materialized
// coverage label, and threads the A3 visible-requisition set. The weighted margin
// arithmetic itself is proven end-to-end in the placement lib's
// commercial-margin-read.integration.spec (real Postgres).

const TENANT = 't-1';

type Snapshot = {
  eligible_count: number;
  commercialized_count: number;
  missing_commercial_count: number;
  groups: Array<{
    currency: string;
    rate_period: string;
    assignment_count: number;
    group_margin_percent: string | null;
  }>;
};

function makeService(snapshot: Snapshot, visibleReqs?: ReadonlyArray<{ id: string }>) {
  const commercialMarginRepository = {
    readCurrentMarginSnapshot: vi.fn().mockResolvedValue(snapshot),
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
    stub, // placementPipelineRepository
    stub, // guaranteeExposureRepository (T7-P4; unused here)
    commercialMarginRepository as never,
  );
  return { svc, commercialMarginRepository, requisitionRepository };
}

// A compound-authorized actor (report:read AND assignment:commercials:read). The
// route-level scope gate is enforced by RolesGuard, not the service; the service
// only threads visibility.
const seeAll = {
  tenant_id: TENANT,
  user_id: 'u',
  scopes: ['report:read', 'assignment:commercials:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

describe('ReportingService.getMargin', () => {
  it('passes governed counts + groups through and stamps forward_materialized coverage', async () => {
    const { svc } = makeService({
      eligible_count: 3,
      commercialized_count: 2,
      missing_commercial_count: 1,
      groups: [
        { currency: 'USD', rate_period: 'HOURLY', assignment_count: 2, group_margin_percent: '25.00' },
      ],
    });
    const v = await svc.getMargin(seeAll, 'req-test');
    expect(v).toEqual({
      eligible_count: 3,
      commercialized_count: 2,
      missing_commercial_count: 1,
      coverage: 'forward_materialized',
      groups: [
        { currency: 'USD', rate_period: 'HOURLY', assignment_count: 2, group_margin_percent: '25.00' },
      ],
    });
  });

  it('preserves a null margin group and the zero-state truthfully', async () => {
    const { svc } = makeService({
      eligible_count: 0,
      commercialized_count: 0,
      missing_commercial_count: 0,
      groups: [],
    });
    const v = await svc.getMargin(seeAll, 'req-test');
    expect(v.coverage).toBe('forward_materialized');
    expect(v.groups).toEqual([]);
    expect(v.eligible_count).toBe(0);

    const { svc: svc2 } = makeService({
      eligible_count: 1,
      commercialized_count: 1,
      missing_commercial_count: 0,
      groups: [{ currency: 'USD', rate_period: 'HOURLY', assignment_count: 1, group_margin_percent: null }],
    });
    const v2 = await svc2.getMargin(seeAll, 'req-test');
    expect(v2.groups[0]?.group_margin_percent).toBeNull();
  });

  it('never exposes per-row commercial fields (aggregate-only shape)', async () => {
    const { svc } = makeService({
      eligible_count: 1,
      commercialized_count: 1,
      missing_commercial_count: 0,
      groups: [{ currency: 'USD', rate_period: 'HOURLY', assignment_count: 1, group_margin_percent: '20.00' }],
    });
    const v = await svc.getMargin(seeAll, 'req-test');
    const serialized = JSON.stringify(v);
    for (const banned of [
      'pay_rate_amount',
      'bill_rate_amount',
      'spread_amount',
      'total_spread_amount',
      'markup_percent',
      'assignment_id',
      'talent_record_id',
      'effective_from',
      'ended_at',
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('see-all actor → no requisition filter; recruiter → passes A3 visible ids', async () => {
    const { svc: svcAll, commercialMarginRepository: repoAll } = makeService({
      eligible_count: 0,
      commercialized_count: 0,
      missing_commercial_count: 0,
      groups: [],
    });
    await svcAll.getMargin(seeAll, 'req-test');
    const argAll = repoAll.readCurrentMarginSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(argAll['tenant_id']).toBe(TENANT);
    expect('requisition_ids' in argAll).toBe(false);

    const recruiter = {
      tenant_id: TENANT,
      user_id: 'u2',
      scopes: ['report:read', 'assignment:commercials:read'],
      visibility: { see_all_requisition: false } as unknown as VisibilityContextShape,
    };
    const { svc: svcRec, commercialMarginRepository: repoRec } = makeService(
      { eligible_count: 0, commercialized_count: 0, missing_commercial_count: 0, groups: [] },
      [{ id: 'r-1' }, { id: 'r-2' }],
    );
    await svcRec.getMargin(recruiter, 'req-test');
    expect(repoRec.readCurrentMarginSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_ids: ['r-1', 'r-2'] }),
    );
  });
});
