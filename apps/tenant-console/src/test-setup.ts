// Vitest setup for tenant-console.
//
// Loaded via vite.config.ts test.setupFiles. Adds jest-dom matchers
// and resets fetch mocks between tests so per-test mock state does
// not leak.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
