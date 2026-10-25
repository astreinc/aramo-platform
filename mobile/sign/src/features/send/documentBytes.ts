// Document bytes waiting for upload, kept ENCRYPTED in the app's store (directive §9:
// offline preparation; the same AES-GCM store as the drafts), keyed by the draft
// document key. Removed once uploaded, on discard, and by the sign-out wipe.
import type { EncryptedStore } from '../../state/encryptedStore';

const PREFIX = 'sendfile.';

function slotFor(docKey: string): string {
  if (!/^[a-z0-9-]{8,64}$/i.test(docKey)) throw new Error('invalid document key');
  return `${PREFIX}${docKey.toLowerCase()}`;
}

export interface DocumentBytesStore {
  put(docKey: string, base64: string): Promise<void>;
  get(docKey: string): Promise<string | null>;
  remove(docKey: string): Promise<void>;
}

export function createDocumentBytesStore(store: EncryptedStore): DocumentBytesStore {
  return {
    put: (docKey, base64) => store.set(slotFor(docKey), base64),
    get: (docKey) => store.get(slotFor(docKey)),
    remove: (docKey) => store.remove(slotFor(docKey)),
  };
}
