// APP-DELETED-1 (LOCKED 2026-11-27; Retention & Purge W5; UAT DEL-09) — the sender's Deleted
// folder in the app, as on Sign web (Envelopes → Deleted):
//   GET  /v1/sign/sender/envelopes?folder=deleted   → the deleted envelopes (each with `actions`)
//   POST /v1/sign/sender/envelopes/:id/delete       → { deleted: true }   (actions.delete)
//   POST /v1/sign/sender/envelopes/:id/restore      → { restored: true }  (actions.restore)
// The server decides both actions; the device shows them only when `actions` allows. Delete hides
// the envelope for the user's organization only; recipients keep their copies.
import { DELETED_FOLDER, ENVELOPE_DELETE_COPY, envelopeDeleteRoute, envelopeRestoreRoute } from '@aramo/sign-client';

import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';

import type { SenderEnvelopeList, SenderListItem } from './types';

export type SentDeleteOutcome =
  | { readonly kind: 'done'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/** The user's deleted sent envelopes; null when the caller may not read sent envelopes (403). */
export async function fetchDeletedSent(workspace: WorkspaceClient): Promise<SenderListItem[] | null> {
  try {
    const r = await workspace.request<SenderEnvelopeList>({
      method: 'GET',
      path: '/v1/sign/sender/envelopes',
      query: { folder: DELETED_FOLDER, tab: 'all', limit: 200 },
    });
    return [...r.data.items];
  } catch (e) {
    if (isApiError(e) && e.status === 403) return null;
    throw e;
  }
}

function refused(e: unknown): SentDeleteOutcome {
  return {
    kind: 'refused',
    message: isApiError(e) ? refusalMessage(e) : refusalMessage({ reason: 'unknown', code: 'unknown' }),
  };
}

/** Move a finished sent envelope to Deleted (offered only when the server's actions.delete). */
export async function moveSentToDeleted(workspace: WorkspaceClient, envelopeId: string): Promise<SentDeleteOutcome> {
  try {
    await workspace.request<{ deleted: boolean }>({ method: 'POST', path: envelopeDeleteRoute(envelopeId), body: {} });
    return { kind: 'done', message: ENVELOPE_DELETE_COPY.deleted };
  } catch (e) {
    return refused(e);
  }
}

/** Bring a deleted sent envelope back (offered only when the server's actions.restore). */
export async function restoreSentEnvelope(workspace: WorkspaceClient, envelopeId: string): Promise<SentDeleteOutcome> {
  try {
    await workspace.request<{ restored: boolean }>({ method: 'POST', path: envelopeRestoreRoute(envelopeId), body: {} });
    return { kind: 'done', message: ENVELOPE_DELETE_COPY.restored };
  } catch (e) {
    return refused(e);
  }
}
