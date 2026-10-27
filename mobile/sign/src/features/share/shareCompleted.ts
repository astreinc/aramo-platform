// Share a completed agreement (M-A4 §3.7; ruling: "native sharing of authorized
// completed documents"). Only a COMPLETED envelope's authorized PDF is shared:
//   - sender:    GET  /v1/sign/sender/envelopes/{id}/executed   (workspace transport)
//   - recipient: POST /v1/sign/inbox/{id}/signed-copy -> a short-lived /d/ access token,
//                opened on the GUEST transport in memory to read the signed copy, then
//                discarded (M-A2 §2.1). The link and its token are NEVER shared (M-A2 :56).
// Each PDF is written to the app's cache, handed to the OS share sheet, and deleted
// afterwards, whatever happens. Declined, voided and expired envelopes have no Share.
//
// Platform pieces (file system, share sheet) come in as ports; shareNative.ts binds them
// to expo-file-system and expo-sharing.
import { isApiError } from '../../api/errors';
import type { GuestSigningClient } from '../../api/guestSigningClient';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';
import type { AgreementRow } from '../inbox/agreementsModel';
import { signedCopyToken } from '../inbox/inboxSigning';
import type { EnvelopeStatus, InboxItem } from '../inbox/types';
import { loadExecutedCopy } from '../signing/signingApi';

export type ShareTarget =
  | { readonly kind: 'sent'; readonly envelopeId: string; readonly subject: string }
  | { readonly kind: 'received'; readonly inboxItemId: string; readonly subject: string };

/** The sender's executed copy exists only for a COMPLETED envelope. */
export function sentShareTarget(
  envelopeId: string,
  subject: string,
  status: EnvelopeStatus,
): ShareTarget | null {
  return status === 'COMPLETED' ? { kind: 'sent', envelopeId, subject } : null;
}

/** A recipient may share only a COMPLETED envelope the server lets them download. */
export function receivedShareTarget(item: InboxItem): ShareTarget | null {
  return item.envelope_status === 'COMPLETED' && item.can_download
    ? { kind: 'received', inboxItemId: item.id, subject: item.subject }
    : null;
}

export function shareTargetFor(row: AgreementRow): ShareTarget | null {
  if (row.kind === 'sent') return sentShareTarget(row.envelopeId, row.subject, row.status);
  if (row.kind === 'received') return receivedShareTarget(row.item);
  return null;
}

export interface ShareFilePort {
  /** Write base64 bytes to a NEW file in the app's cache; returns its file URI. */
  writeTemp(filename: string, base64: string): Promise<string>;
  /** Delete a file written by writeTemp (never throws). */
  remove(uri: string): void;
}

export interface ShareSheetPort {
  available(): Promise<boolean>;
  /** Resolves when the OS share sheet is dismissed. */
  open(
    uri: string,
    options: { readonly mimeType: string; readonly dialogTitle: string },
  ): Promise<void>;
}

export interface ShareDeps {
  readonly workspace: WorkspaceClient;
  readonly guest: GuestSigningClient;
  readonly files: ShareFilePort;
  readonly sheet: ShareSheetPort;
}

export type ShareOutcome =
  | { readonly kind: 'shared'; readonly files: number }
  | { readonly kind: 'refused'; readonly message: string };

export const SHARE_UNAVAILABLE = 'Sharing isn’t available on this device.';
export const SHARE_NOT_READY = 'The signed copy isn’t ready yet.';
export const SHARE_NOT_ALLOWED = 'Only a completed agreement can be shared.';

const PDF = 'application/pdf';

interface Pdf {
  readonly title: string;
  readonly base64: string;
}

/** A safe cache filename from a document title, always ending in .pdf. */
export function pdfFilename(title: string, index = 0): string {
  const base = title
    .replace(/\.pdf$/i, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || `Agreement ${index + 1}`}.pdf`;
}

async function senderPdfs(workspace: WorkspaceClient, envelopeId: string): Promise<Pdf[]> {
  const r = await workspace.call('/v1/sign/sender/envelopes/{id}/executed', 'get', {
    path: { id: envelopeId },
  });
  return r.documents.map((d) => ({ title: d.title, base64: d.executed_base64 }));
}

async function recipientPdfs(deps: ShareDeps, inboxItemId: string): Promise<Pdf[] | null> {
  const token = await signedCopyToken(deps.workspace, inboxItemId);
  if (!token) return null;
  const session = deps.guest.open(token);
  try {
    const copy = await loadExecutedCopy(session);
    return copy.documents
      .filter((d) => !d.content_type || d.content_type === PDF)
      .map((d) => ({ title: d.title, base64: d.executed_base64 }));
  } finally {
    session.discard();
  }
}

function refusal(e: unknown): ShareOutcome {
  if (isApiError(e) && e.status === 409) return { kind: 'refused', message: SHARE_NOT_READY };
  return {
    kind: 'refused',
    message: isApiError(e)
      ? refusalMessage(e)
      : refusalMessage({ reason: 'unknown', code: 'unknown' }),
  };
}

export async function shareCompleted(
  target: ShareTarget | null,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  if (!target) return { kind: 'refused', message: SHARE_NOT_ALLOWED };
  if (!(await deps.sheet.available())) return { kind: 'refused', message: SHARE_UNAVAILABLE };
  let pdfs: Pdf[] | null;
  try {
    pdfs =
      target.kind === 'sent'
        ? await senderPdfs(deps.workspace, target.envelopeId)
        : await recipientPdfs(deps, target.inboxItemId);
  } catch (e) {
    return refusal(e);
  }
  if (!pdfs || pdfs.length === 0) return { kind: 'refused', message: SHARE_NOT_READY };
  let shared = 0;
  for (const [i, pdf] of pdfs.entries()) {
    let uri: string | null = null;
    try {
      uri = await deps.files.writeTemp(pdfFilename(pdf.title, i), pdf.base64);
      await deps.sheet.open(uri, { mimeType: PDF, dialogTitle: target.subject });
      shared += 1;
    } catch (e) {
      return shared > 0 ? { kind: 'shared', files: shared } : refusal(e);
    } finally {
      if (uri) deps.files.remove(uri);
    }
  }
  return { kind: 'shared', files: shared };
}
