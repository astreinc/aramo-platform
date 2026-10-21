import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = resolve(fileURLToPath(import.meta.url), '..');

// DOC-TEMPLATE-LIB-1 T-4 — libs/document-templates-web unit config. Mirrors
// libs/org-admin-web (the specs moved from apps/ats-web): jsdom + the same test-setup,
// fe-foundation resolved from source.
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
