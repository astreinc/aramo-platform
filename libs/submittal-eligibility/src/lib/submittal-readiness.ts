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
  // Orthogonal pre-check: a submit needs a selected resume (not a policy gate).
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

// ===========================================================================
// SW-3 (Decision 3) — the UNIFIED authoritative Submittal Readiness composition.
//
// One product-level authority over the read-evaluable gates, built ABOVE the
// narrow evaluateEligibility port (the port is NOT widened). It composes the SAME
// pure rules the submit command enforces, so the invariant holds BY CONSTRUCTION:
//
//   given unchanged authoritative state, status === 'READY'  =>  the submit command
//   cannot fail for submittal-state / pipeline-link / requisition-state / resume /
//   eligibility / engagement / RTR / client-policy.
//
// The ONE legitimate mutation-time exception is serialized slot consumption (the
// FOR UPDATE + consumption-ledger race) — represented here only as the PREDICTIVE
// quota/window status (the port's consumed_count >= limit), never as the
// authoritative consume. A real concurrent slot race may still fail the mutation.
//
// Each requirement carries a generic, FE-ready shape (what / why / where-from /
// how-to-resolve) so no consumer reimplements policy. The structural predicates
// (submittal-state, pipeline-link, requisition-submittable) are exported so the
// submit command enforces the IDENTICAL rule (no divergent second implementation).
// ===========================================================================

export type SubmittalRequirementKey =
  | 'submittal_state'
  | 'pipeline_link'
  | 'requisition_open'
  | 'resume_selected'
  | 'submittal_window'
  | 'client_restriction'
  | 'engagement'
  | 'rtr'
  | 'client_policy';

/** The domain a requirement's rule originates from (FE provenance, not policy). */
export type SubmittalRequirementSource =
  | 'submittal'
  | 'pipeline'
  | 'requisition'
  | 'documents'
  | 'submittal_policy'
  | 'client_talent_restriction'
  | 'engagement'
  | 'client_submittal_policy';

/**
 * A single read-evaluable readiness requirement. Generic + neutral: the FE renders
 * what is blocking, why, where the rule came from, and the action that resolves it,
 * without reproducing any rule. `deny_code` is the typed refusal the submit command
 * raises for this requirement when it blocks (1:1 with a registered ErrorCode).
 */
export interface SubmittalRequirement {
  readonly key: SubmittalRequirementKey;
  readonly label: string;
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly severity: 'blocking' | 'overridable' | 'info';
  readonly source: SubmittalRequirementSource;
  /** Human-neutral reason the requirement is unsatisfied (null when satisfied). */
  readonly reason: string | null;
  /** The action that resolves it (null when satisfied). */
  readonly remediation: string | null;
  /** The typed refusal code the submit mutation raises if this blocks (else null). */
  readonly deny_code: string | null;
}

export interface SubmittalReadiness {
  // READY = every required requirement satisfied. NEEDS_ACTION = only overridable
  // requirements remain. BLOCKED = at least one hard-blocking requirement unsatisfied.
  readonly status: 'READY' | 'NEEDS_ACTION' | 'BLOCKED';
  readonly requirements: readonly SubmittalRequirement[];
}

/** Why a submittal's Pipeline-episode link is invalid (null = valid). */
export type PipelineLinkReason =
  | 'missing'
  | 'not_found'
  | 'tenant_mismatch'
  | 'requisition_mismatch'
  | 'talent_mismatch'
  | 'not_live';

// --- Shared structural predicates (the submit command enforces the SAME ones) ---
//
// The submittal-state rule is NOT reimplemented here: its authority is
// `canTransitionSubmittal(state, 'submitted_to_client')` in @aramo/submittal, which
// the submit command already enforces. The caller resolves that verdict and passes
// it in as `submittal_state_can_send` (same discipline as the engagement/RTR/
// client-policy pre-verdicts) so there is exactly one state-machine implementation.

/** Requisition lifecycle: only an `open` requisition admits a new client submittal. */
export function isRequisitionSubmittable(status: string | null): boolean {
  return status === 'open';
}

/**
 * The submittal -> Pipeline-episode link rule. Pure: the caller supplies the linked
 * episode's identity + whether it is LIVE (computed via the Pipeline domain's
 * canonical isLiveStatus — NOT imported here, to keep this lib dependency-free).
 * Returns the first invalidating reason, or null when the link is valid + live.
 */
export function pipelineLinkVerdict(args: {
  readonly pipeline_id: string | null;
  readonly episode: {
    readonly tenant_id: string;
    readonly requisition_id: string;
    readonly talent_record_id: string;
  } | null;
  readonly episode_is_live: boolean;
  readonly expected: {
    readonly tenant_id: string;
    readonly requisition_id: string;
    readonly talent_id: string;
  };
}): { ok: boolean; reason: PipelineLinkReason | null } {
  if (args.pipeline_id === null) return { ok: false, reason: 'missing' };
  if (args.episode === null) return { ok: false, reason: 'not_found' };
  if (args.episode.tenant_id !== args.expected.tenant_id)
    return { ok: false, reason: 'tenant_mismatch' };
  if (args.episode.requisition_id !== args.expected.requisition_id)
    return { ok: false, reason: 'requisition_mismatch' };
  if (args.episode.talent_record_id !== args.expected.talent_id)
    return { ok: false, reason: 'talent_mismatch' };
  if (!args.episode_is_live) return { ok: false, reason: 'not_live' };
  return { ok: true, reason: null };
}

