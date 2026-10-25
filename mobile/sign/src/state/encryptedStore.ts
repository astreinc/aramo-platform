// Encrypted on-device blob store (directive §9 "Local draft preparation persists in
// encrypted on-device storage"; M-A3). AES-256-GCM with a random per-installation key
// held in the Keychain / Keystore; ciphertext files live in the app's private document
// directory. The slot name is bound as GCM additional data, so a file renamed to
// another slot fails to decrypt. Values are UTF-8 strings (callers store JSON).
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from '../util/bytes';
import { SECURE_KEYS, type SecureKeyValue } from '../auth/secureKeyValue';

export interface CipherPort {
  /** New random 256-bit key, base64. */
  generateKey(): Promise<string>;
  /** Returns base64 of iv || ciphertext || tag. */
  encrypt(plaintext: Uint8Array, keyB64: string, aad: Uint8Array): Promise<string>;
  decrypt(sealedB64: string, keyB64: string, aad: Uint8Array): Promise<Uint8Array>;
}

export interface FilePort {
  read(name: string): Promise<string | null>;
  write(name: string, contents: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface EncryptedStore {
  get(slot: string): Promise<string | null>;
  set(slot: string, value: string): Promise<void>;
  remove(slot: string): Promise<void>;
  slots(prefix?: string): Promise<string[]>;
  /** Removes every slot AND the key (sign-out). */
  wipe(): Promise<void>;
}

const SLOT = /^[a-z0-9][a-z0-9._-]{0,120}$/;

function checkSlot(slot: string): void {
  if (!SLOT.test(slot)) throw new Error('invalid storage slot');
}

export function createEncryptedStore(deps: {
  readonly kv: SecureKeyValue;
  readonly cipher: CipherPort;
  readonly files: FilePort;
}): EncryptedStore {
  const { kv, cipher, files } = deps;
  let keyPromise: Promise<string> | null = null;

  function key(): Promise<string> {
    keyPromise ??= (async () => {
      const existing = await kv.getItem(SECURE_KEYS.storageKey);
      if (existing) return existing;
      const fresh = await cipher.generateKey();
      await kv.setItem(SECURE_KEYS.storageKey, fresh);
      return fresh;
    })().catch((e: unknown) => {
      keyPromise = null;
      throw e;
    });
    return keyPromise;
  }

  return {
    async get(slot) {
      checkSlot(slot);
      const sealed = await files.read(slot);
      if (sealed === null) return null;
      try {
        return utf8Decode(await cipher.decrypt(sealed, await key(), utf8Encode(slot)));
      } catch {
        // Unreadable (key rotated by a wipe, tampering, partial write): drop it.
        await files.remove(slot);
        return null;
      }
    },
    async set(slot, value) {
      checkSlot(slot);
      await files.write(
        slot,
        await cipher.encrypt(utf8Encode(value), await key(), utf8Encode(slot)),
      );
    },
    async remove(slot) {
      checkSlot(slot);
      await files.remove(slot);
    },
    async slots(prefix = '') {
      return (await files.list()).filter((n) => SLOT.test(n) && n.startsWith(prefix));
    },
    async wipe() {
      for (const name of await files.list()) await files.remove(name);
      await kv.deleteItem(SECURE_KEYS.storageKey);
      keyPromise = null;
    },
  };
}

// Encoding helpers re-exported for platform adapters.
export const encoding = { base64Decode, base64Encode };
