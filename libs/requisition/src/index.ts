export { RequisitionModule } from './lib/requisition.module.js';
export { RequisitionController } from './lib/requisition.controller.js';
export {
  RequisitionRepository,
  type PublishableRequisitionRow,
} from './lib/requisition.repository.js';
export { RequisitionAssignmentRepository } from './lib/requisition-assignment.repository.js';
export { PrismaService as RequisitionPrismaService } from './lib/prisma/prisma.service.js';
// T1-e — the governed-transition policy gate (a RequisitionRepository ctor dep).
// Exported so integration specs that construct the repository directly can wire
// a REAL instance (backed by @aramo/policy-store's PolicyStore).
export {
  RequisitionTransitionPolicyService,
  // L1-F2 — the dedicated DI token for the requisition PolicyStore (never the
  // bare class token). Exported so composition roots / wiring specs can assert it.
  REQUISITION_POLICY_STORE,
} from './lib/policy/requisition-transition-policy.service.js';
// L1-F2 — the sibling SET_PRIORITY gate; exported so the token-wiring proof can
// assert it too resolves the dedicated REQUISITION_POLICY_STORE instance.
export { SetPriorityPolicyService } from './lib/policy/set-priority-policy.service.js';

// ADR-0024 §D17c — append-only lifecycle mutation history (write API only;
// PR-5 wires the consumer).
export {
  RequisitionLifecycleEventStore,
  type RecordRequisitionLifecycleEventInput,
  type RequisitionLifecycleEvent,
  type RequisitionLifecycleOrigin,
} from './lib/requisition-lifecycle-event.store.js';

export {
  RECRUITING_STATUS_VALUES,
  GATED_RECRUITING_STATUS_VALUES,
  SELECTABLE_RECRUITING_STATUS_VALUES,
  isRecruitingStatus,
  isGatedRecruitingStatus,
  type RecruitingStatus,
  TRANSITION_ACTIONS,
  REQUISITION_RESOURCE,
  ACTION_TARGET_STATUS,
  governingAction,
  type TransitionAction,
  type RequisitionView,
  emptyRequisitionProfileView,
  type RequisitionProfileView,
  type CreateRequisitionRequestDto,
  type UpdateRequisitionRequestDto,
  type RequisitionAssignmentView,
  type AssignRequisitionRequestDto,
  RATE_TYPE_VALUES,
  isRateType,
  type RateType,
  RATE_PERIOD_VALUES,
  isRatePeriod,
  type RatePeriod,
  type IntakeDraftRequestDto,
  type IntakeDraftResponseDto,
  type IntakeExtractedFields,
  // L1-D1 (ADR-0030) — governed external-lifecycle command contract.
  EXTERNAL_LIFECYCLE_ACTIONS,
  isExternalLifecycleAction,
  type ExternalLifecycleTransitionCommand,
  type ExternalLifecycleProvenanceInput,
  type ExternalLifecycleCommandResult,
  type ExternalLifecycleExecuted,
  type ExternalLifecycleRefused,
  type ExternalLifecycleRefusalReason,
} from './lib/dto/index.js';
// T8-P1 external-identity canonicalization + validation — reused by the T8-P2
// import framework (@aramo/import) to produce a canonical requisition DTO.
export {
  resolveExternalIdentity,
  canonicalizeSourceSystem,
  validateExternalReqId,
  assertExternalIdentityCoPresence,
  type ExternalIdentityInput,
  type ResolvedExternalIdentity,
} from './lib/external-identity-validation.js';