/**
 * The pre-resolved Client-Submittal-Policy verdict the caller supplies (the CSP
 * engine + any actor-override are resolved upstream, exactly as the submit command
 * does — readiness stays override-agnostic and pure). `applicable` false ⇒ no
 * published client policy (ungoverned tenant) ⇒ the requirement is satisfied/info.
 */
export interface ClientPolicyReadinessVerdict {
  readonly applicable: boolean;
  readonly satisfied: boolean;
  /** `CLIENT_SUBMITTAL_<KEY>_REQUIRED` when unsatisfied (else null). */
  readonly reason_code: string | null;
  /** True when the gate is satisfiable via a scope override (severity: overridable). */
  readonly overridable: boolean;
}

const WINDOW_DENY_CODES = new Set<EligibilityDenyCode>([
  'SUBMITTALS_CLOSED',
  'SUBMITTAL_WINDOW_PASSED',
  'SUBMITTAL_LIMIT_REACHED',
]);
const ENGAGEMENT_DENY_CODES = new Set<EligibilityDenyCode>([
  'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING',
  'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE',
  'CLIENT_SUBMITTAL_ENGAGEMENT_EVIDENCE_UNAVAILABLE',
]);

/**
 * The unified authoritative readiness computation. Ordered to match the submit
 * command's gate order (submittal-state -> pipeline-link -> requisition-open ->
 * resume -> eligibility[window -> restriction -> engagement -> RTR] -> client-policy)
 * so the FIRST blocking requirement is the code the submit mutation would raise.
 */
