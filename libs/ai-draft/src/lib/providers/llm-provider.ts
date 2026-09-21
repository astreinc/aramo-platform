// TENANT-LLM-2 — the WIRED governed-LLM providers and their per-provider model
// policy. This file is the single ai-draft-owned source of truth for "which
// providers are shipped" + "which model ids are allowlisted per provider".
//
// It is intentionally self-contained (no @aramo/settings import) so ai-draft
// stays a leaf of the settings lib — the tenant's active-provider SELECTION is
// read via the ActiveProviderResolver port (apps/api provides the settings-
// backed implementation), never by importing the settings registry here.
//
// §4.5 no-dead-knobs: a provider appears here EXACTLY when its adapter is
// shipped + bound in the dispatcher. Phase A = Anthropic + OpenAI. Azure/
// Gemini/Bedrock are NOT members until their adapters land.

/** The wired governed-LLM providers (Phase A). */
export type LlmProvider = 'anthropic' | 'openai';

export const WIRED_LLM_PROVIDERS: readonly LlmProvider[] = Object.freeze([
  'anthropic',
  'openai',
]);

export function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    typeof value === 'string' &&
    (WIRED_LLM_PROVIDERS as readonly string[]).includes(value)
  );
}

// Per-provider model allowlist. The tenant's model is validated server-side
// against its provider's allowlist — NEVER request-derived (directive §2.5).
// The dispatcher resolves the model to use from (active provider, caller's
// requested model): the caller's model is honoured only if it is in the active
// provider's allowlist, otherwise the provider's default is used. This keeps
// the Anthropic path unchanged (claude-sonnet-4-6 is Anthropic-allowlisted) and
// routes an OpenAI-active tenant to an OpenAI model even though callers still
// pass the Anthropic constant.
export const PROVIDER_MODEL_ALLOWLIST: Readonly<Record<LlmProvider, readonly string[]>> =
  Object.freeze({
    anthropic: Object.freeze(['claude-sonnet-4-6']),
    openai: Object.freeze(['gpt-4o', 'gpt-4o-mini']),
  });

/** Per-provider default model (the head of each allowlist). */
export const PROVIDER_DEFAULT_MODEL: Readonly<Record<LlmProvider, string>> =
  Object.freeze({
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-4o',
  });

export function isModelAllowedForProvider(provider: LlmProvider, model: string): boolean {
  return (PROVIDER_MODEL_ALLOWLIST[provider] as readonly string[]).includes(model);
}

// LOCAL-DEV ONLY: per-provider single-key env-var fallback (see
// SecretCacheService). HARD-GATED to ARAMO_ENV=local; never consulted in
// staging/prod where the no-cross-tenant-fallback LOCK is absolute.
export const PROVIDER_LOCAL_ENV_VAR: Readonly<Record<LlmProvider, string>> =
  Object.freeze({
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
  });

/**
 * Resolve the model to send for a provider given the caller's requested model.
 * Honour the requested model when it is allowlisted for the provider; otherwise
 * fall back to the provider's default. The result is ALWAYS allowlisted for the
 * provider (never a cross-provider model id, never a request-derived unknown).
 */
export function resolveProviderModel(provider: LlmProvider, requestedModel: string): string {
  return isModelAllowedForProvider(provider, requestedModel)
    ? requestedModel
    : PROVIDER_DEFAULT_MODEL[provider];
}
