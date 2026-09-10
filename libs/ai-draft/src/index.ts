export { AiDraftModule } from './lib/ai-draft.module.js';
export { AiDraftService } from './lib/ai-draft.service.js';

export type { GenerateDraftInput } from './lib/dto/generate-draft-input.dto.js';
export type { GenerateDraftResult } from './lib/dto/generate-draft-result.dto.js';
export type { AiDraftEventView } from './lib/dto/ai-draft-event.view.js';

export {
  AI_DRAFT_EVENT_TYPES,
  ARAMO_AI_DRAFT_MODEL,
} from './lib/dto/event-payloads.js';
export type { AiDraftEventType } from './lib/dto/event-payloads.js';

// CI-B6P §4 — reusable structured-generation surface (the smallest public
// boundary over the sanctioned Anthropic infrastructure + secret custody).
// The Anthropic SDK is owned internally; NO vendor type crosses this barrel.
export { AnthropicStructuredGenerationService } from './lib/structured-generation/anthropic-structured-generation.service.js';
export {
  STRUCTURED_GENERATION_PROVIDER,
  type StructuredGenerationProvider,
  type StructuredGenerationRequest,
  type StructuredGenerationOutcome,
  type StructuredGenerationTransport,
  type StructuredGenerationErrorCategory,
} from './lib/structured-generation/structured-generation.types.js';
