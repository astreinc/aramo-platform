// SIGN-FREE-PARITY-1 S6 (FP-R7) — cloud storage in the Aramo Sign app: Account → Connected
// storage (connect / disconnect) and "Save to cloud storage" on a completed envelope. Import
// is NOT built here: the system document picker already reaches Google Drive, OneDrive,
// Dropbox and Box through the OS (features/send/sources.ts). The same server routes as the
// web; the server decides which providers are offered (sender context `cloud_storage`).
//
// Connect: POST …/connect {client: 'app'} → the provider's sign-in page in the OS auth session
// (ASWebAuthenticationSession / Custom Tabs) → sign-service → aramosign://cloud-storage?…
import {
  CLOUD_STORAGE_COPY,
  cloudConnectResultOf,
  cloudProvidersOf,
  type CloudProviderId,
} from '@aramo/sign-client';

import type { components } from '../../api/generated/sign';
import { fillPath } from '../../api/types';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type CloudProviderRow = components['schemas']['CloudStorageConnections']['providers'][number];
export type CloudExportResult = components['schemas']['CloudExportResult'];

/** Where sign-service sends the app back (the app's registered URL scheme). */
export const CLOUD_APP_RETURN_URL = 'aramosign://cloud-storage';

export const cloudKeys = { all: ['sign', 'cloud-storage'] as const };

export { cloudProvidersOf, CLOUD_STORAGE_COPY };

export async function loadCloudProviders(workspace: WorkspaceClient): Promise<CloudProviderRow[]> {
  const r = await workspace.request<components['schemas']['CloudStorageConnections']>({ method: 'GET', path: '/v1/sign/sender/cloud-storage' });
  return Array.isArray(r.data?.providers) ? r.data.providers : [];
}

/** The OS auth session (expo-web-browser openAuthSessionAsync's shape). */
export type OpenAuthSession = (url: string, redirectUrl: string) => Promise<{ type: string; url?: string }>;

export type ConnectOutcome = 'connected' | 'cancelled' | 'failed';

export async function connectCloudProvider(workspace: WorkspaceClient, provider: CloudProviderId, openAuth: OpenAuthSession): Promise<ConnectOutcome> {
  const r = await workspace.request<{ authorize_url: string }>({
    method: 'POST',
    path: fillPath('/v1/sign/sender/cloud-storage/{provider}/connect', { provider }),
    body: { client: 'app' },
  });
  const url = r.data?.authorize_url;
  if (typeof url !== 'string' || !url.startsWith('https://')) return 'failed';
  const res = await openAuth(url, CLOUD_APP_RETURN_URL);
  if (res.type !== 'success' || typeof res.url !== 'string') return 'cancelled';
  if (!res.url.startsWith(CLOUD_APP_RETURN_URL)) return 'failed';
  return cloudConnectResultOf(res.url)?.status ?? 'failed';
}

export async function disconnectCloudProvider(workspace: WorkspaceClient, provider: CloudProviderId): Promise<void> {
  await workspace.request<unknown>({ method: 'DELETE', path: fillPath('/v1/sign/sender/cloud-storage/{provider}', { provider }) });
}

/** Save the signed copy (the same documents as Download) to the provider's "Aramo Sign" folder. */
export async function saveSignedCopyToCloud(workspace: WorkspaceClient, envelopeId: string, provider: CloudProviderId): Promise<CloudExportResult> {
  const r = await workspace.request<CloudExportResult>({
    method: 'POST',
    path: fillPath('/v1/sign/sender/envelopes/{id}/cloud-export', { id: envelopeId }),
    body: { provider },
  });
  if (!r.data) throw new Error('empty cloud export response');
  return r.data;
}

export function connectOutcomeMessage(outcome: ConnectOutcome, provider: CloudProviderId): string | null {
  if (outcome === 'connected') return CLOUD_STORAGE_COPY.connected(provider);
  if (outcome === 'failed') return CLOUD_STORAGE_COPY.failed;
  return null;
}
