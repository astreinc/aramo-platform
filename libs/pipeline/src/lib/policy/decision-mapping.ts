import type { Decision } from '@aramo/policy-engine';

// The PR-3 decision→enforcement mapping (ADR-0024). ALLOW / ALLOW_WITH_AUDIT
// permit the write; DENY / REQUIRES_OVERRIDE refuse it (PR-3 RULING —
// REQUIRES_OVERRIDE is treated as DENY; the override framework is PR-4).
// Exhaustive over the closed Decision union: an unhandled kind throws rather
// than silently permitting.
//
// PR-3a: inert. Nothing routes through this yet — the consumer (controller /
// repository) that calls it lands in PR-3.
export function isDecisionAllowed(decision: Decision): boolean {
  switch (decision) {
    case 'ALLOW':
    case 'ALLOW_WITH_AUDIT':
      return true;
    case 'DENY':
    case 'REQUIRES_OVERRIDE':
      return false;
    default: {
      const exhaustive: never = decision;
      throw new Error(`unhandled decision kind: ${String(exhaustive)}`);
    }
  }
}
