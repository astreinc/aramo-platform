// Public barrel — libs/placement (Track 3 / E1-a, PlacementProcess Spine).

// Persistence.
export { PrismaService } from './lib/prisma/prisma.service.js';
export { PlacementRepository } from './lib/placement.repository.js';
export type { ConvertToPermanentResult } from './lib/placement.repository.js';
export { PlacementProcessEventRepository } from './lib/placement-process-event.repository.js';
export { PlacementEventReadModule } from './lib/placement-event-read.module.js';
export { AssignmentPipelineReadRepository } from './lib/assignment-pipeline-read.repository.js';
export type { AssignmentPipelineSnapshot } from './lib/assignment-pipeline-read.repository.js';
export { PlacementPipelineReadModule } from './lib/placement-pipeline-read.module.js';
// Track 7 / T7-P4 — the placement-owned guarantee-exposure reporting aggregate + its read module.
export { GuaranteeExposureReadRepository } from './lib/guarantee-exposure-read.repository.js';
export type { GuaranteeExposureSnapshot } from './lib/guarantee-exposure-read.repository.js';
export { GuaranteeExposureReadModule } from './lib/guarantee-exposure-read.module.js';
// T9-B4 — placement-owned current-snapshot commercial margin read boundary.
export { CommercialMarginReadRepository } from './lib/commercial-margin-read.repository.js';
export type {
  CommercialMarginGroup,
  CommercialMarginSnapshot,
} from './lib/commercial-margin-read.repository.js';
export { CommercialMarginReadModule } from './lib/commercial-margin-read.module.js';
// Track 7 / T7-P1 — the PermanentPlacement aggregate repository (read + happy-path
// guarantee lifecycle) and its governed guarantee-terms validation.
export { PermanentPlacementRepository } from './lib/permanent/permanent-placement.repository.js';
export { validateGuaranteeTerms } from './lib/permanent/guarantee-validation.js';
export type { ValidatedGuaranteeSnapshot } from './lib/permanent/guarantee-validation.js';
// E1-c — placement outbox drain surface + its module (consumed by outbox-publisher).
export { PlacementOutboxRepository } from './lib/placement-outbox.repository.js';
export type { UnpublishedOutboxEvent } from './lib/placement-outbox.repository.js';
export { PlacementOutboxModule } from './lib/placement-outbox.module.js';

// Typed lifecycle registry — the single source of truth for the state machine
// (the migration SQL is generated from it).
export {
  PLACEMENT_STATES,
  INITIAL_STATE,
  LIFECYCLE_POSITIONS,
  STATE_POSITION,
  TRANSITIONS,
  LEGAL_TRANSITIONS,
  TRANSITION_TERMINAL,
  DUPLICATE_GUARD_INACTIVE,
  canTransition,
  canTransitionTyped,
  lifecyclePositionOf,
  PLACEMENT_AUTHORITY_CLASSES,
  edgeAuthorityClass,
  // Track 7 / T7-P1 — the permanent-placement guarantee lifecycle + branch/remedy
  // vocabularies (the runtime companions of the Postgres enums; typed-map enforced).
  PLACEMENT_KINDS,
  PERMANENT_PLACEMENT_STATES,
  PERMANENT_PLACEMENT_INITIAL_STATE,
  PERMANENT_PLACEMENT_TRANSITIONS,
  canTransitionPermanentPlacement,
  REMEDY_POLICIES,
  // Track 7 / T7-P2 — remedy-due states + the deterministic policy->due-state map.
  REMEDY_DUE_STATES,
  REMEDY_POLICY_TO_DUE_STATE,
  dueStateForRemedyPolicy,
} from './lib/lifecycle/placement-lifecycle.js';
export type {
  PlacementState,
  LifecyclePosition,
  LegalTarget,
  PlacementTransition,
  PlacementAuthorityClass,
  PermanentPlacementState,
  RemedyPolicy,
  RemedyDueState,
} from './lib/lifecycle/placement-lifecycle.js';
// Track 7 / T7-P2 — the closed permanent-falloff reason registry + remedy computation.
export {
  PERMANENT_FALLOFF_REASON_CODES,
  isPermanentFalloffReasonCode,
} from './lib/reasons/permanent-falloff-reasons.js';
export type { PermanentFalloffReasonCode } from './lib/reasons/permanent-falloff-reasons.js';
export { computeRemedyObligation, calendarDaysBetween } from './lib/permanent/remedy-computation.js';
export type { RemedyObligation } from './lib/permanent/remedy-computation.js';

