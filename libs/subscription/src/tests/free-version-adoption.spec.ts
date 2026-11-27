import { describe, expect, it } from 'vitest';

import { applyCatalogDraftEdits } from '../lib/commercial/commercial-catalog.js';
import { ADOPT_FREE_SUBSCRIPTIONS_KEY, validatePayload } from '../lib/commercial/commercial-change-request.js';
import { freeAdoptionRefusals } from '../lib/commercial/free-version-adoption.js';
import type { PlanVersionContent } from '../lib/plan-version.js';

// SIGN-FREE-PARITY-1 S1 (LOCKED 2026-11-27; typed divergence D-1) — moving the open FREE subscriptions
// to a newly published version is admissible only when no term is lowered; a dropped allowance needs
// zero usage (checked at apply under the advisory lock).

const V2: PlanVersionContent = {
  format: 1,
  plan: {
    key: 'aramo-sign-free-personal-v1',
    product_key: 'sign',
    name: 'Free',
    description: 'For individuals: 5 E-Signs a month (up to 2 a day) and 15 MB storage.',
    tenant_kind: 'PERSONAL',
    sales_model: 'FREE',
    list_price_minor: 0,
    currency: 'USD',
    reference_price_minor: null,
    reference_price_substantiated: false,
    billing_interval: 'MONTH',
    commitment_months: null,
    eligibility: null,
    support_tier: null,
  },
  allowances: [
    { allowance_key: 'sign.envelopes', included_quantity: 5, unlimited: false, period: 'MONTHLY' },
    { allowance_key: 'sign.forms', included_quantity: 5, unlimited: false, period: 'MONTHLY' },
  ],
  allowance_windows: [{ allowance_key: 'sign.envelopes', window_kind: 'DAY', limit_quantity: 2 }],
  capacities: [
    { capacity_key: 'sign.templates', limit_quantity: 0, unlimited: false },
    { capacity_key: 'sign.storage_bytes', limit_quantity: 15728640, unlimited: false },
  ],
  features: [],
};

describe('SIGN-FREE-PARITY-1 S1 FREE version adoption', () => {
  it('FP-A-1 v2 → v3 (DAY cap removed, forms dropped) is admissible: only the dropped forms allowance needs zero usage', () => {
    const v3 = applyCatalogDraftEdits(V2, { envelopes_per_day: null, remove_allowances: ['sign.forms'], description: 'For individuals: 5 E-Signs a month and 15 MB storage.' });
    const r = freeAdoptionRefusals(V2, v3);
    expect(r.refused).toEqual([]);
    expect(r.zeroUsageRequired.map((c) => c.key)).toEqual(['sign.forms']);
  });

  it('FP-A-2 a lowered monthly allowance, a tightened DAY cap or a lower storage is refused', () => {
    expect(freeAdoptionRefusals(V2, applyCatalogDraftEdits(V2, { envelopes_per_month: 3 })).refused.map((c) => c.key)).toEqual(['sign.envelopes']);
    expect(freeAdoptionRefusals(V2, applyCatalogDraftEdits(V2, { envelopes_per_day: 1 })).refused.map((c) => `${c.kind}:${c.key}`)).toEqual(['window:sign.envelopes']);
    expect(freeAdoptionRefusals(V2, applyCatalogDraftEdits(V2, { storage_bytes: 1024 })).refused.map((c) => c.key)).toEqual(['sign.storage_bytes']);
  });

  it('FP-A-3 a raised allowance is an improvement', () => {
    expect(freeAdoptionRefusals(V2, applyCatalogDraftEdits(V2, { envelopes_per_month: 10 }))).toEqual({ refused: [], zeroUsageRequired: [] });
  });

  it('FP-A-4 the publish payload accepts adopt_free_subscriptions: true only', () => {
    const id = '019a0000-5150-7000-8000-000000000099';
    expect(() => validatePayload('PLAN_VERSION_PUBLISH', { plan_version_id: id, [ADOPT_FREE_SUBSCRIPTIONS_KEY]: true })).not.toThrow();
    expect(() => validatePayload('PLAN_VERSION_PUBLISH', { plan_version_id: id, [ADOPT_FREE_SUBSCRIPTIONS_KEY]: false })).toThrow();
    expect(() => validatePayload('PLAN_VERSION_PUBLISH', { plan_version_id: id })).not.toThrow();
  });
});
