export { ConversationIntelligenceModule } from './lib/conversation-intelligence.module.js';
export { RequisitionAnalysisContextSnapshotService } from './lib/requisition-analysis-context-snapshot.service.js';
export { RequisitionAnalysisContextSnapshotRepository } from './lib/requisition-analysis-context-snapshot.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// Reader port — a composition root (CI-B6 / apps/api) may rebind the
// REQUISITION_ANALYSIS_CONTEXT_READER token; the concrete adapter is
// exported so wiring specs can assert it.
export {
  REQUISITION_ANALYSIS_CONTEXT_READER,
  type RequisitionAnalysisContextReader,
} from './lib/reader/requisition-analysis-context-reader.js';
export { RequisitionGoldenProfileContextReader } from './lib/reader/requisition-golden-profile-context.reader.js';

export type { CaptureRequisitionAnalysisContextInput } from './lib/requisition-analysis-context-snapshot.service.js';
export type { CreateRequisitionAnalysisContextSnapshotInput } from './lib/requisition-analysis-context-snapshot.repository.js';
export type { RequisitionAnalysisContextSnapshotView } from './lib/dto/requisition-analysis-context-snapshot.view.js';

export {
  REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
  buildRequisitionAnalysisContext,
  isRequisitionAnalysisContextV1,
} from './lib/dto/requisition-analysis-context.js';
export type {
  RequisitionAnalysisContextV1,
  RequisitionAnalysisContextSchemaVersion,
  RequisitionAnalysisSource,
  RequisitionAnalysisRoleContext,
  RequisitionAnalysisLocation,
  RequisitionAnalysisWorkArrangement,
  RequisitionAnalysisEngagement,
  RequisitionAnalysisGoldenProfile,
} from './lib/dto/requisition-analysis-context.js';

// ==== CI-B6 — Conversation Intelligence Processing ====

export {
  ConversationIntelligenceProcessingService,
  CI_MAX_PROCESSING_ATTEMPTS,
  type ProcessConversationIntelligenceCommand,
  type CiProcessingResult,
  type CiProcessingOutcome,
} from './lib/conversation-intelligence-processing.service.js';
export {
  ConversationIntelligenceRunRepository,
  type CiRunRow,
  type CiAnalysisIdentity,
  type CiRunProvenance,
  type PersistClaimInput,
} from './lib/conversation-intelligence-run.repository.js';

// Domain enums + state machine + errors.
export {
  CI_RUN_STATUSES,
  CI_RUN_TERMINAL_STATUSES,
  CI_CLAIM_STATUSES,
  CI_CLAIM_STATUSES_REQUIRING_CITATION,
  CI_CLAIM_STATUS_FORBIDS_CITATION,
  type ConversationIntelligenceRunStatus,
  type ConversationIntelligenceClaimStatus,
} from './lib/domain/run-enums.js';
export {
  CI_RUN_TRANSITIONS,
  canCiRunTransition,
  assertCiRunTransition,
} from './lib/domain/run-state-machine.js';
export {
  CI_PROCESSING_ERROR_CODES,
  CiRunInvalidStateError,
  CiAnalysisValidationError,
  CiRunNotFoundError,
  type CiProcessingErrorCode,
} from './lib/domain/errors.js';

// Structured-output contract + validators + prompt template.
export {
  CI_ANALYSIS_SCHEMA_VERSION,
  PROTECTED_TRAIT_MARKERS,
  type AnalysisResultV1,
  type AnalysisClaimV1,
  type AnalysisCitationV1,
  type AnalysisDraftV1,
  type AnalysisDraftSectionV1,
} from './lib/analysis/analysis-schema.js';
export { validateAnalysisResult } from './lib/analysis/analysis-validator.js';
export { validateCitationsAgainstTranscript } from './lib/analysis/citation-validator.js';
export {
  CI_PROMPT_TEMPLATE_ID,
  CI_PROMPT_TEMPLATE_VERSION,
  CI_PROMPT_TEMPLATE_TEXT,
  CI_PROMPT_TEMPLATE_SHA256,
} from './lib/analysis/prompt-template.js';

// Model port + deterministic fake.
export {
  CONVERSATION_INTELLIGENCE_MODEL_PROVIDER,
  type ConversationIntelligenceModelProvider,
  type ModelAnalysisInput,
  type ModelAnalysisOutcome,
} from './lib/model/conversation-intelligence-model-provider.port.js';
export {
  FakeCiModelProvider,
  FAKE_CI_MODEL_PROVIDER_KEY,
  type FakeCiModelMode,
} from './lib/model/fake/fake-ci-model-provider.js';

// Composition-root ports (bound at apps/api).
export {
  NORMALIZED_TRANSCRIPT_SOURCE,
  type NormalizedTranscriptSource,
  type NormalizedTranscriptView,
  type NormalizedTranscriptUtteranceView,
  type NormalizedTranscriptLoadResult,
  type TranscriptGroundingMeta,
} from './lib/ports/normalized-transcript-source.port.js';
export {
  AI_PROCESSING_AUTHORIZATION,
  type AiProcessingAuthorizationPort,
  type AiProcessingAuthorizationResult,
} from './lib/ports/ai-processing-authorization.port.js';
export {
  REQUISITION_SNAPSHOT_SOURCE,
  type RequisitionSnapshotSource,
  type RequisitionSnapshotView,
} from './lib/ports/requisition-snapshot-source.port.js';
