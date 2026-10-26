// Production adapters for the encrypted store: expo-crypto AES-GCM + expo-file-system.
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { secureKeyValue } from '../auth/secureKeyValue';
import { base64Decode, base64Encode } from '../util/bytes';
import {
  createEncryptedStore,
  type CipherPort,
  type EncryptedStore,
  type FilePort,
} from './encryptedStore';

export const aesGcmCipher: CipherPort = {
  async generateKey() {
    const k = await AESEncryptionKey.generate();
    return k.encoded('base64');
  },
  async encrypt(plaintext, keyB64, aad) {
    const k = await AESEncryptionKey.import(keyB64, 'base64');
    const sealed = await aesEncryptAsync(plaintext, k, { additionalData: aad });
    return base64Encode(await sealed.combined('bytes'));
  },
  async decrypt(sealedB64, keyB64, aad) {
    const k = await AESEncryptionKey.import(keyB64, 'base64');
    const sealed = AESSealedData.fromCombined(base64Decode(sealedB64));
    return aesDecryptAsync(sealed, k, { additionalData: aad });
  },
};

function storeDir(): Directory {
  const dir = new Directory(Paths.document, 'aramo-sign-store');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export const documentFiles: FilePort = {
  async read(name) {
    const f = new File(storeDir(), name);
    return f.exists ? f.text() : null;
  },
  async write(name, contents) {
    // Write-then-rename so a crash never leaves a half-written slot.
    const dir = storeDir();
    const tmp = new File(dir, `${name}.tmp`);
    tmp.write(contents);
    const target = new File(dir, name);
    if (target.exists) target.delete();
    tmp.move(target);
  },
  async remove(name) {
    const f = new File(storeDir(), name);
    if (f.exists) f.delete();
  },
  async list() {
    return storeDir()
      .list()
      .filter((e): e is File => e instanceof File)
      .map((f) => f.name)
      .filter((n) => !n.endsWith('.tmp'));
  },
};

let shared: EncryptedStore | null = null;

export function encryptedStore(): EncryptedStore {
  shared ??= createEncryptedStore({
    kv: secureKeyValue,
    cipher: aesGcmCipher,
    files: documentFiles,
  });
  return shared;
}
