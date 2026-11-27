// Runs under vitest and mobile Jest (globals only).
import {
  DELETED_FOLDER,
  FOLDER_COPY,
  FOLDER_NAME_MAX,
  FOLDERS_PER_USER_MAX,
  canCreateFolder,
  folderNameRefusal,
  isUserFolderId,
  normalizeFolderName,
} from '../index.js';

// SIGN-FREE-PARITY-1 S7 — a user's own folders.
describe('folders', () => {
  it('normalizes white space', () => {
    expect(normalizeFolderName('  Tax   2026 \n')).toBe('Tax 2026');
  });

  it('refuses an empty, long or taken name', () => {
    expect(folderNameRefusal('   ')).toBe('folder_name_empty');
    expect(folderNameRefusal('x'.repeat(FOLDER_NAME_MAX))).toBeNull();
    expect(folderNameRefusal('x'.repeat(FOLDER_NAME_MAX + 1))).toBe('folder_name_too_long');
    expect(folderNameRefusal('tax  2026', ['Tax 2026'])).toBe('folder_name_taken');
    expect(folderNameRefusal('Leases', ['Tax 2026'])).toBeNull();
  });

  it('caps folders per user', () => {
    expect(canCreateFolder(FOLDERS_PER_USER_MAX - 1)).toBe(true);
    expect(canCreateFolder(FOLDERS_PER_USER_MAX)).toBe(false);
  });

  it('tells a user folder id from the Deleted folder', () => {
    expect(isUserFolderId(DELETED_FOLDER)).toBe(false);
    expect(isUserFolderId('2b1f4c7e-1d2a-4f00-9c1e-0a1b2c3d4e5f')).toBe(true);
  });

  it('has copy for every refusal', () => {
    for (const k of ['folder_name_empty', 'folder_name_too_long', 'folder_name_taken', 'folder_limit_reached'] as const) {
      expect(FOLDER_COPY[k].length).toBeGreaterThan(0);
    }
  });
});
