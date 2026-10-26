// Offline draft recovery for the Send flow (directive §9; acceptance §12.7 "save a
// draft, kill the app, recover the draft"). Drafts are prepared locally, encrypted at
// rest, and synced to the server when online; the server copy (revision + ETag) stays
// the authority once it exists (M-A3 §6). The payload shape is owned by the Send flow.
import type { EncryptedStore } from './encryptedStore';

export type SendStep = 'documents' | 'recipients' | 'fields' | 'review';

export interface LocalDraft<TPayload = unknown> {
  /** Client id for the draft (stable before the server envelope exists). */
  readonly localId: string;
  /** Server envelope id once created; null while only local. */
  readonly envelopeId: string | null;
  /** Server revision the local edits are based on (for If-Match). */
  readonly baseRevision: number | null;
  readonly step: SendStep;
  readonly updatedAt: string;
  readonly payload: TPayload;
}

const PREFIX = 'draft.';

export interface DraftStore {
  save<T>(draft: LocalDraft<T>): Promise<void>;
  load<T>(localId: string): Promise<LocalDraft<T> | null>;
  list(): Promise<LocalDraft[]>;
  remove(localId: string): Promise<void>;
}

function slotFor(localId: string): string {
  if (!/^[a-z0-9-]{8,64}$/i.test(localId)) throw new Error('invalid draft id');
  return `${PREFIX}${localId.toLowerCase()}`;
}

export function createDraftStore(store: EncryptedStore): DraftStore {
  return {
    async save(draft) {
      await store.set(slotFor(draft.localId), JSON.stringify(draft));
    },
    async load<T>(localId: string) {
      const raw = await store.get(slotFor(localId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as LocalDraft<T>;
      } catch {
        return null;
      }
    },
    async list() {
      const out: LocalDraft[] = [];
      for (const slot of await store.slots(PREFIX)) {
        const raw = await store.get(slot);
        if (!raw) continue;
        try {
          out.push(JSON.parse(raw) as LocalDraft);
        } catch {
          // skip unreadable entries
        }
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async remove(localId) {
      await store.remove(slotFor(localId));
    },
  };
}
