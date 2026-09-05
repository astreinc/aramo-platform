import {
  ENGAGEMENT_CHANNELS,
  ENGAGEMENT_EVIDENCE_STRENGTHS,
  type EngagementPolicyDefinition,
  type EngagementRequirement,
} from './engagement-vocab.js';
import { isEvidenceChannelAvailable } from './evidence-capability.js';

// COMM-C3 — engagement-policy definition validation + the activation guard
// (directive C3-4/R7/§5). Pure: no I/O, no provider awareness. Rejects a
// definition that is structurally invalid, and — the R7 rule — rejects
// ACTIVATION/publication of a policy that REQUIRES a channel with no real
// evidence producer (e.g. email today). An unsatisfiable required channel is
// never silently published.

export type EngagementPolicyValidationErrorCode =
  | 'ENGAGEMENT_POLICY_SCHEMA_INVALID'
  | 'ENGAGEMENT_POLICY_NOT_ACTIVATABLE';

export class EngagementPolicyValidationError extends Error {
  constructor(
    readonly code: EngagementPolicyValidationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EngagementPolicyValidationError';
  }
}

/** Structural validation of a typed definition (shape only, provider-neutral). */
export function validateEngagementPolicyDefinition(def: EngagementPolicyDefinition): void {
  if (def.schema_version !== 1) {
    throw new EngagementPolicyValidationError(
      'ENGAGEMENT_POLICY_SCHEMA_INVALID',
      'unsupported engagement policy schema_version',
      { schema_version: def.schema_version },
    );
  }
  const seen = new Set<string>();
  for (const req of def.requirements) {
    if (!ENGAGEMENT_CHANNELS.includes(req.channel)) {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_SCHEMA_INVALID',
        `unsupported engagement channel: ${req.channel}`,
        { channel: req.channel },
      );
    }
    // At most one requirement per channel in a single document.
    if (seen.has(req.channel)) {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_SCHEMA_INVALID',
        `duplicate requirement for channel: ${req.channel}`,
        { channel: req.channel },
      );
    }
    seen.add(req.channel);
    validateRequirementShape(req);
  }
}

function validateRequirementShape(req: EngagementRequirement): void {
  // `condition` is a single-literal per channel in the typed union, so compare
  // through a widened alias — the incoming definition is untrusted JSON at the
  // validation boundary, and a literal comparison would narrow to `never`.
  const condition: string = req.condition;
  if (req.channel === 'voice') {
    if (condition !== 'two_way_conversation') {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_SCHEMA_INVALID',
        `unsupported voice condition: ${condition}`,
      );
    }
    const strength: string = req.minimum_strength;
    if (!ENGAGEMENT_EVIDENCE_STRENGTHS.includes(strength as never)) {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_SCHEMA_INVALID',
        `unsupported voice minimum_strength: ${strength}`,
      );
    }
  } else {
    // email
    if (condition !== 'recorded_evidence') {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_SCHEMA_INVALID',
        `unsupported email condition: ${condition}`,
      );
    }
  }
}

/**
 * R7 activation guard — a policy may CONTAIN a channel in its vocabulary, but it
 * MUST NOT be published/active while it REQUIRES a channel whose evidence
 * producer does not exist. `required: false` is always publishable.
 */
export function assertEngagementPolicyActivatable(def: EngagementPolicyDefinition): void {
  for (const req of def.requirements) {
    if (req.required && !isEvidenceChannelAvailable(req.channel)) {
      throw new EngagementPolicyValidationError(
        'ENGAGEMENT_POLICY_NOT_ACTIVATABLE',
        `channel "${req.channel}" is required but has no evidence producer yet; it cannot be activated`,
        { channel: req.channel },
      );
    }
  }
}
