import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

export default defineConfig({
  root,
  plugins: [react()],
  // PL-93 trio leg 3 (Q3 ruling, Recruiter R0): vite resolves the
  // @aramo/fe-foundation alias for BOTH build and vitest (the same
  // config hosts both `build:` and `test:`). The tsconfig path
  // mapping covers tsc; this alias covers vite + vitest runtime.
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
    },
  },
  server: {
    port: 4200,
    host: '127.0.0.1',
  },
  preview: {
    port: 4300,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../../dist/apps/tenant-console',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
