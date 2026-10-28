// M-A7 §4 R-7: no decrypted document stays on the device indefinitely. The temp-file rules
// (viewer close, sign-out / session end, app start, legacy renderer copies) run against an
// in-memory cache.
import {
  createDocumentTempFiles,
  DOC_TEMP_DIR,
  SHARE_TEMP_DIR,
  wireDocumentTempCleanup,
  type TempFsPort,
} from '../documentTempFiles';

const SHA1_NAME = `${'a1b2c3d4e5'.repeat(4)}.pdf`;

function memoryCache(): TempFsPort & { files: Map<string, string>; failDownload: boolean } {
  const files = new Map<string, string>(); // path under the cache -> contents
  const path = (dir: string, name: string) => `${dir}/${name}`;
  const uri = (p: string) => `file:///cache/${p}`;
  const fromUri = (u: string) => u.replace('file:///cache/', '');
  const fs = {
    files,
    failDownload: false,
    writeBase64(dir: string, name: string, base64: string) {
      files.set(path(dir, name), base64);
      return uri(path(dir, name));
    },
    async download(dir: string, name: string, url: string) {
      files.set(path(dir, name), `partial:${url}`);
      if (fs.failDownload) throw new Error('response has status: 403');
      files.set(path(dir, name), `downloaded:${url}`);
      return uri(path(dir, name));
    },
    uriOf: (dir: string, name: string) => uri(path(dir, name)),
    removeFile(u: string) {
      files.delete(fromUri(u));
    },
    removeDir(dir: string) {
      for (const k of [...files.keys()]) if (k.startsWith(`${dir}/`)) files.delete(k);
    },
    listCacheRoot: () => [...files.keys()].filter((k) => !k.includes('/')),
    removeCacheRootFile(name: string) {
      files.delete(name);
    },
  };
  return fs;
}

function setup() {
  const fs = memoryCache();
  let n = 0;
  const temp = createDocumentTempFiles(fs, () => `id${++n}`);
  return { fs, temp };
}

describe('document temp files (M-A7 R-7)', () => {
  it('writes a shown document into the app temp folder and deletes it when the viewer closes', () => {
    const { fs, temp } = setup();
    const lease = temp.acquireBase64('JVBERi0x');
    expect(lease.uri).toBe(`file:///cache/${DOC_TEMP_DIR}/id1.pdf`);
    expect(fs.files.get(`${DOC_TEMP_DIR}/id1.pdf`)).toBe('JVBERi0x');
    lease.release();
    expect(fs.files.size).toBe(0);
  });

  it('shares one file between page views of the same document; the last one deletes it', () => {
    const { fs, temp } = setup();
    const a = temp.acquireBase64('JVBERi0x');
    const b = temp.acquireBase64('JVBERi0x');
    expect(b.uri).toBe(a.uri);
    expect(fs.files.size).toBe(1);
    a.release();
    a.release(); // idempotent: never steals b's reference
    expect(fs.files.size).toBe(1);
    b.release();
    expect(fs.files.size).toBe(0);
    // A later view writes a fresh file.
    const c = temp.acquireBase64('JVBERi0x');
    expect(c.uri).not.toBe(a.uri);
    expect(fs.files.size).toBe(1);
  });

  it('keeps different documents in different files', () => {
    const { fs, temp } = setup();
    const a = temp.acquireBase64('AAAA');
    const b = temp.acquireBase64('BBBB');
    expect(a.uri).not.toBe(b.uri);
    a.release();
    expect([...fs.files.values()]).toEqual(['BBBB']);
  });

  it('deletes a downloaded document on release, and a partial download on failure', async () => {
    const { fs, temp } = setup();
    const lease = await temp.download('https://sign.aramo.ai/doc', { Authorization: 'Bearer x' });
    expect(fs.files.size).toBe(1);
    lease.release();
    expect(fs.files.size).toBe(0);

    fs.failDownload = true;
    await expect(temp.download('https://sign.aramo.ai/doc', {})).rejects.toThrow('403');
    expect(fs.files.size).toBe(0);
  });

  it('wipe removes viewer files, share copies and the renderer’s legacy cache copies only', () => {
    const { fs, temp } = setup();
    const open = temp.acquireBase64('JVBERi0x');
    fs.files.set(`${SHARE_TEMP_DIR}/x/Agreement.pdf`, 'share');
    fs.files.set(SHA1_NAME, 'legacy');
    fs.files.set(`${SHA1_NAME}.tmp`, 'legacy partial');
    fs.files.set('other-library-file.json', 'keep');
    fs.files.set('aramo-sign-store/state.enc', 'keep');

    temp.wipe();

    expect([...fs.files.keys()].sort()).toEqual([
      'aramo-sign-store/state.enc',
      'other-library-file.json',
    ]);
    // A viewer still holding a pre-wipe lease releasing late is harmless.
    open.release();
    const next = temp.acquireBase64('JVBERi0x');
    expect(next.uri).toBe(`file:///cache/${DOC_TEMP_DIR}/id2.pdf`);
    open.release();
    expect(fs.files.get(`${DOC_TEMP_DIR}/id2.pdf`)).toBe('JVBERi0x');
  });

  it('wipe survives a cache listing failure', () => {
    const { fs, temp } = setup();
    temp.acquireBase64('JVBERi0x');
    fs.listCacheRoot = () => {
      throw new Error('io');
    };
    expect(() => temp.wipe()).not.toThrow();
    expect(fs.files.size).toBe(0);
  });
});

describe('wireDocumentTempCleanup (app start, sign-out, session end)', () => {
  type Status = 'restoring' | 'signedOut' | 'signedIn';
  function fakeSession(initial: Status) {
    let status = initial;
    const listeners = new Set<(s: { status: Status }) => void>();
    return {
      snapshot: () => ({ status }),
      subscribe(fn: (s: { status: Status }) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      go(next: Status) {
        status = next;
        for (const l of listeners) l({ status });
      },
    };
  }

  it('wipes at start (interrupted-session sweep) and when a signed-in session ends', () => {
    const session = fakeSession('restoring');
    const wipe = jest.fn();
    const stop = wireDocumentTempCleanup(session, { wipe });
    expect(wipe).toHaveBeenCalledTimes(1); // app start

    session.go('signedIn'); // restore found a session
    expect(wipe).toHaveBeenCalledTimes(1);
    session.go('signedOut'); // sign-out, close, revoke or expiry
    expect(wipe).toHaveBeenCalledTimes(2);
    session.go('signedOut'); // no repeated wipe while already signed out
    expect(wipe).toHaveBeenCalledTimes(2);

    stop();
    session.go('signedIn');
    session.go('signedOut');
    expect(wipe).toHaveBeenCalledTimes(2);
  });

  it('does not wipe when restore finds no session (a guest flow may be starting)', () => {
    const session = fakeSession('restoring');
    const wipe = jest.fn();
    wireDocumentTempCleanup(session, { wipe });
    session.go('signedOut');
    expect(wipe).toHaveBeenCalledTimes(1);
  });
});
