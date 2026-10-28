// Decrypted documents on the device (M-A7 §4 R-7): the native PDF renderer needs a file,
// so a document being shown is written to ONE app-private temp folder this module owns
// (the app cache, `aramo-docs/`). No decrypted document stays there indefinitely:
//   - a viewer releases its file when it closes (unmount);
//   - sign-out, the session ending, and account close/deletion (which sign out) wipe it;
//   - app start wipes it, so a crash or kill mid-view is cleaned on the next start.
// The wipe also removes the share sheet's temp folder and the `<sha1>.pdf` files the
// renderer used to write into the cache root (react-native-pdf's default for data: and
// https: sources), so copies left by earlier builds are removed too.
//
// The file-system is a port so the cleanup rules are unit-tested without a device.

/** Folder (under the app cache) that holds documents being shown. */
export const DOC_TEMP_DIR = 'aramo-docs';
/** Folder (under the app cache) the share sheet writes its temp copies into. */
export const SHARE_TEMP_DIR = 'aramo-share';
/** react-native-pdf's own cache name: SHA-1 hex of the source URI + `.pdf` (+ `.tmp`). */
export const LEGACY_RENDERER_FILE = /^[0-9a-f]{40}\.pdf(\.tmp)?$/i;

export interface TempFsPort {
  /** Write base64 bytes to `<cache>/<dir>/<name>` (creating `dir`); returns a file:// URI. */
  writeBase64(dir: string, name: string, base64: string): string;
  /** Download `url` to `<cache>/<dir>/<name>` (creating `dir`); returns a file:// URI. */
  download(
    dir: string,
    name: string,
    url: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<string>;
  /** The file:// URI `<cache>/<dir>/<name>` would have (nothing is written). */
  uriOf(dir: string, name: string): string;
  /** Delete one file by URI. Never throws. */
  removeFile(uri: string): void;
  /** Delete `<cache>/<dir>` and everything in it. Never throws. */
  removeDir(dir: string): void;
  /** File names directly in the cache root. */
  listCacheRoot(): string[];
  /** Delete `<cache>/<name>`. Never throws. */
  removeCacheRootFile(name: string): void;
}

export interface TempPdfLease {
  readonly uri: string;
  /** Give the file back; the last holder deletes it. Idempotent. */
  release(): void;
}

export interface DocumentTempFiles {
  /**
   * The file for a base64 document. Viewers showing the same bytes at once (one per page in
   * the editor) share ONE file; it is deleted when the last of them releases it.
   */
  acquireBase64(base64: string): TempPdfLease;
  /** Download a document into the temp folder; the lease deletes it on release. */
  download(url: string, headers: Readonly<Record<string, string>>): Promise<TempPdfLease>;
  /** Remove every document temp file (sign-out, session end, app start). */
  wipe(): void;
}

export function createDocumentTempFiles(fs: TempFsPort, newId: () => string): DocumentTempFiles {
  // Shared files for base64 sources, keyed by the bytes themselves (exact, no collisions).
  const shared = new Map<string, { uri: string; refs: number }>();
  // Bumped on wipe: a lease from before a wipe never touches the registry again.
  let generation = 0;

  function lease(uri: string, onRelease: () => void): TempPdfLease {
    let released = false;
    return {
      uri,
      release() {
        if (released) return;
        released = true;
        onRelease();
      },
    };
  }

  return {
    acquireBase64(base64) {
      const hit = shared.get(base64);
      const gen = generation;
      let entry = hit;
      if (!entry) {
        entry = { uri: fs.writeBase64(DOC_TEMP_DIR, `${newId()}.pdf`, base64), refs: 0 };
        shared.set(base64, entry);
      }
      entry.refs += 1;
      const mine = entry;
      return lease(mine.uri, () => {
        if (gen !== generation) return; // already wiped
        mine.refs -= 1;
        if (mine.refs > 0) return;
        if (shared.get(base64) === mine) shared.delete(base64);
        fs.removeFile(mine.uri);
      });
    },

    async download(url, headers) {
      const name = `${newId()}.pdf`;
      try {
        const uri = await fs.download(DOC_TEMP_DIR, name, url, headers);
        return lease(uri, () => fs.removeFile(uri));
      } catch (e) {
        // Android streams into the destination: a failed download can leave a partial file.
        fs.removeFile(fs.uriOf(DOC_TEMP_DIR, name));
        throw e;
      }
    },

    wipe() {
      generation += 1;
      shared.clear();
      fs.removeDir(DOC_TEMP_DIR);
      fs.removeDir(SHARE_TEMP_DIR);
      let names: string[] = [];
      try {
        names = fs.listCacheRoot();
      } catch {
        names = [];
      }
      for (const n of names) if (LEGACY_RENDERER_FILE.test(n)) fs.removeCacheRootFile(n);
    },
  };
}

type SessionStatusLike = 'restoring' | 'signedOut' | 'signedIn';

/**
 * Wipe now (app start: a crash or kill mid-view is cleaned up) and whenever a signed-in
 * session ends: sign-out, account close or deletion (both sign out), revocation, expiry.
 */
export function wireDocumentTempCleanup(
  session: {
    snapshot(): { readonly status: SessionStatusLike };
    subscribe(fn: (s: { readonly status: SessionStatusLike }) => void): () => void;
  },
  files: Pick<DocumentTempFiles, 'wipe'>,
): () => void {
  files.wipe();
  let was = session.snapshot().status;
  return session.subscribe((s) => {
    if (was === 'signedIn' && s.status === 'signedOut') files.wipe();
    was = s.status;
  });
}
