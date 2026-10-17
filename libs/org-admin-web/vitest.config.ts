import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = resolve(fileURLToPath(import.meta.url), '..');

// D-ORG-3 — libs/org-admin-web unit config. Mirrors apps/ats-web (the specs
// moved from there): jsdom + the same test-setup (ResizeObserver polyfill,
// timer hygiene), fe-foundation resolved from source.
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../fe-foundation/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
