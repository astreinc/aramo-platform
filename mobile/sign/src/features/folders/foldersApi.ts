// SIGN-FREE-PARITY-1 S7 (FP-R8) — the user's own folders, the same server routes the web uses:
//   GET/POST          /v1/sign/folders
//   PATCH/DELETE      /v1/sign/folders/{id}
//   PUT/DELETE        /v1/sign/sender/envelopes/{id}/folder   (an envelope the user can see)
//   PUT/DELETE        /v1/sign/inbox/{id}/folder              (a received item id or handle)
// The server decides (owner, name rule, cap); the copy is @aramo/sign-client folders.ts.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { components } from '../../api/generated/sign';
import type { WorkspaceClient } from '../../api/workspaceClient';

export type SignFolder = components['schemas']['SignFolder'];
export type SignFolderList = components['schemas']['SignFolderList'];

/** What a "Move to folder" acts on: an envelope the user sent, or a document they received. */
export type FolderTarget =
  | { readonly kind: 'sender'; readonly id: string; readonly subject: string; readonly folderId: string | null }
  | { readonly kind: 'inbox'; readonly id: string; readonly subject: string; readonly folderId: string | null };

export type FolderOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const FAILED = 'Couldn’t save that. Try again.';

async function attempt(work: () => Promise<unknown>): Promise<FolderOutcome> {
  try {
    await work();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: isApiError(e) ? refusalMessage(e) : FAILED };
  }
}

export async function fetchFolders(workspace: WorkspaceClient): Promise<SignFolderList> {
  return workspace.call('/v1/sign/folders', 'get', {});
}

export async function createFolder(workspace: WorkspaceClient, name: string): Promise<{ ok: true; folder: SignFolder } | { ok: false; message: string }> {
  try {
    return { ok: true, folder: await workspace.call('/v1/sign/folders', 'post', { body: { name } }) };
  } catch (e) {
    return { ok: false, message: isApiError(e) ? refusalMessage(e) : FAILED };
  }
}

export function renameFolder(workspace: WorkspaceClient, id: string, name: string): Promise<FolderOutcome> {
  return attempt(() => workspace.call('/v1/sign/folders/{id}', 'patch', { path: { id }, body: { name } }));
}

export function deleteFolder(workspace: WorkspaceClient, id: string): Promise<FolderOutcome> {
  return attempt(() => workspace.call('/v1/sign/folders/{id}', 'delete', { path: { id } }));
}

export function moveToFolder(workspace: WorkspaceClient, target: FolderTarget, folderId: string): Promise<FolderOutcome> {
  return attempt(() =>
    target.kind === 'sender'
      ? workspace.call('/v1/sign/sender/envelopes/{id}/folder', 'put', { path: { id: target.id }, body: { folder_id: folderId } })
      : workspace.call('/v1/sign/inbox/{id}/folder', 'put', { path: { id: target.id }, body: { folder_id: folderId } }),
  );
}

export function removeFromFolder(workspace: WorkspaceClient, target: FolderTarget): Promise<FolderOutcome> {
  return attempt(() =>
    target.kind === 'sender'
      ? workspace.call('/v1/sign/sender/envelopes/{id}/folder', 'delete', { path: { id: target.id } })
      : workspace.call('/v1/sign/inbox/{id}/folder', 'delete', { path: { id: target.id } }),
  );
}
