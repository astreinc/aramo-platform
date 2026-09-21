// TENANT-LLM-1 — Settings → Integrations → AI/LLM → Anthropic. The per-tenant
// Anthropic API key is WRITE-ONLY: it is sent to the server on set/rotate and is
// never read back. Only the has-key status crosses this boundary.

import { apiClient } from '@aramo/fe-foundation';

export interface TenantLlmKeyStatus {
  readonly provider: 'anthropic';
  readonly configured: boolean;
}

export async function getAnthropicKeyStatus(): Promise<TenantLlmKeyStatus> {
  return apiClient.get<TenantLlmKeyStatus>('/v1/integrations/llm/anthropic/status');
}

export async function setAnthropicKey(apiKey: string): Promise<TenantLlmKeyStatus> {
  return apiClient.put<TenantLlmKeyStatus>('/v1/integrations/llm/anthropic/key', {
    api_key: apiKey,
  });
}

export async function clearAnthropicKey(): Promise<TenantLlmKeyStatus> {
  return apiClient.delete<TenantLlmKeyStatus>('/v1/integrations/llm/anthropic/key');
}
