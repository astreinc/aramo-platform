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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
