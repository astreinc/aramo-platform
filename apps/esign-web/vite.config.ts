import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// PX-V1 §8 (D-4) — apps/esign-web: the Aramo Sign SENDER console on the product
// host esign.aramo.ai (Lead Host & Workspace Ruling v1.0): BUSINESS tenants work
// at /sign/, PERSONAL tenants at /personal/. It authenticates as the auth-service
// `esign` consumer and talks ONLY to the authenticated sender surface
// (/v1/esign/sender/* on esign-service) — never the ATS API, never the signer
// capability surface.
//   - port 4206 (ats-web 4201, platform-web 4202, portal-web 4203, sign-web 4204,
//     home-web 4205); preview 4306
//   - dev proxies mirror the nginx esign block: /auth → auth-service,
//     /v1/esign/sender → esign-service
export default defineConfig({
  root,
  cacheDir: resolve(root, '../../node_modules/.vite/esign-web'),
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
      '/v1/esign/sender': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/esign/billing': { target: 'http://localhost:3003', changeOrigin: false, secure: false },
      '/v1/signup/sign': { target: 'http://localhost:3002', changeOrigin: false, secure: false },
    },
  },
  preview: { port: 4306, host: '127.0.0.1' },
  build: { outDir: '../../dist/apps/esign-web', emptyOutDir: true, sourcemap: true },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
