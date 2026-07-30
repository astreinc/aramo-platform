import { describe, expect, it } from 'vitest';
import { validatePackage, type Decision } from '@aramo/policy-engine';

import { isDecisionAllowed } from '../lib/policy/decision-mapping.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../lib/policy/requisition-lifecycle.package.js';

// PR-3 RULING — the four decision kinds map to allow/deny explicitly;
// REQUIRES_OVERRIDE is treated as DENY. An unhandled kind must not slip
// through as ALLOW.

describe('isDecisionAllowed — every decision kind is handled', () => {
  it('ALLOW and ALLOW_WITH_AUDIT permit the write', () => {
    expect(isDecisionAllowed('ALLOW')).toBe(true);
    expect(isDecisionAllowed('ALLOW_WITH_AUDIT')).toBe(true);
  });

  it('DENY and REQUIRES_OVERRIDE refuse the write (REQUIRES_OVERRIDE treated as DENY in PR-3)', () => {
    expect(isDecisionAllowed('DENY')).toBe(false);
    expect(isDecisionAllowed('REQUIRES_OVERRIDE')).toBe(false);
  });

  it('covers the full closed Decision union (no unhandled kind)', () => {
    const kinds: Decision[] = ['ALLOW', 'DENY', 'REQUIRES_OVERRIDE', 'ALLOW_WITH_AUDIT'];
    // Every kind resolves to a boolean without throwing.
    for (const k of kinds) {
      expect(typeof isDecisionAllowed(k)).toBe('boolean');
    }
  });
});

describe('REQUISITION_LIFECYCLE_PACKAGE — permissive by ruling, structurally valid', () => {
  it('passes the engine shape validation', () => {
    expect(() => validatePackage(REQUISITION_LIFECYCLE_PACKAGE)).not.toThrow();
  });

  it('declares one ALLOW row for each of the six requisition states', () => {
    const states = REQUISITION_LIFECYCLE_PACKAGE.rules.map((r) => r.when?.[0]?.value);
    expect(states.sort()).toEqual(['active', 'canceled', 'closed', 'full', 'lead', 'on_hold']);
    expect(REQUISITION_LIFECYCLE_PACKAGE.rules.every((r) => r.decision === 'ALLOW')).toBe(true);
    expect(REQUISITION_LIFECYCLE_PACKAGE.default_disposition.decision).toBe('ALLOW');
  });

  it('governs exactly REQUISITION_TALENT · ADD', () => {
    expect(REQUISITION_LIFECYCLE_PACKAGE.registry.resources).toEqual(['REQUISITION_TALENT']);
    expect(REQUISITION_LIFECYCLE_PACKAGE.registry.actions).toEqual(['ADD']);
  });
});
