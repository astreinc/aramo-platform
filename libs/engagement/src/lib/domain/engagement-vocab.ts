// COMM-C3 — the typed, provider-neutral engagement-policy vocabulary (directive
// R5/R6/R14). This domain module carries NO vendor vocabulary and NO provider
// keys/ids — an engagement requirement speaks only in CHANNEL + neutral evidence
// terms. It never imports Communications, a provider adapter, or the
// policy-engine evaluator. No scoring, no ranking, no free-form predicate DSL.

/** The channels a C3 policy may reference. SMS is NOT a C3 requirement (R5). */
export const ENGAGEMENT_CHANNELS = ['voice', 'email'] as const;
export type EngagementChannel = (typeof ENGAGEMENT_CHANNELS)[number];

/**
 * Voice evidence strength (mirrors the provider-neutral C2A projection, R6). The
 * array order IS the strength order (index = strength); PROVIDER_VERIFIED is
 * stronger than RECRUITER_ATTESTED. Comparison is typed + deterministic.
 */
export const ENGAGEMENT_EVIDENCE_STRENGTHS = ['RECRUITER_ATTESTED', 'PROVIDER_VERIFIED'] as const;
export type EngagementEvidenceStrength = (typeof ENGAGEMENT_EVIDENCE_STRENGTHS)[number];

/** True iff `have` is at least as strong as `required` (deterministic, R6). */
export function meetsStrength(
  have: EngagementEvidenceStrength | null,
  required: EngagementEvidenceStrength,
): boolean {
  if (have === null) return false;
  return (
    ENGAGEMENT_EVIDENCE_STRENGTHS.indexOf(have) >= ENGAGEMENT_EVIDENCE_STRENGTHS.indexOf(required)
  );
}

/** The scope layers of the effective-policy hierarchy (R11). Index = specificity. */
export const ENGAGEMENT_POLICY_SCOPES = ['TENANT', 'CLIENT', 'REQUISITION'] as const;
export type EngagementPolicyScope = (typeof ENGAGEMENT_POLICY_SCOPES)[number];

/**
 * COMM enforcement-mode enhancement (PART A) — how a published policy applies at
 * Submit to client. A domain-owned closed enum; NEVER free text and NEVER an
 * integration/provider concept.
 *   ADVISORY               — evaluate + warn, but do not block an otherwise-authorized submit.
 *   ENFORCING              — block until required evidence exists (the original C3 behavior).
 *   ENFORCING_WITH_OVERRIDE— block recruiters; an actor holding the override scope may
 *                            proceed with a recorded reason.
 */
export const ENGAGEMENT_ENFORCEMENT_MODES = ['ADVISORY', 'ENFORCING', 'ENFORCING_WITH_OVERRIDE'] as const;
export type EngagementEnforcementMode = (typeof ENGAGEMENT_ENFORCEMENT_MODES)[number];

/**
 * Backward-compatibility (A2, LOCKED) — a published/effective policy WITHOUT an
 * explicit enforcement_mode is HARD enforcement. A legacy policy is NEVER
 * reinterpreted as ADVISORY. This default is applied at resolution, so an
 * on-disk definition that predates the field keeps its original blocking behavior.
 */
export const DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE: EngagementEnforcementMode = 'ENFORCING';

/** True iff `mode` is a recognized enforcement mode (untrusted-JSON boundary guard). */
export function isEngagementEnforcementMode(mode: unknown): mode is EngagementEnforcementMode {
  return typeof mode === 'string' && (ENGAGEMENT_ENFORCEMENT_MODES as readonly string[]).includes(mode);
}

// A single typed requirement. Closed discriminated union on `channel` (R5). The
// `condition` is a closed enum per channel — never a free-form predicate.
export interface VoiceEngagementRequirement {
  readonly channel: 'voice';
  readonly required: boolean;
  readonly condition: 'two_way_conversation';
  readonly minimum_strength: EngagementEvidenceStrength;
}
export interface EmailEngagementRequirement {
  readonly channel: 'email';
  readonly required: boolean;
  readonly condition: 'recorded_evidence';
}
export type EngagementRequirement = VoiceEngagementRequirement | EmailEngagementRequirement;

/**
 * A typed engagement-policy definition — the JSON stored (opaque, checksummed) in
 * the reused StoredPolicyVersion.definition column. `scope`/`scope_ref` describe
 * which layer this document governs (TENANT has no ref; CLIENT→company_id;
 * REQUISITION→requisition_id). `requirements` is keyed logically by channel; at
 * most one requirement per channel in a single document.
 */
export interface EngagementPolicyDefinition {
  readonly schema_version: 1;
  readonly scope: EngagementPolicyScope;
  readonly scope_ref: string | null;
  readonly requirements: readonly EngagementRequirement[];
  /**
   * How this policy applies at Submit to client (PART A). OPTIONAL for
   * backward-compatibility (A2): an absent mode resolves to
   * DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE (ENFORCING) — never ADVISORY.
   */
  readonly enforcement_mode?: EngagementEnforcementMode;
}

/** The neutral requirement key used for merge + missing-list reporting (R11/R15). */
export function requirementKey(requirement: EngagementRequirement): EngagementChannel {
  return requirement.channel;
}
