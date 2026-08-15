// T8-CONNECTOR-A — connector connection management client. Uses the shared
// cookie/session apiClient. The credential set is WRITE-ONLY: the raw value is
// posted and never read back; no GET here ever returns secret material.

import { apiClient } from '@aramo/fe-foundation';

import type { IntegrationConnectionView } from './types';

export const INTEGRATIONS_PATH = '/v1/integrations';

export async function listIntegrationConnections(): Promise<readonly IntegrationConnectionView[]> {
  const res = await apiClient.get<{ items: IntegrationConnectionView[] }>(INTEGRATIONS_PATH);
  return res.items;
}

export async function createIntegrationConnection(input: {
  provider_key: string;
  provider_account_id?: string | null;
}): Promise<IntegrationConnectionView> {
  return apiClient.post<IntegrationConnectionView>(INTEGRATIONS_PATH, input);
}

// Write-only: posts the credential; the response is the secret-free view.
export async function setIntegrationCredential(
  id: string,
  credential: string,
): Promise<IntegrationConnectionView> {
  return apiClient.post<IntegrationConnectionView>(
    `${INTEGRATIONS_PATH}/${encodeURIComponent(id)}/credential`,
    { credential },
  );
}

export async function enableIntegrationConnection(id: string): Promise<IntegrationConnectionView> {
  return apiClient.post<IntegrationConnectionView>(
    `${INTEGRATIONS_PATH}/${encodeURIComponent(id)}/enable`,
  );
}

export async function disableIntegrationConnection(id: string): Promise<IntegrationConnectionView> {
  return apiClient.post<IntegrationConnectionView>(
    `${INTEGRATIONS_PATH}/${encodeURIComponent(id)}/disable`,
  );
}
