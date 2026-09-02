import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { VisibilityContextShape } from '@aramo/common';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import type { PreStartOnboardingRollupSnapshot } from '@aramo/pre-start-requirement';

import { ReportingController } from '../lib/reporting.controller.js';
import { ReportingService } from '../lib/reporting.service.js';

// Lane 5 / L5-P8 — the reporting→pre-start-requirement read edge (directive
// Amendment A1, option (a)). Controller scope metadata + the ReportingService
// pass-through fold of the pre-start-owned aggregate into the reporting view. The
// aggregate SQL itself is proven in the pre-start-requirement PG17 integration
// spec; here we prove the seam is wired read-only and mapped faithfully.

function actor() {
  return {
    tenant_id: 't',
    user_id: 'u',
    scopes: ['report:read'],
    visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
  };
}

// Construct the service with only the pre-start reporting repo mocked; every other
// dependency is unused by getOnboardingRollup (tenant-scoped, no visibility fold).
function serviceWithRollup(snapshot: PreStartOnboardingRollupSnapshot): ReportingService {
  const preStart = { readOnboardingRollup: async () => snapshot } as never;
  return new ReportingService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    preStart,
  );
}

describe('L5-P8 onboarding-rollup — controller scope', () => {
  const controller = new ReportingController({} as never);

  it('the route requires the report:read scope', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, controller.onboardingRollup) as
      | string[]
      | undefined;
    expect(scopes).toEqual(['report:read']);
  });
});

describe('L5-P8 onboarding-rollup — service fold', () => {
  it('maps the pre-start aggregate into the reporting view faithfully (read-only pass-through)', async () => {
    const snapshot: PreStartOnboardingRollupSnapshot = {
      by_type_status: [
        { requirement_type: 'BACKGROUND_CHECK', status: 'SATISFIED', count: 2 },
        { requirement_type: 'CLIENT_PAPERWORK', status: 'WAIVED', count: 1 },
        { requirement_type: 'NDA', status: 'PENDING', count: 3 },
      ],
      totals: { total: 6, resolved: 3, unresolved: 3, blocking_unresolved: 1 },
      readiness_decisions: {
        ready: 1,
        refused: 2,
        refused_materialization_absent: 1,
        refused_blocking_unresolved: 1,
      },
    };
    const svc = serviceWithRollup(snapshot);
    const view = await svc.getOnboardingRollup(actor());
    expect(view).toEqual({
      by_type_status: [
        { requirement_type: 'BACKGROUND_CHECK', status: 'SATISFIED', count: 2 },
        { requirement_type: 'CLIENT_PAPERWORK', status: 'WAIVED', count: 1 },
        { requirement_type: 'NDA', status: 'PENDING', count: 3 },
      ],
      totals: { total: 6, resolved: 3, unresolved: 3, blocking_unresolved: 1 },
      readiness_decisions: {
        ready: 1,
        refused: 2,
        refused_materialization_absent: 1,
        refused_blocking_unresolved: 1,
      },
    });
  });

  it('an empty aggregate folds to an all-zero view', async () => {
    const svc = serviceWithRollup({
      by_type_status: [],
      totals: { total: 0, resolved: 0, unresolved: 0, blocking_unresolved: 0 },
      readiness_decisions: { ready: 0, refused: 0, refused_materialization_absent: 0, refused_blocking_unresolved: 0 },
    });
    const view = await svc.getOnboardingRollup(actor());
    expect(view.by_type_status).toEqual([]);
    expect(view.totals.total).toBe(0);
    expect(view.readiness_decisions.ready).toBe(0);
  });
});
