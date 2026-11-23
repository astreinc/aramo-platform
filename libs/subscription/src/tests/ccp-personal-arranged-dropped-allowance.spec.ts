import { describe, expect, it } from 'vitest';

import { changedTerms, undefinedTermTreatment } from '../lib/commercial/commercial-apply.service.js';
import type { PlanVersionContent } from '../lib/plan-version.js';

// CCP-PERSONAL-ARRANGED-1 P-1 — the dropped-allowance treatment of a FREE replacement (typed divergence from
// recon §2.2: the published Free Personal version carries sign.forms, which Personal Standard does not).
// A dropped allowance is admissible on zero usage ONLY when the replaced row is FREE; a changed period
// kind, and every drop on any other replacement, stays refused (USAGE_TREATMENT_UNDEFINED).

const version = (allowances: Array<{ key: string; q: number | null; period?: string }>): PlanVersionContent =>
  ({
    format: 1,
    plan: {},
    allowances: allowances.map((a) => ({ allowance_key: a.key, included_quantity: a.q, unlimited: a.q === null, period: a.period ?? 'MONTHLY' })),
    allowance_windows: [],
    capacities: [],
    features: [],
  }) as unknown as PlanVersionContent;

// The production shapes: Free Personal v2 (envelopes 5 + forms 5), Personal Standard v5 (envelopes 50).
const FREE = version([
  { key: 'sign.envelopes', q: 5 },
  { key: 'sign.forms', q: 5 },
]);
const STANDARD = version([{ key: 'sign.envelopes', q: 50 }]);

describe('CCP-PERSONAL-ARRANGED-1 P-1 undefinedTermTreatment', () => {
  it('ARR-U-DROP-1 a FREE replacement: the dropped sign.forms needs zero usage; nothing is refused outright', () => {
    const changes = changedTerms(FREE, STANDARD);
    expect(changes).toEqual([{ kind: 'allowance', key: 'sign.forms', change: 'undefined', new_limit: null }]);
    expect(undefinedTermTreatment(changes, STANDARD, 'FREE')).toEqual({ refused: [], zeroUsageRequired: [changes[0]] });
  });

  it('ARR-U-DROP-2 any other replaced source (MANUAL, DEVELOPMENT, none) keeps the drop refused, as before', () => {
    const changes = changedTerms(FREE, STANDARD);
    for (const source of ['MANUAL', 'DEVELOPMENT', 'SELF_SERVICE', null]) {
      expect(undefinedTermTreatment(changes, STANDARD, source), String(source)).toEqual({ refused: changes, zeroUsageRequired: [] });
    }
  });

  it('ARR-U-DROP-3 a changed period kind is refused even for a FREE replacement (only a drop is admitted)', () => {
    const to = version([
      { key: 'sign.envelopes', q: 50, period: 'ANNUAL' },
      { key: 'sign.forms', q: 5 },
    ]);
    const changes = changedTerms(FREE, to);
    expect(changes).toEqual([{ kind: 'allowance', key: 'sign.envelopes', change: 'undefined', new_limit: null }]);
    expect(undefinedTermTreatment(changes, to, 'FREE')).toEqual({ refused: changes, zeroUsageRequired: [] });
  });

  it('ARR-U-DROP-4 lowered terms are left to the usage check; several drops are returned in key order', () => {
    const from = version([
      { key: 'sign.zeta', q: 1 },
      { key: 'sign.envelopes', q: 5 },
      { key: 'sign.alpha', q: 1 },
    ]);
    const to = version([{ key: 'sign.envelopes', q: 2 }]);
    const changes = changedTerms(from, to);
    const r = undefinedTermTreatment(changes, to, 'FREE');
    expect(r.refused).toEqual([]);
    expect(r.zeroUsageRequired.map((c) => c.key)).toEqual(['sign.alpha', 'sign.zeta']);
    expect(changes.find((c) => c.key === 'sign.envelopes')).toMatchObject({ change: 'lowered', new_limit: 2 });
  });
});
