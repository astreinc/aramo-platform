import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEAM, v } from './catalog/catalog-test-data';
import { PlanVersionApprovalTerms, planVersionApprovalModel } from './PlanVersionApprovalTerms';

// Sign Feature Parity Amendments A3 (D1) / A4 (D2) — Finance and the Owner see the add-on unit
// prices they approve on a PLAN_VERSION_PUBLISH request, with the approved fingerprint.

const UNITS = [{ unit_key: 'sign.sms_message', name: 'SMS delivery', quantity_label: 'message' }];
const SUM = 'a'.repeat(64);
const draft = v({ id: 'team-3', version_number: 3, status: 'DRAFT', content_checksum: SUM, terms: { ...TEAM.versions[0]!.terms, unit_prices: [{ unit_key: 'sign.sms_message', unit_price_minor: 5 }] } });
const detail = { version: draft, plan: TEAM, content: {}, pinned_tenants: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('A3/A4 publish approval terms', () => {
  afterEach(() => vi.restoreAllMocks());

  it('A4-AP-U-1 lists the price and every add-on unit price; flags a draft changed after the request', () => {
    const m = planVersionApprovalModel(detail, UNITS, SUM);
    expect(m.title).toBe('Sign Team v3');
    expect(m.rows).toEqual([
      { field: 'Price', value: '$69 / month' },
      { field: 'Add-on · SMS delivery', value: '$0.05 per unit' },
    ]);
    expect(m.changed).toBe(false);
    expect(planVersionApprovalModel(detail, UNITS, 'b'.repeat(64)).changed).toBe(true);
    expect(planVersionApprovalModel(detail, UNITS, null)).toMatchObject({ fingerprint: null, changed: false });
    const none = planVersionApprovalModel({ ...detail, version: { ...draft, terms: { ...draft.terms, unit_prices: [] } } }, UNITS, SUM);
    expect(none.rows[1]).toEqual({ field: 'Add-on unit prices', value: 'None sold' });
  });

  it('A4-AP-W-1 the drawer panel loads the version and shows the add-on prices being approved', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/platform\/commercial\/catalog\/versions\/team-3$/.test(url)) return json(detail);
      if (url.endsWith('/platform/commercial/catalog')) return json({ products: [], publish_chain: null, metered_units: [{ product_key: 'sign', units: UNITS }] });
      return json({}, 404);
    });
    render(<PlanVersionApprovalTerms payload={{ plan_version_id: 'team-3', target_content_checksum: 'b'.repeat(64) }} />);
    expect(await screen.findByText('Add-on · SMS delivery')).toBeInTheDocument();
    expect(screen.getByText('$0.05 per unit')).toBeInTheDocument();
    expect(screen.getByTestId('cr-plan-version-changed')).toBeInTheDocument();
  });
});
