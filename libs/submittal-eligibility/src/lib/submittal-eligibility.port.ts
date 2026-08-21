// The neutral, versioned SubmittalEligibility PORT (base R-OQ5 / D3) — the pure
// decision contract both submit entry points reach through (never an
// inter-domain hard import). The atomic path (Approach A, §6) reads the
// FOR-UPDATE-locked policy row + consumed count + restriction state INSIDE the
// orchestrator's single interactive transaction, then calls `evaluateEligibility`
// (pure — no DB) for the authoritative decision. A non-transactional read face
// (the service) reuses the SAME pure function for UI pre-checks.
//
// TE-9: one decision authority, no duplicated logic. The port owns the semantic;
// callers pass typed inputs, not bare strings (the port-boundary coupling trap).

import type {
  SubmittalAuthorityValue,
  SubmittalWindowStatusValue,
} from './submittal-eligibility-vocab.js';

/** Versioned contract tag — bump on any breaking change to the shapes below. */
export const SUBMITTAL_ELIGIBILITY_PORT_VERSION = 'v1' as const;

/** The typed refusal codes — 1:1 with the registered ErrorCodes (D6). */
export type EligibilityDenyCode =
  | 'SUBMITTALS_CLOSED'
  | 'SUBMITTAL_WINDOW_PASSED'
  | 'SUBMITTAL_LIMIT_REACHED'
  | 'TALENT_RESTRICTED_AT_CLIENT';

/** Persisted policy INPUTS (absent policy ⇒ all null/undefined ⇒ default OPEN). */
export interface SubmittalPolicyInputs {
  readonly submittal_deadline: Date | null;
  readonly submittal_limit: number | null;
  readonly manual_override: SubmittalWindowStatusValue | null;
  readonly submittal_authority: SubmittalAuthorityValue;
}

/** The read state the decision needs, gathered under the tx lock (atomic path). */
export interface EligibilityContext {
  /** The instant to check against (passed in — never read from a clock here). */
  readonly now: Date;
  /** Rows already in SubmittalConsumption for this (tenant, requisition). */
  readonly consumed_count: number;
  /** True iff an active ClientTalentRestriction exists for this (client, talent). */
  readonly restriction_active: boolean;
}

/** The derived effective window status + why (for provenance + refusal mapping). */
export interface WindowStatusDerivation {
  readonly status: SubmittalWindowStatusValue;
  /** Present only when status !== OPEN — the discriminator for the refusal code. */
  readonly closed_by: 'MANUAL' | 'DEADLINE' | 'QUOTA' | 'PAUSED' | null;
}

export interface SubmittalEligibilityDecision {
  readonly eligible: boolean;
  readonly status: SubmittalWindowStatusValue;
  /** Present iff !eligible — the typed 4xx refusal code. */
  readonly deny?: EligibilityDenyCode;
}

/**
 * Derive the effective OPEN/CLOSED/PAUSED window status from persisted inputs.
 * manual_override wins; else a passed deadline or exhausted quota closes it;
 * else OPEN. PAUSED is only ever an explicit override. (base R5 / R-OQ3)
 */
export function deriveWindowStatus(
  inputs: SubmittalPolicyInputs,
  ctx: EligibilityContext,
): WindowStatusDerivation {
  if (inputs.manual_override !== null) {
    if (inputs.manual_override === 'OPEN') return { status: 'OPEN', closed_by: null };
    return {
      status: inputs.manual_override,
      closed_by: inputs.manual_override === 'PAUSED' ? 'PAUSED' : 'MANUAL',
    };
  }
  if (
    inputs.submittal_deadline !== null &&
    ctx.now.getTime() >= inputs.submittal_deadline.getTime()
  ) {
    return { status: 'CLOSED', closed_by: 'DEADLINE' };
  }
  if (
    inputs.submittal_limit !== null &&
    ctx.consumed_count >= inputs.submittal_limit
  ) {
    return { status: 'CLOSED', closed_by: 'QUOTA' };
  }
  return { status: 'OPEN', closed_by: null };
}

/**
 * The authoritative eligibility decision (pure). Gate order (base R5), steps
 * 3–6: status OPEN → deadline → slot → not client-restricted. Steps 1–2
 * (visibility, RecruitingStatus==open) are the orchestrator's responsibility
 * and are asserted before this is called.
 */
export function evaluateEligibility(
  inputs: SubmittalPolicyInputs,
  ctx: EligibilityContext,
): SubmittalEligibilityDecision {
  const { status, closed_by } = deriveWindowStatus(inputs, ctx);
  if (status !== 'OPEN') {
    const deny: EligibilityDenyCode =
      closed_by === 'DEADLINE'
        ? 'SUBMITTAL_WINDOW_PASSED'
        : closed_by === 'QUOTA'
          ? 'SUBMITTAL_LIMIT_REACHED'
          : 'SUBMITTALS_CLOSED'; // MANUAL or PAUSED
    return { eligible: false, status, deny };
  }
  if (ctx.restriction_active) {
    return { eligible: false, status, deny: 'TALENT_RESTRICTED_AT_CLIENT' };
  }
  return { eligible: true, status };
}
