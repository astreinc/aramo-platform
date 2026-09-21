export { AiDraftModule } from './lib/ai-draft.module.js';
export { AiDraftService } from './lib/ai-draft.service.js';

// HF1 §17 / R10 — the SAME local PII redaction used by AiDraftService, exported
// so the structured-generation résumé path (which calls the provider port
// directly, not generateDraft) preserves the EXACT email/phone/SSN/CC/routing
// redaction boundary before any text reaches the model.
export { redactPii } from './lib/redaction.js';

// TENANT-LLM-1 — the terminal, fail-closed "tenant has no Anthropic key" signal.
// Exported so LLM consumers (résumé extraction, requisition/selection drafts, CI)
// can discriminate not-configured (governed "set a key" degradation) from a
// transient provider failure, WITHOUT ever falling back to a platform key.
export {
  LlmKeyNotConfiguredError,
  isLlmKeyNotConfigured,
} from './lib/secrets/llm-key-not-configured.error.js';

// TENANT-LLM-1 — the per-tenant Anthropic secret custody (resolve by owned
// tenant_id; invalidate on rotate/clear). Exported for the admin set/rotate/clear
// path (P2) to invalidate the tenant's cached key after a write.
export { SecretCacheService } from './lib/secrets/secret-cache.service.js';

// TENANT-LLM-2 — the WIRED provider set + per-provider model policy + the
// active-provider resolver PORT. Exported so apps/api can (a) validate the
// admin write path against the wired set (§4.5 no-dead-knobs), (b) bind the
// settings-backed ActiveProviderResolver, and (c) share the LlmProvider union
// with the per-provider secret custody. ai-draft owns these; consumers depend
// on the port + union, never a vendor SDK.
export {
  WIRED_LLM_PROVIDERS,
  isLlmProvider,
  isModelAllowedForProvider,
  resolveProviderModel,
  PROVIDER_MODEL_ALLOWLIST,
  PROVIDER_DEFAULT_MODEL,
  type LlmProvider,
} from './lib/providers/llm-provider.js';
export {
  ACTIVE_PROVIDER_RESOLVER,
  type ActiveProviderResolver,
} from './lib/providers/active-provider-resolver.js';

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
