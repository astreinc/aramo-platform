// @aramo/engagement — COMM-C3 Tenant Engagement Policy domain. Typed,
// provider-neutral engagement requirements; StoredPolicyVersion-backed versioned
// storage (via an injected gateway); TENANT→CLIENT→REQUISITION layered
// resolution; a PURE readiness evaluator over provider-neutral evidence facts. It
// never owns communication evidence, calls a provider, or mutates Pipeline/
// Submittal state. The raw persistence adapter is the apps/api composition root.

export { EngagementPolicyService } from './lib/engagement-policy.service.js';
export type {
  ResolvedEngagementPolicy,
  EngagementPolicyLayerRef,
  EngagementScopeContext,
  PublishEngagementPolicyInput,
  PublishedEngagementPolicy,
} from './lib/engagement-policy.service.js';

// Persistence port (adapter provided by apps/api, R12/R13).
export { ENGAGEMENT_POLICY_GATEWAY, ENGAGEMENT_PACKAGE_LIKE, engagementPackageName } from './lib/engagement-policy.gateway.js';
export type {
  EngagementPolicyGateway,
  StoredPolicyVersionRow,
  InsertEngagementVersionInput,
} from './lib/engagement-policy.gateway.js';

// Domain vocabulary + typed policy shape (R5/R6).
export {
  ENGAGEMENT_CHANNELS,
  ENGAGEMENT_EVIDENCE_STRENGTHS,
  ENGAGEMENT_POLICY_SCOPES,
  meetsStrength,
  requirementKey,
} from './lib/domain/engagement-vocab.js';
export type {
  EngagementChannel,
  EngagementEvidenceStrength,
  EngagementPolicyScope,
  EngagementRequirement,
  VoiceEngagementRequirement,
  EmailEngagementRequirement,
  EngagementPolicyDefinition,
} from './lib/domain/engagement-vocab.js';

// Validation + activation guard (R7).
export {
  validateEngagementPolicyDefinition,
  assertEngagementPolicyActivatable,
  EngagementPolicyValidationError,
} from './lib/domain/engagement-policy-validation.js';
export type { EngagementPolicyValidationErrorCode } from './lib/domain/engagement-policy-validation.js';

// Evidence capability (R7/C3-4).
export { isEvidenceChannelAvailable, evidenceCapabilities } from './lib/domain/evidence-capability.js';
export type { ChannelEvidenceCapability } from './lib/domain/evidence-capability.js';

// Pure readiness evaluator (R6/R9/C3-5).
export { evaluateEngagementReadiness } from './lib/domain/engagement-readiness.js';
export type {
  EngagementEvidenceFact,
  EngagementReadiness,
  EngagementRequirementResult,
  EngagementRequirementStatus,
  ResolvedEngagementRequirements,
} from './lib/domain/engagement-readiness.js';
