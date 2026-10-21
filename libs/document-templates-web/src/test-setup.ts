import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// R4 — jsdom doesn't ship ResizeObserver, which Radix's react-use-size
// reaches for as soon as a Popover/Combobox content mounts (e.g. the
// company picker in the requisition form). A minimal noop polyfill is
// enough to satisfy the dependency for unit tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {
      // noop polyfill — Radix's react-use-size only needs the API present.
    }
    unobserve(): void {
      // noop polyfill.
    }
    disconnect(): void {
      // noop polyfill.
    }
  } as unknown as typeof ResizeObserver;
}

// Timers must not outlive their test. Radix Toast (@radix-ui/react-toast 1.2.x,
// via the fe-foundation ToastProvider's fixed 3000 ms duration) arms a close timer
// that unmount does NOT clear; when it fires after the file's jsdom environment is
// torn down, its handler reads `document` and Vitest fails the run with an
// unhandled "ReferenceError: document is not defined" (the merge-group CI flake
// attributed to RtrDraftEditor.spec). Track the window timers a test arms, and
// clear the ones still pending once the test's tree is unmounted. Real timers
// only — no fake clock — so async waiting inside a test is untouched.
const pendingWindowTimers = new Set<number>();
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
  if (typeof handler !== 'function') return nativeSetTimeout(handler, timeout, ...args);
  const id = nativeSetTimeout(
    (...cbArgs: unknown[]) => {
      pendingWindowTimers.delete(id);
      (handler as (...a: unknown[]) => void)(...cbArgs);
    },
    timeout,
    ...args,
  );
  pendingWindowTimers.add(id);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number): void => {
  if (id !== undefined) pendingWindowTimers.delete(id);
  nativeClearTimeout(id);
}) as typeof window.clearTimeout;

afterEach(() => {
  cleanup();
  for (const id of pendingWindowTimers) nativeClearTimeout(id);
  pendingWindowTimers.clear();
  vi.restoreAllMocks();
  // Per-tab session state (e.g. the Talent × Requisition 360 origin snapshot)
  // must not leak between tests.
  try {
    window.sessionStorage.clear();
  } catch {
    /* jsdom always provides sessionStorage */
  }
});
