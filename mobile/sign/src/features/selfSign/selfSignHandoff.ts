// M-A14 — in-memory handoffs around "Sign Document" (never persisted, never logged):
//   - the document picked on the Add Documents sheet over Home, taken by the Sign
//     Document screen when it opens (the bytes never travel in route params);
//   - "Done" on You've Signed asks the signed-in shell to offer "Want to sign another
//     document?" over Agreements (§1 item 8).
import type { SelfDoc } from './selfSignModel';

export interface PendingSelfDoc {
  readonly doc: SelfDoc;
  /** "Camera scan" · "Photos" · "Files". */
  readonly source: string;
}

let pending: PendingSelfDoc[] = [];

export function putPendingSelfDoc(p: PendingSelfDoc): void {
  pending = [...pending, p];
}

/** Every waiting document, oldest first; the queue is emptied. */
export function takePendingSelfDocs(): PendingSelfDoc[] {
  const out = pending;
  pending = [];
  return out;
}

type Listener = (open: boolean) => void;
const listeners = new Set<Listener>();
let signNextOpen = false;

export function requestSignNext(): void {
  signNextOpen = true;
  listeners.forEach((l) => l(true));
}

export function dismissSignNext(): void {
  signNextOpen = false;
  listeners.forEach((l) => l(false));
}

export function signNextRequested(): boolean {
  return signNextOpen;
}

export function subscribeSignNext(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
