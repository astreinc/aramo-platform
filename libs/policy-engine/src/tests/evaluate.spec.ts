import { describe, expect, it } from 'vitest';

import { evaluate } from '../lib/evaluate.js';
import type { Rule } from '../lib/types.js';

import { ctx, pkg } from './_helpers.js';

describe('evaluate — single-package rule selection', () => {
  it('a package with no matching rule is silent → ALLOW', () => {
    const out = evaluate(pkg([]), ctx());
    expect(out.decision).toBe('ALLOW');
    expect(out.reason_code).toBe('NO_POLICY');
  });

  it('matches on resource AND action', () => {
    const rules: Rule[] = [
      { id: 'a', resource: 'DOC', action: 'DELETE', decision: 'DENY', reason_code: 'NO_DELETE' },
      { id: 'b', resource: 'WIDGET', action: 'CREATE', decision: 'DENY', reason_code: 'WRONG' },
    ];
    const out = evaluate(pkg(rules), ctx({ resource: 'DOC', action: 'DELETE' }));
    expect(out.decision).toBe('DENY');
    expect(out.reason_code).toBe('NO_DELETE');
    expect(out.provenance).toEqual([{ policy_version: 'v1', rule_id: 'a' }]);
  });

  it('applies a declared-state predicate', () => {
    const rules: Rule[] = [
      {
        id: 'locked',
        resource: 'DOC',
        action: 'CREATE',
        when: [{ source: 'declared', key: 'status', op: 'eq', value: 'locked' }],
        decision: 'DENY',
        reason_code: 'IS_LOCKED',
      },
    ];
    const p = pkg(rules);
    const denied = evaluate(p, ctx({ resource_state: { declared: { status: 'locked' }, derived: {} } }));
    expect(denied.decision).toBe('DENY');
    const allowed = evaluate(p, ctx({ resource_state: { declared: { status: 'open' }, derived: {} } }));
    expect(allowed.decision).toBe('ALLOW');
  });

  it('applies a derived-fact predicate independent of any declared label (§D13)', () => {
    const rules: Rule[] = [
      {
        id: 'over',
        resource: 'DOC',
        action: 'CREATE',
        when: [{ source: 'derived', key: 'balance', op: 'lte', value: 0 }],
        decision: 'REQUIRES_OVERRIDE',
        reason_code: 'AT_CAPACITY',
        required_capability: 'cap.override.capacity',
      },
    ];
    const p = pkg(rules);
    const over = evaluate(p, ctx({ resource_state: { declared: {}, derived: { balance: 0 } } }));
    expect(over.decision).toBe('REQUIRES_OVERRIDE');
    expect(over.required_capabilities).toEqual(['cap.override.capacity']);
    const under = evaluate(p, ctx({ resource_state: { declared: {}, derived: { balance: 3 } } }));
    expect(under.decision).toBe('ALLOW');
  });

  it('reads a resolved capability boolean, never a role', () => {
    const rules: Rule[] = [
      {
        id: 'cap',
        resource: 'DOC',
        action: 'PUBLISH',
        when: [{ source: 'capabilities', key: 'can_publish', op: 'eq', value: false }],
        decision: 'DENY',
        reason_code: 'NO_PUBLISH',
      },
    ];
    const p = pkg(rules);
    const blocked = evaluate(p, ctx({ action: 'PUBLISH', principal_capabilities: { can_publish: false } }));
    expect(blocked.decision).toBe('DENY');
    const ok = evaluate(p, ctx({ action: 'PUBLISH', principal_capabilities: { can_publish: true } }));
    expect(ok.decision).toBe('ALLOW');
  });

  it('derives audit_required / reason_required from an ALLOW_WITH_AUDIT rule', () => {
    const rules: Rule[] = [
      {
        id: 'audit',
        resource: 'DOC',
        action: 'CREATE',
        decision: 'ALLOW_WITH_AUDIT',
        reason_code: 'RECORDED',
        effects: [{ kind: 'WRITE_AUDIT' }, { kind: 'REQUIRE_REASON' }],
      },
    ];
    const out = evaluate(pkg(rules), ctx());
    expect(out.decision).toBe('ALLOW_WITH_AUDIT');
    expect(out.audit_required).toBe(true);
    expect(out.reason_required).toBe(true);
  });

  it('composes multiple matching rules within a package (most restrictive)', () => {
    const rules: Rule[] = [
      { id: 'soft', resource: 'DOC', action: 'CREATE', decision: 'ALLOW_WITH_AUDIT', reason_code: 'SOFT' },
      {
        id: 'hard',
        resource: 'DOC',
        action: 'CREATE',
        decision: 'REQUIRES_OVERRIDE',
        reason_code: 'HARD',
        required_capability: 'cap.x',
      },
    ];
    const out = evaluate(pkg(rules), ctx());
    expect(out.decision).toBe('REQUIRES_OVERRIDE');
    expect(out.reason_code).toBe('HARD');
    expect(out.provenance).toHaveLength(2);
  });
});
