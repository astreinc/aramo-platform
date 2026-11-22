import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom ships no ResizeObserver (the editor measures its page column with one).
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
