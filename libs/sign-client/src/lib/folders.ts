// SIGN-FREE-PARITY-1 S7 — a user's own folders for envelopes. ONE rule for sign-service
// (which decides), Sign web and the Aramo Sign app (which show the same limits and copy).
// Folders belong to one user (FP-R8). An envelope the user sent, or a document they
// received, sits in at most one of their folders; moving it replaces the folder. Deleting a
// folder never deletes an envelope. The system "Deleted" folder is separate and unchanged.
//
// Pure TypeScript ESM, no dependency (type:client-shared).

/** The longest folder name, in characters (after trimming). */
export const FOLDER_NAME_MAX = 60;

/** The most folders one user may have. */
export const FOLDERS_PER_USER_MAX = 100;

/** The list `folder` value of the system Deleted folder (a user folder is its uuid). */
export const DELETED_FOLDER = 'deleted';

export type FolderNameRefusal = 'folder_name_empty' | 'folder_name_too_long' | 'folder_name_taken';

/** The name as stored: trimmed, inner runs of white space made one space. */
export function normalizeFolderName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Why a folder name is refused, or null when it may be used. `existing` are the user's other
 * folder names (the folder being renamed left out); names are compared without case.
 */
export function folderNameRefusal(name: string, existing: readonly string[] = []): FolderNameRefusal | null {
  const n = normalizeFolderName(name);
  if (n.length === 0) return 'folder_name_empty';
  if ([...n].length > FOLDER_NAME_MAX) return 'folder_name_too_long';
  const key = n.toLowerCase();
  if (existing.some((e) => normalizeFolderName(e).toLowerCase() === key)) return 'folder_name_taken';
  return null;
}

/** True when the user may make another folder. */
export function canCreateFolder(folderCount: number): boolean {
  return folderCount < FOLDERS_PER_USER_MAX;
}

/** The plain message for each refusal (the server sends the same text). */
export const FOLDER_COPY = {
  folder_name_empty: 'Enter a folder name.',
  folder_name_too_long: `Use ${FOLDER_NAME_MAX} characters or fewer.`,
  folder_name_taken: 'You already have a folder with this name.',
  folder_limit_reached: `You can have up to ${FOLDERS_PER_USER_MAX} folders.`,
  folder_not_found: 'This folder isn’t available any more.',
  delete_note: 'The envelopes in it are not deleted.',
} as const;

export type FolderCopyKey = keyof typeof FOLDER_COPY;

/** True for a user-folder `folder` value (a uuid); false for "deleted" or anything else. */
export function isUserFolderId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
