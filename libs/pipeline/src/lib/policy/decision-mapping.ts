import type { Decision } from '@aramo/policy-engine';

// The decision → enforcement disposition mapping (ADR-0024 §D9/§D11).
//
// PR-4b UN-COLLAPSES REQUIRES_OVERRIDE. Previously (PR-3) it was folded into
// DENY because no override framework existed; now it is a distinct THIRD state
// the command boundary resolves via the two-pass flow (membership test + reason
// capture). ALLOW / ALLOW_WITH_AUDIT permit the write; DENY refuses it;
// REQUIRES_OVERRIDE is neither — it is override-eligible.
//
// Exhaustive over the closed Decision union: an unhandled kind throws rather
// than silently permitting.
export type EnforcementDisposition = 'ALLOW' | 'DENY' | 'REQUIRES_OVERRIDE';

export function toEnforcementDisposition(decision: Decision): EnforcementDisposition {
  switch (decision) {
    case 'ALLOW':
    case 'ALLOW_WITH_AUDIT':
      return 'ALLOW';
    case 'DENY':
      return 'DENY';
    case 'REQUIRES_OVERRIDE':
      return 'REQUIRES_OVERRIDE';
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled decision kind: ${String(exhaustive)}`);
    }
  }
}
