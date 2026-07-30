import { describe, expect, it } from 'vitest';

import { evaluate } from '../lib/evaluate.js';
import type { Rule } from '../lib/types.js';

import { ctx, pkg } from './_helpers.js';

// Determinism (ADR §D12 "the same immutable context snapshot"): identical
// (package, context) inputs always yield an identical decision. The engine
// consults no clock and no randomness, so equal inputs → equal outputs.
describe('determinism', () => {
  const rules: Rule[] = [
    {
      id: 'a',
      resource: 'DOC',
      action: 'CREATE',
      when: [{ source: 'derived', key: 'balance', op: 'lte', value: 0 }],
      decision: 'REQUIRES_OVERRIDE',
      reason_code: 'AT_CAPACITY',
      required_capability: 'cap.x',
      effects: [{ kind: 'WRITE_AUDIT' }, { kind: 'REQUIRE_REASON' }],
    },
    { id: 'b', resource: 'DOC', action: 'CREATE', decision: 'ALLOW_WITH_AUDIT', reason_code: 'SOFT', effects: [{ kind: 'WRITE_AUDIT' }] },
  ];

  it('identical inputs yield a byte-identical decision', () => {
    const p = pkg(rules);
    const c = ctx({ resource_state: { declared: {}, derived: { balance: 0 } } });
    const first = evaluate(p, c);
    const second = evaluate(p, c);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('effect union order is stable across runs', () => {
    const p = pkg(rules);
    const c = ctx({ resource_state: { declared: {}, derived: { balance: 0 } } });
    const a = evaluate(p, c).effects.map((e) => e.kind);
    const b = evaluate(p, c).effects.map((e) => e.kind);
    expect(a).toEqual(b);
  });
});
