// Removing a draft's on-device copy (the encrypted DraftStore entry and the bytes of
// any document not yet uploaded) when the draft is deleted. Directive §9: local
// drafts are a working copy; once the sender deletes the draft, nothing of it stays.
import type { DraftStore } from '../../state/draftStore';
import type { DocumentBytesStore } from './documentBytes';
import type { SendDraftPayload } from './draftModel';

export async function forgetLocalDrafts(
  drafts: DraftStore,
  bytes: DocumentBytesStore,
  match: { readonly envelopeId?: string; readonly localDraftId?: string },
): Promise<number> {
  let removed = 0;
  for (const d of await drafts.list()) {
    const hit =
      (match.envelopeId !== undefined && d.envelopeId === match.envelopeId) ||
      (match.localDraftId !== undefined && d.localId === match.localDraftId);
    if (!hit) continue;
    const payload = d.payload as Partial<SendDraftPayload> | null;
    for (const doc of payload?.documents ?? []) {
      // Only documents not yet uploaded have bytes here; a key with no bytes (or one
      // the byte store would refuse) has nothing to remove.
      try {
        await bytes.remove(doc.key);
      } catch {
        // nothing stored under this key
      }
    }
    await drafts.remove(d.localId);
    removed += 1;
  }
  return removed;
}
