import { apiClient } from '@aramo/fe-foundation';

// SIGN-FREE-PARITY-1 S7 — typed client for the user's own folders. The server decides (owner,
// name rule, cap); the copy and limits shown are @aramo/sign-client folders.ts.

const enc = encodeURIComponent;

export interface SignFolder {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  sender_items: number;
  recipient_items: number;
}

export interface SignFolderList {
  items: SignFolder[];
  limit: number;
  name_max: number;
  can_create: boolean;
}

export const foldersApi = {
  list: () => apiClient.get<SignFolderList>('/v1/sign/folders'),
  create: (name: string) => apiClient.post<SignFolder>('/v1/sign/folders', { name }),
  rename: (id: string, name: string) => apiClient.patch<SignFolder>(`/v1/sign/folders/${enc(id)}`, { name }),
  remove: (id: string) => apiClient.delete<{ deleted: boolean }>(`/v1/sign/folders/${enc(id)}`),
  // An envelope the user sent (or can see as sender).
  moveEnvelope: (envelopeId: string, folderId: string) => apiClient.put<{ folder_id: string }>(`/v1/sign/sender/envelopes/${enc(envelopeId)}/folder`, { folder_id: folderId }),
  removeEnvelope: (envelopeId: string) => apiClient.delete<{ folder_id: null }>(`/v1/sign/sender/envelopes/${enc(envelopeId)}/folder`),
  // A document the user received (an inbox item id or handle).
  moveInboxItem: (itemId: string, folderId: string) => apiClient.put<{ folder_id: string }>(`/v1/sign/inbox/${enc(itemId)}/folder`, { folder_id: folderId }),
  removeInboxItem: (itemId: string) => apiClient.delete<{ folder_id: null }>(`/v1/sign/inbox/${enc(itemId)}/folder`),
};

// The sidebar and pages read the same list; a change anywhere tells the others to reload.
const listeners = new Set<() => void>();
export function onFoldersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function foldersChanged(): void {
  for (const fn of [...listeners]) fn();
}
