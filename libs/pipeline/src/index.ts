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
  legalNextStates,
  type PipelineStatus,
} from './lib/pipeline-state.js';

export {
  type PipelineView,
  type PipelineStatusHistoryView,
  type CreatePipelineRequestDto,
  type TransitionPipelineRequestDto,
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
