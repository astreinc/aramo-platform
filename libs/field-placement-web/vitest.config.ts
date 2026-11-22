import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = resolve(fileURLToPath(import.meta.url), '..');

// FIELD-PARITY-1 P1-5 — libs/field-placement-web unit config: jsdom + Testing Library, the
// field catalog resolved from source.
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/sign-fields': resolve(root, '../sign-fields/src/index.ts'),
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
