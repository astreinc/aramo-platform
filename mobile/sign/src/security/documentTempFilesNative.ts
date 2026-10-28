// Production port for documentTempFiles.ts: the app's private cache (expo-file-system).
// The cache is app-private (no other app can read it, no storage permission involved) and
// is never part of Android backup (allowBackup=false; the backup rules list no cache).
import { Directory, File, Paths } from 'expo-file-system';

import { randomId } from '../util/ids';
import {
  createDocumentTempFiles,
  type DocumentTempFiles,
  type TempFsPort,
} from './documentTempFiles';

function dirOf(name: string): Directory {
  const d = new Directory(Paths.cache, name);
  d.create({ intermediates: true, idempotent: true });
  return d;
}

export const cacheTempFs: TempFsPort = {
  writeBase64(dir, name, base64) {
    const f = new File(dirOf(dir), name);
    f.create({ overwrite: true });
    f.write(base64, { encoding: 'base64' });
    return f.uri;
  },
  async download(dir, name, url, headers) {
    const f = await File.downloadFileAsync(url, new File(dirOf(dir), name), {
      headers: { ...headers },
      idempotent: true,
    });
    return f.uri;
  },
  uriOf(dir, name) {
    return new File(Paths.cache, dir, name).uri;
  },
  removeFile(uri) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  },
  removeDir(name) {
    try {
      const d = new Directory(Paths.cache, name);
      if (d.exists) d.delete();
    } catch {
      // nothing to remove
    }
  },
  listCacheRoot() {
    return Paths.cache
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.name);
  },
  removeCacheRootFile(name) {
    try {
      const f = new File(Paths.cache, name);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  },
};

/** The app-wide instance (one registry, so shared files are counted once). */
export const documentTempFiles: DocumentTempFiles = createDocumentTempFiles(cacheTempFs, randomId);
