import type { LlmProvider } from './llm-provider.js';

// TENANT-LLM-2 — the port through which the dispatcher learns a tenant's active
// governed-LLM provider. ai-draft owns this interface + token; apps/api binds a
// settings-backed implementation (reads the `llm.active_provider` KnownSetting)
// so ai-draft never imports @aramo/settings (no lib→lib nx edge).
//
// The resolver derives the provider from the OWNED tenant_id only — never a
// client-supplied value. It must ALWAYS return a wired LlmProvider (defaulting
// to 'anthropic' when unset), so the dispatcher can always route.

export interface ActiveProviderResolver {
  resolveActiveProvider(tenantId: string): Promise<LlmProvider>;
}

export const ACTIVE_PROVIDER_RESOLVER = 'ACTIVE_PROVIDER_RESOLVER';
