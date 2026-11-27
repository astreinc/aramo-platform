import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { SignFolderNameTakenError, SignUserFolderRepository, type SignFolderItemKind } from '@aramo/sign';
import {
  DELETED_FOLDER,
  FOLDER_COPY,
  FOLDER_NAME_MAX,
  FOLDERS_PER_USER_MAX,
  canCreateFolder,
  folderNameRefusal,
  isUserFolderId,
  normalizeFolderName,
} from '@aramo/sign-client';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — the signed-in user's own folders (/v1/sign/folders). Per
// user within the tenant: every read and write is keyed by the token's tenant and subject, so
// another user's folder is never seen (404). The rules (name, cap, copy) are @aramo/sign-client
// folders.ts, the same copy web and the app show. Deleting a folder never deletes an envelope.
// The system Deleted folder is separate and unchanged.

export function folderNotFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'Folder not found', 404, { requestId, details: { reason: 'folder_not_found' } });
}

function refused(requestId: string, reason: keyof typeof FOLDER_COPY): AramoError {
  return new AramoError('VALIDATION_ERROR', FOLDER_COPY[reason], 400, { requestId, details: { reason } });
}

/** The `folder` list value: the Deleted folder, a user folder id, or absent. Anything else is refused. */
export function parseFolderParam(folder: string | undefined, requestId: string): { kind: 'all' } | { kind: 'deleted' } | { kind: 'user'; id: string } {
  if (folder === undefined) return { kind: 'all' };
  if (folder === DELETED_FOLDER) return { kind: 'deleted' };
  if (isUserFolderId(folder)) return { kind: 'user', id: folder.toLowerCase() };
  throw new AramoError('VALIDATION_ERROR', 'unknown folder', 400, { requestId, details: { folder } });
}

/** The `folder_id` of a move request (a uuid). */
export function folderIdOf(body: { folder_id?: unknown } | undefined, requestId: string): string {
  const id = body?.folder_id;
  if (typeof id !== 'string' || !isUserFolderId(id)) throw new AramoError('VALIDATION_ERROR', 'folder_id is required', 400, { requestId, details: { reason: 'folder_id_required' } });
  return id.toLowerCase();
}

@Injectable()
export class SignFoldersService {
  constructor(private readonly folders: SignUserFolderRepository) {}

  async list(auth: AuthContextType) {
    const rows = await this.folders.list(auth.tenant_id, auth.sub);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
        sender_items: r.sender_items,
        recipient_items: r.recipient_items,
      })),
      limit: FOLDERS_PER_USER_MAX,
      name_max: FOLDER_NAME_MAX,
      can_create: canCreateFolder(rows.length),
    };
  }

  async create(auth: AuthContextType, body: { name?: unknown } | undefined, requestId: string) {
    const existing = await this.folders.list(auth.tenant_id, auth.sub);
    if (!canCreateFolder(existing.length)) throw refused(requestId, 'folder_limit_reached');
    const name = this.validName(body, existing.map((f) => f.name), requestId);
    const { id } = await this.write(requestId, () => this.folders.create(auth.tenant_id, auth.sub, name));
    return this.one(auth, id, requestId);
  }

  async rename(auth: AuthContextType, id: string, body: { name?: unknown } | undefined, requestId: string) {
    if (!isUserFolderId(id)) throw folderNotFound(requestId);
    const existing = await this.folders.list(auth.tenant_id, auth.sub);
    if (!existing.some((f) => f.id === id)) throw folderNotFound(requestId);
    const name = this.validName(body, existing.filter((f) => f.id !== id).map((f) => f.name), requestId);
    if (!(await this.write(requestId, () => this.folders.rename(auth.tenant_id, auth.sub, id, name)))) throw folderNotFound(requestId);
    return this.one(auth, id, requestId);
  }

  /** The folder and its items go; every envelope stays where it is. */
  async remove(auth: AuthContextType, id: string, requestId: string) {
    if (!isUserFolderId(id) || !(await this.folders.remove(auth.tenant_id, auth.sub, id))) throw folderNotFound(requestId);
    return { deleted: true };
  }

  // ── Membership (the sender and inbox services check the item is the user's first) ──

  async place(auth: AuthContextType, folder_id: string, kind: SignFolderItemKind, item_ref: string, requestId: string) {
    if (!(await this.folders.place(auth.tenant_id, auth.sub, folder_id, kind, item_ref))) throw folderNotFound(requestId);
    return { folder_id };
  }

  async unplace(auth: AuthContextType, kind: SignFolderItemKind, item_ref: string) {
    await this.folders.unplace(auth.tenant_id, auth.sub, kind, item_ref);
    return { folder_id: null };
  }

  /** item_ref → folder id, for the list views. */
  placements(auth: AuthContextType, kind: SignFolderItemKind): Promise<Map<string, string>> {
    return this.folders.placements(auth.tenant_id, auth.sub, kind);
  }

  /** The item refs of one of the user's folders; 404 when the folder is not theirs. */
  async itemRefs(auth: AuthContextType, folder_id: string, kind: SignFolderItemKind, requestId: string): Promise<string[]> {
    if ((await this.folders.find(auth.tenant_id, auth.sub, folder_id)) === null) throw folderNotFound(requestId);
    return this.folders.itemRefs(auth.tenant_id, auth.sub, folder_id, kind);
  }

  private validName(body: { name?: unknown } | undefined, others: string[], requestId: string): string {
    const raw = typeof body?.name === 'string' ? body.name : '';
    const refusal = folderNameRefusal(raw, others);
    if (refusal !== null) throw refused(requestId, refusal);
    return normalizeFolderName(raw);
  }

  private async write<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // A concurrent create with the same name (the unique index decides).
      if (e instanceof SignFolderNameTakenError) throw refused(requestId, 'folder_name_taken');
      throw e;
    }
  }

  private async one(auth: AuthContextType, id: string, requestId: string) {
    const f = (await this.list(auth)).items.find((x) => x.id === id);
    if (f === undefined) throw folderNotFound(requestId);
    return f;
  }
}
