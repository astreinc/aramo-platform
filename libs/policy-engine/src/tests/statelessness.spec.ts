import { describe, expect, it } from 'vitest';

import { composePolicyDecisions } from '../lib/compose.js';
import { evaluate } from '../lib/evaluate.js';
import type { PolicyContext, PolicyPackage, Rule } from '../lib/types.js';

import { ctx, deepFreeze, mkDecision, pkg } from './_helpers.js';

// ADR §D7/§D15 — the engine is stateless and mutates nothing. It writes no
// storage and does not alter its own inputs.
describe('statelessness — inputs are never mutated', () => {
  const rules: Rule[] = [
    {
      id: 'a',
      resource: 'DOC',
      action: 'CREATE',
      when: [{ source: 'derived', key: 'balance', op: 'lte', value: 0 }],
      decision: 'REQUIRES_OVERRIDE',
      reason_code: 'AT_CAPACITY',
      required_capability: 'cap.x',
      effects: [{ kind: 'WRITE_AUDIT' }],
    },
  ];

  it('evaluate does not mutate a deep-frozen package or context', () => {
    const p: PolicyPackage = deepFreeze(pkg(rules));
    const c: PolicyContext = deepFreeze(
      ctx({ resource_state: { declared: { status: 'x' }, derived: { balance: 0 } } }),
    );
    // If evaluate wrote to any input, a strict-mode frozen-object assignment
    // would throw here.
    expect(() => evaluate(p, c)).not.toThrow();
    const out = evaluate(p, c);
    expect(out.decision).toBe('REQUIRES_OVERRIDE');
  });

  it('the package and context are structurally unchanged after evaluate', () => {
    const p = pkg(rules);
    const c = ctx({ resource_state: { declared: {}, derived: { balance: 0 } } });
    const pBefore = JSON.stringify(p);
    const cBefore = JSON.stringify(c);
    evaluate(p, c);
    expect(JSON.stringify(p)).toBe(pBefore);
    expect(JSON.stringify(c)).toBe(cBefore);
  });

  it('composePolicyDecisions does not mutate its input decisions', () => {
    const inputs = [
      mkDecision('ALLOW_WITH_AUDIT', { effects: [{ kind: 'WRITE_AUDIT' }] }),
      mkDecision('REQUIRES_OVERRIDE', { required_capabilities: ['cap.a'] }),
    ];
    const before = JSON.stringify(inputs);
    composePolicyDecisions(inputs);
    expect(JSON.stringify(inputs)).toBe(before);
  });
});
