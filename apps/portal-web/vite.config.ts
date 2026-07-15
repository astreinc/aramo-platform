import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// Portal P1 PR-3 — the talent-facing portal SPA. Same @nx/vite setup as
// platform-web; the proxy follows the ats-web shape instead (the portal reads
// GET /v1/portal/* from apps/api), plus /auth for the passwordless login flow.
// host: 'localhost' matches the auth callback host so the host-only session
// cookie is present. Ports pick the next free pair (serve 4203 / preview 4303).
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
    },
  },
  server: {
    port: 4203,
    host: 'localhost',
    proxy: {
      '/auth': { target: 'http://localhost:3001', changeOrigin: true, secure: false }, // auth-service
      '/v1': { target: 'http://localhost:3000', changeOrigin: true, secure: false }, // apps/api (portal reads)
    },
  },
  preview: { port: 4303, host: '127.0.0.1' },
  build: { outDir: '../../dist/apps/portal-web', emptyOutDir: true, sourcemap: true },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
