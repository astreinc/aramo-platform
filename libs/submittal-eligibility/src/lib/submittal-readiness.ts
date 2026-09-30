import {
  evaluateEligibility,
  type DocumentEligibilityInput,
  type EligibilityDenyCode,
  type EngagementEligibilityInput,
  type SubmittalPolicyInputs,
} from './submittal-eligibility.port.js';

// The engagement three-state applicability, resolved batch-wide upstream (the
// per-talent evidence read is NOT batched). A NEUTRAL enum — not a presentation
// type — so both the Requisition Talent Board and My Desk speak it directly.
export type SubmittalEngagementApplicability =
  | 'dormant'
  | 'policy_missing'
  | 'policy_present';

// The NEUTRAL readiness result. It carries the port's typed deny code plus the
// two orthogonal, non-policy conditions — never a display/presentation label.
// Each consumer maps this into its own vocabulary (board UI blockers, My Desk
// recruiter reasons).
export interface SubmittalReadinessResult {
  readonly band: 'ready_to_submit' | 'needs_action';
  // The eligibility port's typed deny code when a policy gate blocks (else null).
  readonly deny: EligibilityDenyCode | null;
  // Engagement is applicable but not batch-evaluable → readiness UNAVAILABLE
  // (never asserts Ready). A distinct honest condition, NOT a policy deny.
  readonly engagement_unavailable: boolean;
  // Orthogonal pre-check: a submit needs a selected résumé (not a policy gate).
  readonly resume_missing: boolean;
}

// dormant → satisfied (the real gate returns satisfied when not governed);
// policy_missing → the fail-closed deny (governed tenant, no effective policy);
// policy_present → NOT passed to the port; the caller records an explicit
// UNAVAILABLE result so readiness NEVER asserts Ready (the per-talent evidence
// read is not batched — never neutralized).
function engagementVerdict(
  applicability: SubmittalEngagementApplicability,
): EngagementEligibilityInput | undefined {
  switch (applicability) {
    case 'dormant':
      return { satisfied: true, deny: null };
    case 'policy_missing':
      return {
        satisfied: false,
        deny: 'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING',
        missing: [],
      };
    case 'policy_present':
      return undefined;
  }
}

// The NEUTRAL submittal-readiness derivation — the shared decision seam. It
// delegates the rule decision to `evaluateEligibility` (the ONE authority,
// TE-9) and copies NO policy. Both the Requisition Talent Board and My Desk
// compose this over the same injectable domain loaders (eligibility reader,
// document-readiness gate, restriction repo, engagement gate) then map the
// neutral result into their own display vocabulary. Invariant: READY ⟺ every
// applicable gate satisfied; engagement applicable-but-not-batch-evaluable →
// UNAVAILABLE (never a false-positive Ready). The submit transaction re-evaluates
// authoritatively at mutation time; this band is a truthful preflight.
export function deriveSubmittalReadiness(args: {
  policy: { inputs: SubmittalPolicyInputs; consumed_count: number };
  rtr_verdict: DocumentEligibilityInput | null;
  restriction_active: boolean;
  engagement: SubmittalEngagementApplicability;
  resume_selected: boolean;
  now: Date;
}): SubmittalReadinessResult {
  const engagement = engagementVerdict(args.engagement);
  const decision = evaluateEligibility(args.policy.inputs, {
    now: args.now,
    consumed_count: args.policy.consumed_count,
    restriction_active: args.restriction_active,
    ...(engagement !== undefined ? { engagement } : {}),
    ...(args.rtr_verdict !== null ? { document: args.rtr_verdict } : {}),
  });
  const deny =
    !decision.eligible && decision.deny !== undefined ? decision.deny : null;
  const engagement_unavailable = args.engagement === 'policy_present';
  const resume_missing = !args.resume_selected;
  const band =
    deny === null && !engagement_unavailable && !resume_missing
      ? 'ready_to_submit'
      : 'needs_action';
  return { band, deny, engagement_unavailable, resume_missing };
}
