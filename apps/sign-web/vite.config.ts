import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// Sign Unified Product S-2 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.1) — the ONE Aramo Sign application on
// sign.aramo.ai: the signed-in workspace (sending, envelopes, members, plan) and
// guest signing (/s/:token, /d/:token) in one SPA, split into separate bundles by
// zone (src/zones.ts). scope:sign wall: no ATS / Documents / Portal / platform imports.
//   - dev port 4206 (the registered local Cognito callback is
//     http://localhost:4206/auth/sign/callback); preview 4306
//   - dev proxies mirror the nginx sign block: /auth → auth-service,
//     /v1/sign/{sender,billing,signing,inbox} → sign-service, /v1/signup/sign → platform-admin
export default defineConfig({
  root,
  // Per-app dependency cache. Without it every SPA dev server resolves the SAME
  // node_modules/.vite and they overwrite each other's pre-bundled deps, so a page
  // requests a bundle hash another server already replaced (504 "Outdated Optimize
  // Dep") and renders blank. Dev-only; builds are unaffected.
  cacheDir: resolve(root, '../../node_modules/.vite/sign-web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
    },
  },
  server: {
    port: 4206,
    host: 'localhost',
    proxy: {
      '/auth': { target: 'http://localhost:3001', changeOrigin: false, secure: false },
      '/v1/sign/sender': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/sign/billing': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/sign/signing': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/sign/inbox': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/sign/report': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/signup/sign': { target: 'http://localhost:3002', changeOrigin: false, secure: false },
    },
  },
  preview: { port: 4306, host: '127.0.0.1' },
  build: { outDir: '../../dist/apps/sign-web', emptyOutDir: true, sourcemap: true },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
