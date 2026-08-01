import { describe, expect, it } from 'vitest';
import { type Decision } from '@aramo/policy-engine';

import { toEnforcementDisposition } from '../lib/policy/decision-mapping.js';

// ADR-0024 §D11 — PR-4b UN-COLLAPSES REQUIRES_OVERRIDE. The four engine verdicts
// map to THREE enforcement dispositions: ALLOW / ALLOW_WITH_AUDIT -> ALLOW;
// DENY -> DENY; REQUIRES_OVERRIDE is its own state (no longer folded into DENY).
// An unhandled kind must throw, never slip through as ALLOW.

describe('toEnforcementDisposition — every decision kind maps to a disposition', () => {
  it('ALLOW and ALLOW_WITH_AUDIT permit the write', () => {
    expect(toEnforcementDisposition('ALLOW')).toBe('ALLOW');
    expect(toEnforcementDisposition('ALLOW_WITH_AUDIT')).toBe('ALLOW');
  });

  it('DENY refuses the write', () => {
    expect(toEnforcementDisposition('DENY')).toBe('DENY');
  });

  it('REQUIRES_OVERRIDE is its OWN state (un-collapsed from DENY in PR-4b)', () => {
    expect(toEnforcementDisposition('REQUIRES_OVERRIDE')).toBe('REQUIRES_OVERRIDE');
  });

  it('covers the full closed Decision union (no unhandled kind)', () => {
    const kinds: Decision[] = ['ALLOW', 'DENY', 'REQUIRES_OVERRIDE', 'ALLOW_WITH_AUDIT'];
    for (const k of kinds) {
      expect(['ALLOW', 'DENY', 'REQUIRES_OVERRIDE']).toContain(
        toEnforcementDisposition(k),
      );
    }
  });
});
