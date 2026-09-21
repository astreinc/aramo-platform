// TENANT-LLM-1/2 — Settings → Integrations → AI/LLM. Multi-provider BYO: the
// tenant selects an active provider and supplies that provider's own key. Keys
// are WRITE-ONLY: sent on set/rotate, never read back. Only the active provider
// + per-provider has-key status cross this boundary.

import { apiClient } from '@aramo/fe-foundation';

// The wired providers (server-authoritative via the overview; this union is the
// FE's display type). Unwired providers never appear in the overview and are
// rendered as static "coming soon" — not selectable (no dead knobs).
export type LlmProvider = 'anthropic' | 'openai';

export interface TenantLlmKeyStatus {
  readonly provider: LlmProvider;
  readonly configured: boolean;
}

export interface TenantLlmOverview {
  readonly active_provider: LlmProvider;
  readonly providers: ReadonlyArray<TenantLlmKeyStatus>;
}

export async function getLlmOverview(): Promise<TenantLlmOverview> {
  return apiClient.get<TenantLlmOverview>('/v1/integrations/llm/overview');
}

export async function setActiveProvider(provider: LlmProvider): Promise<TenantLlmOverview> {
  return apiClient.put<TenantLlmOverview>('/v1/integrations/llm/active-provider', { provider });
}

export async function setProviderKey(
  provider: LlmProvider,
  apiKey: string,
): Promise<TenantLlmKeyStatus> {
  return apiClient.put<TenantLlmKeyStatus>(`/v1/integrations/llm/${provider}/key`, {
    api_key: apiKey,
  });
}

export async function clearProviderKey(provider: LlmProvider): Promise<TenantLlmKeyStatus> {
  return apiClient.delete<TenantLlmKeyStatus>(`/v1/integrations/llm/${provider}/key`);
}