// Track 7 / T7-P3 — the reusable guarantee-term-versioning source (create/revise/resolve),
// its closed provenance registry, and the version types.
export {
  GuaranteeTermRepository,
  resolveEffectiveTermRow,
  resolvedTermsFromRow,
  OUTBOX_GUARANTEE_TERMS_CREATED,
  OUTBOX_GUARANTEE_TERMS_REVISED,
  OUTBOX_GUARANTEE_TERMS_APPLIED,
} from './lib/permanent/guarantee-term.repository.js';
export type { GuaranteeTermVersionRow } from './lib/permanent/guarantee-term.repository.js';
export {
  GUARANTEE_TERMS_SOURCE_TYPES,
  isGuaranteeTermsSourceType,
} from './lib/permanent/guarantee-terms-source.js';
export type { GuaranteeTermsSourceType } from './lib/permanent/guarantee-terms-source.js';
export { parseTermCalendarDate } from './lib/permanent/guarantee-term-version.js';
export type {
  GuaranteeTermVersionView,
  CreateGuaranteeTermVersionInput,
  ReviseGuaranteeTermVersionInput,
  ResolvedGuaranteeTerms,
} from './lib/permanent/guarantee-term-version.js';

// SQL generator (§5c/§5d) — registry → typed AST → migration SQL.
export {
  generatePlacementMigrationSql,
  buildPlacementMigrationModel,
} from './lib/generator/placement-sql-generator.js';

// E3 — the fallthrough/terminal reason registry (code-backed, PO-ratified) and
// its taxonomy-neutral classifier.
export {
  PLACEMENT_REASONS,
  REASON_DETAIL_POLICIES,
  REASON_STATUSES,
  REASON_DETAIL_MAX,
  REASON_REJECTION_REASONS,
  GOVERNED_TERMINAL_TARGETS,
  isGovernedTerminalTarget,
  getReason,
  activeReasonsForTarget,
  normalizeReasonDetail,
  classifyTransitionReason,
} from './lib/reasons/placement-reason-registry.js';
export type {
  PlacementReasonDefinition,
  ReasonDetailPolicy,
  ReasonStatus,
  ReasonEvidence,
  ReasonRejectionReason,
  ReasonClassification,
  ClassifyReasonInput,
} from './lib/reasons/placement-reason-registry.js';

// Track 6 / T6-B3 — the closed AssignmentRateVersion cancellation-reason vocabulary
// (TEXT, no enum). user-selectable set + the reserved internal ASSIGNMENT_ENDED.
export {
  USER_CANCELLATION_REASON_CODES,
  ASSIGNMENT_ENDED_CANCELLATION_REASON,
  isUserCancellationReasonCode,
} from './lib/reasons/commercial-cancellation-reasons.js';
export type {
  UserCancellationReasonCode,
  CancellationReasonCode,
} from './lib/reasons/commercial-cancellation-reasons.js';

// Repository I/O types (not HTTP DTOs — §7).
export type {
  CreatePlacementInput,
  TransitionPlacementInput,
  AssignmentContext,
  CommercialTermsInput,
  PlacementKind,
  GuaranteeTermsInput,
  PlacementProcessView,
  PlacementProcessEventView,
  StateTransitionPayload,
  ContractAssignmentEndReason,
  ContractAssignmentView,
  AssignmentCommercialView,
  PermanentPlacementView,
  PermanentPlacementTransitionPayload,
  PermanentPlacementRemedyView,
  FalloffInput,
  RemedyCompletionInput,
} from './lib/placement-process.types.js';

// Track 4 / T4-B — the placement-owned capacity projection (§4: consumers pull).
export { PlacementCapacityModule } from './lib/placement-capacity.module.js';
export { CapacityProjectionRepository } from './lib/capacity/capacity-projection.repository.js';
export { deriveCapacity, CAPACITY_STATUSES } from './lib/capacity/capacity-derivation.js';
export type { CapacityInput, CapacityProjection, CapacityStatus } from './lib/capacity/capacity-derivation.js';
// Track 5 / T5-P2 — the canonical assignment commercial derivation (the ONE home
// for spread/margin/markup; T9/reporting consumes it, like deriveCapacity).
export { deriveCommercialMetrics } from './lib/commercial/commercial-metrics.js';
export type { CommercialMetrics } from './lib/commercial/commercial-metrics.js';
