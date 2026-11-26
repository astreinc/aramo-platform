// UAT AND-12 — drafts saved on the phone while offline are written to the server once the
// phone is back online (directive §9: "Local draft preparation persists in encrypted
// on-device storage and syncs when online"). In the background, only drafts the sender
// explicitly saved (Save draft → pendingSync) are synced; any other draft is written by the
// Send flow itself while it is open (UAT DOC-06). Nothing is ever sent. A draft open in the Send flow is
// left to that screen, so two writers never race on one envelope.
import type { DraftStore } from '../../state/draftStore';
import type { DocumentBytesStore } from './documentBytes';
import type { SendDraft } from './draftModel';
import type { SenderApi } from './senderApi';
import { syncDraft } from './syncDraft';

const openInSendFlow = new Map<string, number>();

/** The Send flow marks the draft it has open; returns the release (counted, idempotent). */
export function markDraftOpen(localId: string): () => void {
  openInSendFlow.set(localId, (openInSendFlow.get(localId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (openInSendFlow.get(localId) ?? 1) - 1;
    if (n <= 0) openInSendFlow.delete(localId);
    else openInSendFlow.set(localId, n);
  };
}

export function isDraftOpen(localId: string): boolean {
  return (openInSendFlow.get(localId) ?? 0) > 0;
}

export interface PendingDraftSyncDeps {
  readonly drafts: DraftStore;
  readonly api: SenderApi;
  readonly bytes: DocumentBytesStore;
  readonly isOnline: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

let running: Promise<number> | null = null;

/** Resolves once no background sync is running (the Send flow opens a draft after it). */
export async function pendingDraftSyncIdle(): Promise<void> {
  if (running) await running.catch(() => 0);
}

/**
 * Sync every saved-offline draft. Returns how many reached the server. One run at a time;
 * a draft that fails (offline again, a conflict, a refusal) stays marked and is retried on
 * the next reconnect, and the sender sees the reason when they open it.
 */
export function syncPendingDrafts(deps: PendingDraftSyncDeps): Promise<number> {
  if (running) return running;
  running = run(deps).finally(() => {
    running = null;
  });
  return running;
}

async function run(deps: PendingDraftSyncDeps): Promise<number> {
  let synced = 0;
  for (const local of await deps.drafts.list()) {
    if (local.pendingSync !== true || isDraftOpen(local.localId)) continue;
    if (!deps.isOnline()) break;
    try {
      const { draft } = await syncDraft(
        {
          api: deps.api,
          bytes: deps.bytes,
          // Keep each stage on disk, so an interrupted sync continues the same envelope.
          onProgress: (x) => deps.drafts.save({ ...x, pendingSync: true }),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        },
        local as SendDraft,
      );
      // The sender may have opened it meanwhile; the open flow then owns it.
      if (isDraftOpen(local.localId)) continue;
      await deps.drafts.save({ ...draft, pendingSync: false });
      synced += 1;
    } catch {
      // Left marked; retried on the next reconnect.
    }
  }
  return synced;
}
