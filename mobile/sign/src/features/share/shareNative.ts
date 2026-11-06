// Production ports for shareCompleted.ts: a per-share folder in the app's CACHE
// (expo-file-system) and the OS share sheet (expo-sharing). Files are deleted right after
// the sheet closes; anything a crash left behind is swept on the next share.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { SHARE_TEMP_DIR } from '../../security/documentTempFiles';
import { base64Decode } from '../../util/bytes';
import { randomId } from '../../util/ids';
import type { SaveFolderPort } from './saveCopy';
import type { ShareFilePort, ShareSheetPort } from './shareCompleted';

// Also wiped at app start and sign-out with the viewer temp files (security/documentTempFiles.ts).
const SHARE_DIR = SHARE_TEMP_DIR;

function shareRoot(): Directory {
  return new Directory(Paths.cache, SHARE_DIR);
}

/** Remove every leftover shared file (a crash between write and delete). */
export function sweepShareCache(): void {
  try {
    const root = shareRoot();
    if (root.exists) root.delete();
  } catch {
    // nothing to sweep
  }
}

export const nativeShareFiles: ShareFilePort = {
  async writeTemp(filename, base64) {
    const dir = new Directory(shareRoot(), randomId());
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, filename);
    file.create({ overwrite: true });
    file.write(base64, { encoding: 'base64' });
    return file.uri;
  },
  remove(uri) {
    try {
      const file = new File(uri);
      const dir = file.parentDirectory;
      if (file.exists) file.delete();
      if (dir.exists && dir.list().length === 0) dir.delete();
    } catch {
      // already gone
    }
  },
};

export const nativeShareSheet: ShareSheetPort = {
  available: () => Sharing.isAvailableAsync(),
  open: (uri, { mimeType, dialogTitle }) =>
    Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI: 'com.adobe.pdf' }),
};

/**
 * M-A13 #7 — Android "Save a copy": the system folder picker (Storage Access Framework).
 * The PDF is written straight into the chosen folder; the picker resolves to a folder the
 * app may write to for this session only.
 */
export const nativeSaveFolder: SaveFolderPort = {
  async pick() {
    let dir: Directory;
    try {
      dir = await Directory.pickDirectoryAsync();
    } catch (e) {
      if (isPickerCancel(e)) return null;
      throw e;
    }
    return {
      async writePdf(filename, base64) {
        const file = dir.createFile(filename, 'application/pdf');
        file.write(base64Decode(base64));
      },
    };
  },
};

function isPickerCancel(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : '';
  return (typeof code === 'string' && /CANCEL/i.test(code)) || /cancel/i.test(message);
}
