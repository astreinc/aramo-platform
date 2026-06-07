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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
