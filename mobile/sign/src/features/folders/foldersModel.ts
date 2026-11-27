// SIGN-FREE-PARITY-1 S7 — the Agreements folder filter. Pure. Each sent row and received item
// carries the server's `folder_id` (the user's own folder holding it, or null); the chip
// filter keeps only the rows in the chosen folder. On-device drafts are in no folder.
import type { AgreementRow } from '../inbox/agreementsModel';
import type { FolderTarget, SignFolder } from './foldersApi';

/** The user's folder holding this row, or null. */
export function rowFolderId(row: AgreementRow): string | null {
  if (row.kind === 'local-draft') return null;
  return row.item.folder_id ?? null;
}

/** Only the rows in `folderId`; every row when null (no folder chosen). */
export function inFolder(rows: readonly AgreementRow[], folderId: string | null): AgreementRow[] {
  return folderId === null ? [...rows] : rows.filter((r) => rowFolderId(r) === folderId);
}

/** A row the user can move (on-device drafts are not on the server yet). */
export function folderTargetFor(row: AgreementRow): FolderTarget | null {
  if (row.kind === 'sent') return { kind: 'sender', id: row.envelopeId, subject: row.subject, folderId: rowFolderId(row) };
  if (row.kind === 'received') return { kind: 'inbox', id: row.inboxItemId, subject: row.subject, folderId: rowFolderId(row) };
  return null;
}

/** The chosen folder, or null when it is gone (deleted elsewhere): the list then shows everything. */
export function chosenFolder(folders: readonly SignFolder[] | undefined, folderId: string | null): SignFolder | null {
  if (folderId === null) return null;
  return folders?.find((f) => f.id === folderId) ?? null;
}
