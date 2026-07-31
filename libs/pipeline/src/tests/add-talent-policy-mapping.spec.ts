import { describe, expect, it } from 'vitest';
import { type Decision } from '@aramo/policy-engine';

import { isDecisionAllowed } from '../lib/policy/decision-mapping.js';

// PR-3 RULING — the four decision kinds map to allow/deny explicitly;
// REQUIRES_OVERRIDE is treated as DENY. An unhandled kind must not slip
// through as ALLOW. (The package-validity tests moved to apps/api with the
// package DATA — PR-4a relocated it out of libs/pipeline.)

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
