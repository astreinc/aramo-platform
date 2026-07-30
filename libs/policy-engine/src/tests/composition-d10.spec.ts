import { describe, expect, it } from 'vitest';

import {
  composeWithAuthorization,
  type AuthorizationVerdict,
} from '../lib/compose.js';
import type { Decision } from '../lib/types.js';

import { mkDecision } from './_helpers.js';

// ADR §D10 — Authorization first, policy second. The full monotonic table.
describe('§D10 composeWithAuthorization — the authorization × policy table', () => {
  const cases: ReadonlyArray<{
    authorization: AuthorizationVerdict;
    policy: Decision;
    expected: Decision;
  }> = [
    // DENY authorization dominates ANY policy verdict.
    { authorization: 'DENY', policy: 'ALLOW', expected: 'DENY' },
    { authorization: 'DENY', policy: 'DENY', expected: 'DENY' },
    { authorization: 'DENY', policy: 'REQUIRES_OVERRIDE', expected: 'DENY' },
    { authorization: 'DENY', policy: 'ALLOW_WITH_AUDIT', expected: 'DENY' },
    // ALLOW authorization defers to the policy verdict, unchanged.
    { authorization: 'ALLOW', policy: 'DENY', expected: 'DENY' },
    { authorization: 'ALLOW', policy: 'REQUIRES_OVERRIDE', expected: 'REQUIRES_OVERRIDE' },
    { authorization: 'ALLOW', policy: 'ALLOW_WITH_AUDIT', expected: 'ALLOW_WITH_AUDIT' },
    { authorization: 'ALLOW', policy: 'ALLOW', expected: 'ALLOW' },
  ];

  for (const c of cases) {
    it(`authz=${c.authorization} × policy=${c.policy} → ${c.expected}`, () => {
      const policyDecision = mkDecision(c.policy, {
        required_capabilities: c.policy === 'REQUIRES_OVERRIDE' ? ['cap.x'] : [],
      });
      const result = composeWithAuthorization(c.authorization, policyDecision);
      expect(result.decision).toBe(c.expected);
    });
  }

  it('an authorization DENY never grants authority — it drops effects and capabilities', () => {
    const policyDecision = mkDecision('REQUIRES_OVERRIDE', {
      required_capabilities: ['cap.x'],
      effects: [{ kind: 'WRITE_AUDIT' }],
    });
    const result = composeWithAuthorization('DENY', policyDecision);
    expect(result.decision).toBe('DENY');
    expect(result.reason_code).toBe('AUTHORIZATION_DENIED');
    expect(result.required_capabilities).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result.override_required).toBe(false);
  });

  it('an authorization ALLOW preserves the policy decision exactly', () => {
    const policyDecision = mkDecision('ALLOW_WITH_AUDIT', {
      effects: [{ kind: 'WRITE_AUDIT' }],
    });
    const result = composeWithAuthorization('ALLOW', policyDecision);
    expect(result).toBe(policyDecision);
    expect(result.audit_required).toBe(true);
  });
});
