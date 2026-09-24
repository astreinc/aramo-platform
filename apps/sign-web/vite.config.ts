import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// DOC-4 (R-4-8) — the external-signer SPA (sign.aramo.ai). Talks ONLY to the
// E-Sign public signer transport (/v1/esign/signing/*). No ATS/Documents/Portal
// imports (scope:sign wall). Ports pick the next free pair (serve 4204 / preview 4304).
export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 4204,
    host: 'localhost',
    proxy: {
      '/v1/esign/signing': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
    },
  },
  preview: { port: 4304, host: '127.0.0.1' },
  build: { outDir: '../../dist/apps/sign-web', emptyOutDir: true, sourcemap: true },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
