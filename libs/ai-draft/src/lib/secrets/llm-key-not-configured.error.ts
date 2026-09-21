// TENANT-LLM-1 — the terminal, fail-CLOSED signal that a tenant has no Anthropic
// key configured. Distinct from a transient Secrets Manager blip: a not-configured
// key is a governed "the tenant must set their key" state, NOT a retryable error,
// and per the directive it must NEVER fall back to a platform or another tenant's
// key. Consumers translate this into the governed "LLM not configured" degradation.
// Carries only the tenant_id — never the (absent) key.
export class LlmKeyNotConfiguredError extends Error {
  readonly kind = 'llm_key_not_configured' as const;

  constructor(readonly tenant_id: string) {
    super('llm_key_not_configured');
    this.name = 'LlmKeyNotConfiguredError';
  }
}

export function isLlmKeyNotConfigured(err: unknown): err is LlmKeyNotConfiguredError {
  return err instanceof LlmKeyNotConfiguredError;
}
