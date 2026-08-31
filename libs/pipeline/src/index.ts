export { PipelineModule } from './lib/pipeline.module.js';
export { PipelineController } from './lib/pipeline.controller.js';
export {
  PipelineRepository,
  type CurrentStage,
} from './lib/pipeline.repository.js';
export { PrismaService as PipelinePrismaService } from './lib/prisma/prisma.service.js';
// Lane 2 / L2-B — the pipeline outbox drain surface, consumed by libs/outbox-publisher.
export { PipelineOutboxRepository } from './lib/pipeline-outbox.repository.js';
export { PipelineOutboxModule } from './lib/pipeline-outbox.module.js';

export {
  PIPELINE_STATUS_VALUES,
  isPipelineStatus,
  canTransition,
  isLiveStatus,
  legalNextStates,
  // The active-stage ordinal, consumed by the apps/api current_stage read-model.
  activeStageOrdinal,
  ACTIVE_FLOW_STAGES,
  type PipelineStatus,
  // The explicit terminal partition registry + the recruiter action surface.
  CANONICAL_TERMINAL_STATUSES,
  LIVE_EPISODE_EXCLUSION_STATUSES,
  RECRUITER_ACTION_TO_STATUS,
  isRecruiterPipelineAction,
  SYSTEM_COMPLETE_ACTION,
  type RecruiterPipelineAction,
} from './lib/pipeline-state.js';
// Lane 2 / L2-C — the PipelineDisposition domain (authority classes + reason taxonomy).
export {
  PIPELINE_DISPOSITION_AUTHORITY_VALUES,
  PIPELINE_DISPOSITION_REASONS,
  RECRUITER_DISPOSITION_AUTHORITIES,
  isPipelineDispositionAuthority,
  isValidDispositionReason,
  isRecruiterDispositionAuthority,
  type PipelineDispositionAuthority,
} from './lib/pipeline-disposition.js';
// Lane 2 / L2-D — the PipelineEntryProvenance domain (origin classes + write input).
export {
  PIPELINE_ENTRY_ORIGIN_VALUES,
  isPipelineEntryOriginType,
  isValidInitiatedByKind,
  projectEntryProvenanceForEvent,
  type PipelineEntryOriginType,
  type EntryProvenanceInput,
  type EntryProvenanceEventProjection,
} from './lib/pipeline-entry-provenance.js';
// Lane 2 / L2-I (D2) — the external source-event contract (built on L2-D provenance).
export {
  PROVIDER_SOURCED_ORIGINS,
  isProviderSourcedOrigin,
  projectExternalSourceEventToEntryProvenance,
  type ExternalSourceEvent,
} from './lib/external-source-event.js';

export {
  type PipelineView,
  type PipelineStatusHistoryView,
  type CreatePipelineRequestDto,
  type TransitionPipelineRequestDto,
  type PipelineActionRequestDto,
} from './lib/dto/index.js';

// ADR-0024 PR-3b — the REQUISITION_TALENT · ADD policy call, now consumed by a
// SECOND command boundary (SourcingController.addToPipeline) in addition to
// PipelineController.create. Exported so the sourcing surface reuses the ONE
// service (no duplication); its provenance record is threaded through the
// mutation transaction.
export {
  AddTalentPolicyService,
  REQUISITION_LIFECYCLE_PACKAGE_NAME,
  NO_POLICY_PUBLISHED_REASON,
  type AddTalentPolicyInput,
  type AddTalentPolicyOutcome,
} from './lib/policy/add-talent-policy.service.js';
// ADR-0024 §D11 (PR-4b) — the un-collapsed disposition + the two-pass override
// resolution (shared by both command boundaries) + the closed reason-code set.
export {
  toEnforcementDisposition,
  type EnforcementDisposition,
} from './lib/policy/decision-mapping.js';
export {
  resolveAddTalentOutcome,
  type OverrideResolution,
} from './lib/policy/override-resolution.js';
export {
  VALID_OVERRIDE_REASON_CODES,
  isOverrideReasonCode,
  type OverrideReasonCode,
} from './lib/policy/override-reason-codes.js';
