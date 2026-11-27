import { apiClient } from '@aramo/fe-foundation';
import type { CloudProviderId } from '@aramo/sign-client';

import type { UploadedDocument } from './api';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — the cloud storage routes on the sender surface. The server
// decides everything (which providers are offered, the OAuth flow, the upload gates); the
// page only follows the provider's sign-in URL and shows lists. No provider script runs here.

const BASE = '/v1/sign/sender';
const enc = encodeURIComponent;

export interface CloudProviderRow {
  provider: CloudProviderId;
  label: string;
  connected: boolean;
  account_label: string | null;
  connected_at: string | null;
  folder_choice: boolean;
}

export interface CloudItem {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  mime_type: string | null;
  size: number | null;
  modified_at: string | null;
}

export interface CloudItemsPage {
  items: CloudItem[];
  next_cursor: string | null;
}

export interface CloudExportResult {
  provider: CloudProviderId;
  folder: { id: string; name: string };
  saved: { name: string; web_url: string | null }[];
}

export interface CloudItemsQuery {
  folder_id?: string | null;
  q?: string | null;
  cursor?: string | null;
  folders?: boolean;
}

export const cloudApi = {
  list: () => apiClient.get<{ providers: CloudProviderRow[] }>(`${BASE}/cloud-storage`).then((r) => r.providers ?? []),
  /** The provider's sign-in URL; the page then navigates to it. `return_path`: this page. */
  connect: (provider: CloudProviderId, return_path?: string) =>
    apiClient.post<{ authorize_url: string }>(`${BASE}/cloud-storage/${enc(provider)}/connect`, { client: 'web', ...(return_path !== undefined ? { return_path } : {}) }),
  disconnect: (provider: CloudProviderId) => apiClient.delete<void>(`${BASE}/cloud-storage/${enc(provider)}`),
  items: (provider: CloudProviderId, q: CloudItemsQuery = {}) => {
    const p = new URLSearchParams();
    if (q.folder_id) p.set('folder_id', q.folder_id);
    if (q.q) p.set('q', q.q);
    if (q.cursor) p.set('cursor', q.cursor);
    if (q.folders === true) p.set('folders', '1');
    const qs = p.toString();
    return apiClient.get<CloudItemsPage>(`${BASE}/cloud-storage/${enc(provider)}/items${qs ? `?${qs}` : ''}`);
  },
  importFile: (envelope_id: string, provider: CloudProviderId, file_id: string) =>
    apiClient.post<UploadedDocument>(`${BASE}/envelopes/${enc(envelope_id)}/documents/cloud-import`, { provider, file_id }),
  exportExecuted: (envelope_id: string, provider: CloudProviderId, folder_id?: string) =>
    apiClient.post<CloudExportResult>(`${BASE}/envelopes/${enc(envelope_id)}/cloud-export`, { provider, ...(folder_id !== undefined ? { folder_id } : {}) }),
};

export type CloudApi = typeof cloudApi;

/** Go to the provider's sign-in page (a full navigation; the server brings the user back). */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
