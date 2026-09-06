import type { EngagementChannel, EngagementEnforcementMode } from './engagement-vocab.js';
import type { EngagementReadiness } from './engagement-readiness.js';

// COMM enforcement-mode enhancement (PART A) — the PURE engagement decision. It
// maps (enforcement_mode × readiness × override request) to a typed outcome. NO
// I/O, NO provider awareness, NO scope lookup (the caller resolves whether the
// actor holds the override scope and passes a boolean). This is the single place
// that encodes ADVISORY / ENFORCING / ENFORCING_WITH_OVERRIDE semantics so the
// gate, tests, and provenance all agree.

/** Bounds for an override reason (A7): non-empty, human-entered, length-bounded. */
export const ENGAGEMENT_OVERRIDE_REASON_MIN = 1;
export const ENGAGEMENT_OVERRIDE_REASON_MAX = 1000;

export type EngagementDecisionOutcome =
  | 'ALLOW_SATISFIED' // requirements satisfied → allow
  | 'ALLOW_ADVISORY' // advisory mode, requirements incomplete → allow with warning
  | 'ALLOW_OVERRIDDEN' // enforcing-with-override, a valid override was applied → allow
  | 'BLOCK_INCOMPLETE' // enforcing(-with-override), required evidence missing → block
  | 'BLOCK_UNAVAILABLE' // required evidence read failed (distinct fail-closed) → block
  | 'BLOCK_OVERRIDE_INVALID'; // override attempted but not authorized / no reason / nothing to override

/** What the caller resolved about a possible override at submit time. */
export interface EngagementOverrideRequest {
  /** The actor explicitly requested an override on this submit. */
  readonly requested: boolean;
  /** The actor holds the `engagement:policy:override` scope (resolved by the caller). */
  readonly actorHasOverrideScope: boolean;
  /** The human-entered reason (trimmed by the caller); null when none supplied. */
  readonly reason: string | null;
}

export interface EngagementDecision {
  readonly outcome: EngagementDecisionOutcome;
  /** The submit may proceed (satisfied, advisory-proceed, or overridden). */
  readonly allow: boolean;
  /** Requirements are NOT satisfied but the submit proceeds (advisory or override). */
  readonly proceededIncomplete: boolean;
  /** A valid override was applied (⇒ allow, ⇒ audit carries the reason). */
  readonly overridden: boolean;
  readonly enforcementMode: EngagementEnforcementMode;
  /** Bounded, non-sensitive required-and-unsatisfied channels. */
  readonly missing: readonly EngagementChannel[];
  /** The override reason to persist (only when overridden); never fabricated. */
  readonly overrideReason: string | null;
}

/** Whether a reason string is a valid override reason (A7). */
export function isValidOverrideReason(reason: string | null): reason is string {
  if (reason === null) return false;
  const len = reason.trim().length;
  return len >= ENGAGEMENT_OVERRIDE_REASON_MIN && len <= ENGAGEMENT_OVERRIDE_REASON_MAX;
}

/**
 * Decide the engagement outcome for a resolved policy's readiness under its
 * enforcement mode. `readiness` is the pure readiness result for the effective
 * policy; `mode` is the resolved effective enforcement mode (legacy default already
 * applied upstream). `override` describes any override the actor requested.
 *
 * Invariants:
 *  - Satisfied requirements always ALLOW, regardless of mode (override is inert).
 *  - ADVISORY never blocks; it proceeds-incomplete and the caller must warn.
 *  - ENFORCING always blocks on unsatisfied/ unavailable evidence.
 *  - ENFORCING_WITH_OVERRIDE blocks UNLESS a valid override (scope + reason) is
 *    applied against genuinely-missing requirements; it never fabricates evidence.
 *  - `unavailable` (read error) is a distinct block and is NOT overridable via the
 *    normal missing-evidence override (fail-closed on a broken evidence read).
 */
export function decideEngagement(
  readiness: EngagementReadiness,
  mode: EngagementEnforcementMode,
  override: EngagementOverrideRequest,
): EngagementDecision {
  const base = {
    enforcementMode: mode,
    missing: readiness.missing,
    overrideReason: null as string | null,
  };

  if (readiness.satisfied) {
    return { ...base, outcome: 'ALLOW_SATISFIED', allow: true, proceededIncomplete: false, overridden: false };
  }

  // A read error is fail-closed and never advisory/overridable — a broken evidence
  // read must not be waved through as "advisory incomplete" or overridden.
  if (readiness.unavailable) {
    return { ...base, outcome: 'BLOCK_UNAVAILABLE', allow: false, proceededIncomplete: false, overridden: false };
  }

  if (mode === 'ADVISORY') {
    return { ...base, outcome: 'ALLOW_ADVISORY', allow: true, proceededIncomplete: true, overridden: false };
  }

  if (mode === 'ENFORCING_WITH_OVERRIDE' && override.requested) {
    // Override is authorized ONLY with the scope, a valid reason, and something
    // genuinely missing to override. Otherwise it is a rejected override, not a pass.
    if (override.actorHasOverrideScope && isValidOverrideReason(override.reason) && readiness.missing.length > 0) {
      return {
        ...base,
        outcome: 'ALLOW_OVERRIDDEN',
        allow: true,
        proceededIncomplete: true,
        overridden: true,
        overrideReason: override.reason.trim(),
      };
    }
    return { ...base, outcome: 'BLOCK_OVERRIDE_INVALID', allow: false, proceededIncomplete: false, overridden: false };
  }

  // ENFORCING, or ENFORCING_WITH_OVERRIDE with no override attempted → block.
  return { ...base, outcome: 'BLOCK_INCOMPLETE', allow: false, proceededIncomplete: false, overridden: false };
}
