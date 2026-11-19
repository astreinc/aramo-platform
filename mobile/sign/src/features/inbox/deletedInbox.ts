// M-A17 §1–§2 (UAT SIG-15 retest, web ≡ app) — the recipient's own Deleted folder and
// Restore, as Waiting for me → "Show deleted" on the web:
//   GET  /v1/sign/inbox?folder=deleted          → { waiting, completed, other }
//   POST /v1/sign/inbox/:id/return-to-inbox     → { restored: true }
// Per user only: the sender and other recipients never see a change.
import { isApiError } from '../../api/errors';
import type { WorkspaceClient } from '../../api/workspaceClient';

import type { InboxItem } from './types';

export const DELETED_COPY = {
  empty: 'Nothing deleted.',
  restored: 'Restored to your inbox',
  gone: 'This envelope is no longer in your Deleted list.',
  failed: 'Couldn’t restore it. Try again.',
  loadFailed: 'Couldn’t load your deleted envelopes. Pull down to try again.',
} as const;

export async function fetchDeletedInbox(workspace: WorkspaceClient): Promise<InboxItem[]> {
  const r = await workspace.request<{ waiting?: InboxItem[]; completed?: InboxItem[]; other?: InboxItem[] }>({
    method: 'GET',
    path: '/v1/sign/inbox?folder=deleted',
  });
  const d = r.data;
  return [...(d.waiting ?? []), ...(d.completed ?? []), ...(d.other ?? [])];
}

export type RestoreOutcome = 'restored' | 'gone' | 'failed';

export async function restoreInboxItem(workspace: WorkspaceClient, id: string): Promise<RestoreOutcome> {
  try {
    await workspace.request<{ restored: boolean }>({
      method: 'POST',
      path: `/v1/sign/inbox/${encodeURIComponent(id)}/return-to-inbox`,
      body: {},
    });
    return 'restored';
  } catch (e) {
    if (isApiError(e) && e.status === 404) return 'gone';
    return 'failed';
  }
}
