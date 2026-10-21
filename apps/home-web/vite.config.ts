import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(import.meta.url), '..');

// D-ORG-2 (topology T1) — Aramo App Home: the product-neutral tenant entry at `/`
// on `<slug>.aramo.ai` (App Home + Organization Administration at /org/). The ATS
// app is served beside it at /ats/ (apps/ats-web, base '/ats/'); nginx routes
// `/ats/` to that bundle and everything else to this one.
//   - port 4205 (ats-web 4201, platform-web 4202, portal-web 4203, sign-web 4204)
//   - dev proxies mirror ats-web: /auth → auth-service, /v1 → api; /ats → the ATS dev
//     server (:4201) so :4205 behaves like the production tenant host
export default defineConfig({
  root,
  // Per-app dependency cache. Without it every SPA dev server resolves the SAME
  // node_modules/.vite and they overwrite each other's pre-bundled deps, so a page
  // requests a bundle hash another server already replaced (504 "Outdated Optimize
  // Dep") and renders blank. Dev-only; builds are unaffected.
  cacheDir: resolve(root, '../../node_modules/.vite/home-web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../../libs/fe-foundation/src/index.ts'),
      '@aramo/org-admin-web': resolve(root, '../../libs/org-admin-web/src/index.ts'),
      // DOC-TEMPLATE-LIB-1 T-4 — the shared document-template UI.
      '@aramo/document-templates-web': resolve(root, '../../libs/document-templates-web/src/index.ts'),
    },
  },
  server: {
    port: 4205,
    host: 'localhost',
    proxy: {
      '/auth': { target: 'http://localhost:3001', changeOrigin: false, secure: false },
      '/v1': { target: 'http://localhost:3000', changeOrigin: false, secure: false },
      // D-ORG-2 dev parity with nginx `location /ats/`: the tenant host serves the
      // ATS SPA under /ats/. Locally it is the ATS dev server (:4201, base /ats/),
      // so App Home → ATS works on ONE origin, cookies and all (HMR via ws).
      '/ats': { target: 'http://localhost:4201', changeOrigin: false, secure: false, ws: true },
    },
  },
  preview: { port: 4305, host: '127.0.0.1' },
  build: { outDir: '../../dist/apps/home-web', emptyOutDir: true, sourcemap: true },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    css: false,
  },
});
