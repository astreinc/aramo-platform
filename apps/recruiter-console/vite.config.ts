import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

export default defineConfig({
  root,
  plugins: [react()],
  // PL-93 trio leg 3 (Q3 ruling, Recruiter R0): mirrors tenant-console
  // — the same alias covers vite build AND vitest runtime since this
  // config hosts both.
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
    },
  },
  server: {
    port: 4201,
    host: '127.0.0.1',
  },
  preview: {
    port: 4301,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../../dist/apps/recruiter-console',
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
