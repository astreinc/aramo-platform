// M5 PR-5 §4.11 — DraftProvider.generate input.

export interface ProviderGenerateInput {
  // TENANT-LLM-1 — the OWNED tenant_id of the work being drafted; the tenant's
  // own Anthropic key is resolved from it (per-tenant custody, no cross-tenant
  // fallback). Server-derived, never client-supplied.
  tenant_id: string;
  model: string;
  prompt: string;
  max_tokens: number;
  system_message?: string;
}
