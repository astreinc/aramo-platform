import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom doesn't ship ResizeObserver, which Radix (used by fe-foundation's
// Dialog/Combobox) reaches for as soon as an overlay mounts. A minimal noop
// polyfill satisfies the dependency for unit tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {
      // noop polyfill.
    }
    unobserve(): void {
      // noop polyfill.
    }
    disconnect(): void {
      // noop polyfill.
    }
  } as unknown as typeof ResizeObserver;
}

// Timers a test left pending (e.g. a Radix toast's auto-close) can fire after the file's jsdom
// environment is torn down and throw "document is not defined" as an unhandled error, which fails
// the whole run. Track real timeouts and clear any still pending once each test has cleaned up.
const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  const id = realSetTimeout(
    (...cbArgs: unknown[]) => {
      pendingTimeouts.delete(id);
      if (typeof handler === 'function') (handler as (...a: unknown[]) => void)(...cbArgs);
    },
    timeout,
    ...args,
  );
  pendingTimeouts.add(id);
  return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
  if (id !== undefined) pendingTimeouts.delete(id);
  realClearTimeout(id);
}) as typeof clearTimeout;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const id of pendingTimeouts) realClearTimeout(id);
  pendingTimeouts.clear();
});
