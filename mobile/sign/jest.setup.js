/* global jest, Buffer */
// Node implementations of the native modules the unit tests exercise.

require('react-native-gesture-handler/jestSetup');

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  getRandomBytes: (n) => new Uint8Array(require('node:crypto').randomBytes(n)),
  randomUUID: () => require('node:crypto').randomUUID(),
  digest: async (_alg, data) => {
    const out = require('node:crypto').createHash('sha256').update(Buffer.from(data)).digest();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  },
}));

jest.mock('expo-secure-store', () => {
  const items = new Map();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    __items: items,
    getItemAsync: jest.fn(async (k) => (items.has(k) ? items.get(k) : null)),
    setItemAsync: jest.fn(async (k, v) => {
      items.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k) => {
      items.delete(k);
    }),
  };
});

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// The document temp folder (M-A7 R-7) as an in-memory registry: component tests get a
// file:// URI without touching expo-file-system. Its rules are tested in
// src/security/__tests__/documentTempFiles.test.ts.
jest.mock('./src/security/documentTempFilesNative', () => {
  const { createDocumentTempFiles } = jest.requireActual('./src/security/documentTempFiles');
  let n = 0;
  const fs = {
    writeBase64: (dir, name) => `file:///cache/${dir}/${name}`,
    download: async (dir, name) => `file:///cache/${dir}/${name}`,
    uriOf: (dir, name) => `file:///cache/${dir}/${name}`,
    removeFile: () => undefined,
    removeDir: () => undefined,
    listCacheRoot: () => [],
    removeCacheRootFile: () => undefined,
  };
  return {
    cacheTempFs: fs,
    documentTempFiles: createDocumentTempFiles(fs, () => `doc${++n}`),
  };
});
