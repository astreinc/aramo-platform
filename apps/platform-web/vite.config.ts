import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// apps/platform-web — the platform console (Platform-Console Inc-2 PR-2). Its own
// app at its own origin (:4202). Mirrors ats-web's vite config; the differences
// are deliberate and per the directive:
//   - port 4202 (ats-web is 4201), host 'localhost' (Inc-1 lesson: the printed
//     dev URL must match AUTH_PUBLIC_BASE_URL / the derived callback host so the
//     host-only PKCE cookie is present at the callback).
//   - proxy /auth → auth-service (3001) and /platform → platform-admin
//     (127.0.0.1:3002, IPv4-pinned — Inc-1 lesson). NO /v1 proxy: platform-web
//     talks ONLY to auth + platform-admin (A4), never apps/api.
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
    },
  },
  server: {
    port: 4202,
    host: 'localhost',
    proxy: {
      '/auth': {
        target: 'http://localhost:3001', // auth-service
        changeOrigin: true,
        secure: false,
      },
      '/platform': {
        target: 'http://127.0.0.1:3002', // apps/platform-admin (IPv4 pin)
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4302,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../../dist/apps/platform-web',
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
