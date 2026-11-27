// APP-DELETED-1 Amendment A1 (LOCKED 2026-11-27) — the receipt of a deletion that signs the
// user out (Personal, or a COMPLETED request). The server ends every session at once, so the
// app keeps the receipt here, signs out itself, and the signed-out screen shows it first
// (request ID, status, what is kept) instead of "Your session ended". Memory only: never
// stored, so it is gone after an app restart (the request ID stays checkable on the web page).
import { useSyncExternalStore } from 'react';

import type { PrivacyRequest } from './privacy';

let current: PrivacyRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setDeletionReceipt(request: PrivacyRequest): void {
  current = request;
  emit();
}

export function clearDeletionReceipt(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function deletionReceipt(): PrivacyRequest | null {
  return current;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDeletionReceipt(): PrivacyRequest | null {
  return useSyncExternalStore(subscribe, deletionReceipt, deletionReceipt);
}