export function evaluateSubmittalReadiness(args: {
  readonly submittal_state: string;
  /** Authoritative verdict from canTransitionSubmittal(state,'submitted_to_client'). */
  readonly submittal_state_can_send: boolean;
  readonly pipeline: { ok: boolean; reason: PipelineLinkReason | null };
  readonly requisition_status: string | null;
  readonly resume_selected: boolean;
  readonly policy: { inputs: SubmittalPolicyInputs; consumed_count: number };
  readonly rtr_verdict: DocumentEligibilityInput | null;
  readonly restriction_active: boolean;
  readonly engagement: SubmittalEngagementApplicability;
  readonly client_policy: ClientPolicyReadinessVerdict | null;
  readonly now: Date;
}): SubmittalReadiness {
  const reqs: SubmittalRequirement[] = [];

  // 1 — submittal lifecycle state (authoritative verdict from canTransitionSubmittal).
  reqs.push({
    key: 'submittal_state',
    label: 'Submittal ready for review',
    required: true,
    satisfied: args.submittal_state_can_send,
    severity: 'blocking',
    source: 'submittal',
    reason: args.submittal_state_can_send
      ? null
      : `Submittal is '${args.submittal_state}', cannot transition to submitted_to_client`,
    remediation: args.submittal_state_can_send
      ? null
      : 'Complete preparation and mark the submittal ready for review',
    deny_code: 'SUBMITTAL_STATE_INVALID',
  });

  // 2 — live Pipeline-episode association.
  reqs.push({
    key: 'pipeline_link',
    label: 'Linked to a live pipeline episode',
    required: true,
    satisfied: args.pipeline.ok,
    severity: 'blocking',
    source: 'pipeline',
    reason: args.pipeline.ok ? null : `Pipeline link invalid: ${args.pipeline.reason}`,
    remediation: args.pipeline.ok
      ? null
      : 'The Talent must be in a live pipeline episode for this requisition',
    deny_code: 'SUBMITTAL_PIPELINE_LINK_INVALID',
  });

  // 3 — requisition open/submittable.
  reqs.push({
    key: 'requisition_open',
    label: 'Requisition open for submittals',
    required: true,
    satisfied: isRequisitionSubmittable(args.requisition_status),
    severity: 'blocking',
    source: 'requisition',
    reason: isRequisitionSubmittable(args.requisition_status)
      ? null
      : `Requisition status is '${args.requisition_status ?? 'absent'}', not 'open'`,
    remediation: isRequisitionSubmittable(args.requisition_status)
      ? null
      : 'Reopen the requisition before submitting to the client',
    deny_code: 'REQUISITION_NOT_OPEN',
  });

  // 4 — resume selected for this requisition.
  reqs.push({
    key: 'resume_selected',
    label: 'Resume selected for this requisition',
    required: true,
    satisfied: args.resume_selected,
    severity: 'blocking',
    source: 'documents',
    reason: args.resume_selected ? null : 'No resume edition selected for this requisition',
    remediation: args.resume_selected ? null : 'Select the resume edition to send to the client',
    deny_code: 'SUBMITTAL_RESUME_SELECTION_REQUIRED',
  });

  // 5 — eligibility port (window -> restriction -> engagement -> RTR). The port
  // returns the FIRST failing gate; map it onto per-gate requirements so the UI
  // sees which one blocks. Engagement applicable-but-not-batch-evaluable is an
  // honest UNAVAILABLE (never a false-positive Ready).
  const engagement = engagementVerdict(args.engagement);
  const decision = evaluateEligibility(args.policy.inputs, {
    now: args.now,
    consumed_count: args.policy.consumed_count,
    restriction_active: args.restriction_active,
    ...(engagement !== undefined ? { engagement } : {}),
    ...(args.rtr_verdict !== null ? { document: args.rtr_verdict } : {}),
  });
  const deny = !decision.eligible && decision.deny !== undefined ? decision.deny : null;
  const engagementUnavailable = args.engagement === 'policy_present';

  const windowDeny = deny !== null && WINDOW_DENY_CODES.has(deny) ? deny : null;
  reqs.push({
    key: 'submittal_window',
    label: 'Within the submittal window / quota',
    required: true,
    satisfied: windowDeny === null,
    severity: 'blocking',
    source: 'submittal_policy',
    reason: windowDeny === null ? null : `Submittal window/quota: ${windowDeny}`,
    remediation:
      windowDeny === null
        ? null
        : windowDeny === 'SUBMITTAL_LIMIT_REACHED'
          ? 'The requisition submittal limit is reached (predictive; the authoritative slot is consumed transactionally at submit)'
          : 'The submittal window is closed or past its deadline',
    deny_code: windowDeny ?? 'SUBMITTAL_WINDOW_PASSED',
  });

  reqs.push({
    key: 'client_restriction',
    label: 'No active client restriction',
    required: true,
    satisfied: deny !== 'TALENT_RESTRICTED_AT_CLIENT',
    severity: 'blocking',
    source: 'client_talent_restriction',
    reason:
      deny === 'TALENT_RESTRICTED_AT_CLIENT' ? 'An active client restriction blocks this Talent' : null,
    remediation:
      deny === 'TALENT_RESTRICTED_AT_CLIENT' ? 'Close the client-talent restriction, if appropriate' : null,
    deny_code: 'TALENT_RESTRICTED_AT_CLIENT',
  });

  const engagementDeny = deny !== null && ENGAGEMENT_DENY_CODES.has(deny) ? deny : null;
  reqs.push({
    key: 'engagement',
    label: 'Recruiting engagement evidence',
    required: true,
    satisfied: engagementDeny === null && !engagementUnavailable,
    severity: 'blocking',
    source: 'engagement',
    reason: engagementUnavailable
      ? 'Engagement policy applies; per-Talent evidence not resolved in this read'
      : engagementDeny === null
        ? null
        : `Engagement gate: ${engagementDeny}`,
    remediation:
      engagementDeny === null && !engagementUnavailable
        ? null
        : 'Record the required recruiting engagement evidence (e.g. a two-way interaction)',
    deny_code: engagementDeny ?? 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE',
  });

  reqs.push({
    key: 'rtr',
    label: 'Right to Represent executed',
    required: true,
    satisfied: deny !== 'SUBMITTAL_RTR_NOT_EXECUTED',
    severity: 'blocking',
    source: 'documents',
    reason: deny === 'SUBMITTAL_RTR_NOT_EXECUTED' ? 'A Right to Represent is required but not executed' : null,
    remediation: deny === 'SUBMITTAL_RTR_NOT_EXECUTED' ? 'Obtain an executed Right to Represent for this requisition' : null,
    deny_code: 'SUBMITTAL_RTR_NOT_EXECUTED',
  });

  // 6 — client-submittal policy (the configurable per-client layer). Pre-resolved
  // verdict; override-eligible gates are `overridable` (NEEDS_ACTION, not blocking).
  if (args.client_policy !== null && args.client_policy.applicable) {
    const cp = args.client_policy;
    reqs.push({
      key: 'client_policy',
      label: 'Client submittal policy requirements',
      required: true,
      satisfied: cp.satisfied,
      severity: cp.satisfied ? 'info' : cp.overridable ? 'overridable' : 'blocking',
      source: 'client_submittal_policy',
      reason: cp.satisfied ? null : `Client policy: ${cp.reason_code}`,
      remediation: cp.satisfied ? null : 'Satisfy the client-required fact, or proceed with a scoped override',
      deny_code: cp.reason_code,
    });
  }

  const unsatisfied = reqs.filter((r) => r.required && !r.satisfied);
  const status: SubmittalReadiness['status'] =
    unsatisfied.length === 0
      ? 'READY'
      : unsatisfied.some((r) => r.severity === 'blocking')
        ? 'BLOCKED'
        : 'NEEDS_ACTION';
  return { status, requirements: reqs };
}
