// Public surface of @aramo/technical-screening (TIP-E2E INC-3,
// ARAMO-TIP-E2E-INC-3-v1.0-LOCKED).
export { TechnicalScreeningModule } from './lib/technical-screening.module.js';
export {
  TechnicalScreeningService,
  type ScreeningFindingInput,
  type ScreeningSessionDetail,
  type PublicationAttemptResult,
} from './lib/technical-screening.service.js';
export {
  TechnicalScreeningRepository,
  ScreeningGuardError,
  type ScreeningSessionRow,
  type ScreeningFindingRow,
  type ScreeningPublicationRow,
  type ScreeningEventRow,
} from './lib/technical-screening.repository.js';
export {
  SCREENING_EVIDENCE_PUBLISHER,
  type ScreeningEvidencePublisher,
  type ScreeningEvidencePublishInput,
} from './lib/screening-publisher.port.js';
export { buildScreeningFindingPayload, screeningPayloadHash } from './lib/screening-payload.js';
export * from './lib/screening-vocab.js';
// INC-3 A1-3 — screening AI assistance (tenant LLM) and its ports.
export { ScreeningAiService, SCREENING_AI_MODEL, QUESTION_PLAN_PROMPT_VERSION, FOLLOW_UP_PROMPT_VERSION } from './lib/ai/screening-ai.service.js';
export {
  SCREENING_AI_CONSENT,
  type ScreeningAiConsentPort,
  type ScreeningRequisitionContext,
  type ScreeningTalentContext,
} from './lib/ai/screening-ai.ports.js';
export type {
  AiGenerationInput,
  AiDraftedFindingInput,
  ScreeningCitationRow,
  ScreeningQuestionRow,
  ScreeningNoteRow,
  ScreeningSuggestionRow,
  ScreeningGenerationRow,
  ScreeningTranscriptLinkRow,
} from './lib/technical-screening.repository.js';
export { PrismaService as TechnicalScreeningPrismaService } from './lib/prisma/prisma.service.js';
