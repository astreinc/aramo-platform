import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import type { GuaranteeExposureSnapshot } from '@aramo/placement';

import { ReportingController } from '../lib/reporting.controller.js';
import { ReportingService } from '../lib/reporting.service.js';

// T7-P4 — controller validation (date-only rejection, inverted period, report:read metadata)
// and the ReportingService fold (at_risk == active, remedy_due nesting, falloff_rate percent,
// zero-denominator convention, period echo). No DB — the aggregate SQL is proven in the PG17
// integration spec.

const AUTH = { tenant_id: 't', sub: 'u', scopes: ['report:read'] } as never;
const REQ = {} as never; // never reached — validation throws first

function seeAllActor() {
  return { tenant_id: 't', user_id: 'u', scopes: ['report:read'], visibility: { see_all_requisition: true } as unknown as VisibilityContextShape };
}
function serviceWithSnapshot(snapshot: GuaranteeExposureSnapshot): ReportingService {
  const repo = { readGuaranteeExposureSnapshot: async () => snapshot } as never;
  return new ReportingService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, // requisitionRepository (see-all → never called)
    {} as never, {} as never, {} as never, {} as never, {} as never,
    repo,
  );
}

describe('T7-P4 guarantee-exposure — controller validation', () => {
  const controller = new ReportingController({} as never);

  it('20 — the route requires the report:read scope', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller.guaranteeExposure) as string[] | undefined;
    expect(scopes).toEqual(['report:read']);
  });

  it('21 — a date-only `from` is rejected 400 (VALIDATION_ERROR)', async () => {
    await expect(
      controller.guaranteeExposure(AUTH, 'r', '2026-01-01', '2026-02-01T00:00:00.000Z', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('21b — a zone-less `to` is rejected 400', async () => {
    await expect(
      controller.guaranteeExposure(AUTH, 'r', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('22 — an inverted period (from >= to) is rejected 400', async () => {
    await expect(
      controller.guaranteeExposure(AUTH, 'r', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', undefined, REQ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});

describe('T7-P4 guarantee-exposure — service fold', () => {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const to = new Date('2026-02-01T00:00:00.000Z');

  it('folds the snapshot: at_risk == active, remedy_due nested, falloff_rate percent, period echo', async () => {
    const snapshot: GuaranteeExposureSnapshot = {
      cohort_count: 4,
      exposure_by_currency: [{ currency: 'USD', total: '100.00', active: '40.00', satisfied: '30.00', fell_off: '30.00' }],
      states: { active: 2, satisfied: 1, fell_off: 1, replacement_due: 0, refund_due: 1, prorated_credit_due: 0, remedy_completed: 0 },
      remedy_obligation_by_currency: [{ currency: 'USD', refund_total: '30.00', prorated_credit_total: '0.00' }],
    };
    const v = await serviceWithSnapshot(snapshot).getGuaranteeExposure(seeAllActor(), { from, to });
    expect(v.period).toEqual({ from: from.toISOString(), to: to.toISOString() });
    expect(v.cohort_count).toBe(4);
    expect(v.exposure_by_currency[0]!.at_risk).toBe('40.00'); // == active
    expect(v.states.remedy_due).toEqual({ replacement: 0, refund: 1, prorated_credit: 0 });
    expect(v.states.remedy_completed).toBe(0);
    expect(v.falloff_rate).toBe(25); // 1/4 -> 25%
  });

  it('empty cohort → falloff_rate 0 (zero-denominator convention)', async () => {
    const snapshot: GuaranteeExposureSnapshot = {
      cohort_count: 0,
      exposure_by_currency: [],
      states: { active: 0, satisfied: 0, fell_off: 0, replacement_due: 0, refund_due: 0, prorated_credit_due: 0, remedy_completed: 0 },
      remedy_obligation_by_currency: [],
    };
    const v = await serviceWithSnapshot(snapshot).getGuaranteeExposure(seeAllActor(), { from, to });
    expect(v.falloff_rate).toBe(0);
    expect(v.exposure_by_currency).toEqual([]);
  });
});
