// Recipient inbox: claim and inbox signing (directive §6; M-A2 §2.2; §7 C-6, C-7, C-21).
//
//   claim  POST /v1/sign/inbox/claim {token}  — WORKSPACE call by contract: the live
//          emailed token proves the link; the server also requires the signed-in email
//          to match. A matching email alone never claims.
//   sign   POST /v1/sign/inbox/:id/sign       — WORKSPACE call; the server revalidates
//          the association, envelope, signer, turn and revocation every time, then mints
//          a 30-minute single-envelope token. The app opens it on the GUEST transport,
//          keeps it in memory only, and discards it when the task ends.
import { isApiError, type ApiError } from '../../api/errors';
import type { GuestSigningClient, GuestSigningSession } from '../../api/guestSigningClient';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import type { InboxItem, InboxList } from './types';

const SIGNING_PATH_TOKEN = /\/s\/([A-Za-z0-9_-]{32,256})\/?(?:[?#].*)?$/;
const DOWNLOAD_PATH_TOKEN = /\/d\/([A-Za-z0-9_-]{32,256})\/?(?:[?#].*)?$/;

/** The capability token inside a server-issued `/s/{token}` link (never logged). */
export function signingTokenFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return SIGNING_PATH_TOKEN.exec(url)?.[1] ?? null;
}

/** The access token inside a server-issued `/d/{token}` signed-copy link. */
export function downloadTokenFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return DOWNLOAD_PATH_TOKEN.exec(url)?.[1] ?? null;
}

/**
 * User copy for inbox claim / inbox signing refusals (directive §7, M-A2 §2.2): the
 * shared refusalMessage() table is the one source for every inbox reason
 * (association_inactive, envelope_not_signable, signer_ineligible, not_your_turn,
 * session_revoked, link_expired, recipient_mismatch, SIGNING_SESSION_INVALID).
 */
export function inboxRefusalCopy(e: Pick<ApiError, 'reason' | 'code'>): string {
  return refusalMessage(e);
}

export async function claimFromLink(
  workspace: WorkspaceClient,
  token: string,
): Promise<{ readonly id: string | null }> {
  const r = await workspace.call('/v1/sign/inbox/claim', 'post', { body: { token } });
  return { id: r?.id ?? null };
}

export type InboxSignStart =
  | { readonly kind: 'session'; readonly session: GuestSigningSession; readonly expiresAt: string }
  | { readonly kind: 'refused'; readonly reason: string; readonly message: string };

/** Mint a fresh inbox signing session (revalidated server-side) and open it as guest. */
export async function startInboxSigning(
  workspace: WorkspaceClient,
  guest: GuestSigningClient,
  inboxItemId: string,
): Promise<InboxSignStart> {
  try {
    const r = await workspace.call('/v1/sign/inbox/{id}/sign', 'post', {
      path: { id: inboxItemId },
    });
    const token = signingTokenFromUrl(r.signing_url);
    if (!token)
      return {
        kind: 'refused',
        reason: 'session_revoked',
        message: inboxRefusalCopy({ reason: 'session_revoked', code: 'session_revoked' }),
      };
    return { kind: 'session', session: guest.open(token), expiresAt: r.expires_at };
  } catch (e) {
    if (isApiError(e)) return { kind: 'refused', reason: e.reason, message: inboxRefusalCopy(e) };
    throw e;
  }
}

/** A short-lived signed-copy access token for a completed received envelope. */
export async function signedCopyToken(
  workspace: WorkspaceClient,
  inboxItemId: string,
): Promise<string | null> {
  const r = await workspace.call('/v1/sign/inbox/{id}/signed-copy', 'post', {
    path: { id: inboxItemId },
  });
  return downloadTokenFromUrl(r?.download_url);
}

/** The inbox item with this id, from the (cached) inbox list. */
export function findInboxItem(
  inbox: Partial<InboxList> | null | undefined,
  id: string,
): InboxItem | null {
  if (!inbox) return null;
  return (
    [...(inbox.waiting ?? []), ...(inbox.completed ?? []), ...(inbox.other ?? [])].find(
      (i) => i.id === id,
    ) ?? null
  );
}
