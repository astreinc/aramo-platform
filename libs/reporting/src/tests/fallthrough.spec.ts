import { describe, expect, it, vi } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B2 — fallthrough report fold (directive §3/§8/§9). The placement cohort read
// is MOCKED; this spec proves the pure fold: rate = round(fallthrough/accepted*100)
// integer percent, null on zero denominator; reason group-by with a null→
// "Unspecified" report-only bucket; deterministic ordering; and the A3 visible-
// requisition pass-through. `reason_detail` never appears (the cohort read does
// not surface it — the mock returns only reason_code + reason_label_snapshot).

const TENANT = 't-1';
const FROM = new Date('2026-05-01T00:00:00.000Z');
const TO = new Date('2026-06-01T00:00:00.000Z');

type Cohort = {
  accepted_attempts: number;
  fallthrough: Array<{
    reason_code: string | null;
    reason_label_snapshot: string | null;
  }>;
};

function makeService(cohort: Cohort, visibleReqs?: ReadonlyArray<{ id: string }>) {
  const placementEventRepository = {
    readFallthroughCohort: vi.fn().mockResolvedValue(cohort),
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
    placementEventRepository as never,
  );
  return { svc, placementEventRepository, requisitionRepository };
}

const seeAllActor = {
  tenant_id: TENANT,
  user_id: 'u-1',
  scopes: ['report:read'],
  visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
};

describe('ReportingService.getFallthrough', () => {
  it('computes rate + grouped reasons (deterministic order) with a null→Unspecified bucket', async () => {
    const { svc } = makeService({
      accepted_attempts: 10,
      fallthrough: [
        { reason_code: 'start_date_failed', reason_label_snapshot: 'Start date failed' },
        { reason_code: 'start_date_failed', reason_label_snapshot: 'Start date failed' },
        { reason_code: 'client_cancelled', reason_label_snapshot: 'Client cancelled' },
        { reason_code: null, reason_label_snapshot: null },
      ],
    });
    const v = await svc.getFallthrough(seeAllActor, { from: FROM, to: TO });
    expect(v.accepted_attempts).toBe(10);
    expect(v.fallthrough_attempts).toBe(4);
    expect(v.fallthrough_rate).toBe(40); // round(4/10*100)
    expect(v.period).toEqual({ from: FROM.toISOString(), to: TO.toISOString() });
    // Most frequent first, then reason_code asc; null "Unspecified" last.
    expect(v.reasons).toEqual([
      { reason_code: 'start_date_failed', reason_label: 'Start date failed', count: 2, rate: 50 },
      { reason_code: 'client_cancelled', reason_label: 'Client cancelled', count: 1, rate: 25 },
      { reason_code: null, reason_label: 'Unspecified', count: 1, rate: 25 },
    ]);
  });

  it('zero denominator → fallthrough_rate null, reasons empty', async () => {
    const v = await makeService({ accepted_attempts: 0, fallthrough: [] }).svc.getFallthrough(
      seeAllActor,
      { from: FROM, to: TO },
    );
    expect(v.accepted_attempts).toBe(0);
    expect(v.fallthrough_attempts).toBe(0);
    expect(v.fallthrough_rate).toBeNull();
    expect(v.reasons).toEqual([]);
  });

  it('accepted but zero fallthrough → rate 0, reasons empty', async () => {
    const v = await makeService({ accepted_attempts: 6, fallthrough: [] }).svc.getFallthrough(
      seeAllActor,
      { from: FROM, to: TO },
    );
    expect(v.accepted_attempts).toBe(6);
    expect(v.fallthrough_attempts).toBe(0);
    expect(v.fallthrough_rate).toBe(0);
    expect(v.reasons).toEqual([]);
  });

  it('forwards [from,to) to the placement cohort read; see-all → no requisition filter', async () => {
    const { svc, placementEventRepository } = makeService({
      accepted_attempts: 1,
      fallthrough: [{ reason_code: 'no_show', reason_label_snapshot: 'No show' } as never],
    });
    await svc.getFallthrough(seeAllActor, { from: FROM, to: TO });
    expect(placementEventRepository.readFallthroughCohort).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, from: FROM, to: TO }),
    );
    const arg = placementEventRepository.readFallthroughCohort.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('requisition_ids' in arg).toBe(false); // tenant-wide see-all
  });

  it('recruiter (not see-all) → passes the A3 visible requisition ids', async () => {
    const recruiter = {
      tenant_id: TENANT,
      user_id: 'u-2',
      scopes: ['report:read'],
      visibility: { see_all_requisition: false } as unknown as VisibilityContextShape,
    };
    const { svc, placementEventRepository } = makeService(
      { accepted_attempts: 0, fallthrough: [] },
      [{ id: 'r-1' }, { id: 'r-2' }],
    );
    await svc.getFallthrough(recruiter, { from: FROM, to: TO });
    expect(placementEventRepository.readFallthroughCohort).toHaveBeenCalledWith(
      expect.objectContaining({ requisition_ids: ['r-1', 'r-2'] }),
    );
  });
});
