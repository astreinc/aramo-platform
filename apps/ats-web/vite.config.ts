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
    // Increment-1 v1.1 ruling: bind `localhost` (not 127.0.0.1) so the printed
    // dev URL matches the host in AUTH_PUBLIC_BASE_URL / the derived callback —
    // the host-only PKCE cookie set at login is then present at the callback
    // (the pkce_state_missing host divergence stays closed).
    host: 'localhost',
    // Local-dev same-origin routing (Path B). The FE uses relative paths
    // with an empty base URL, so /auth and /v1 would otherwise hit the
    // Vite dev server (4201) and 404. Proxying them to the backends keeps
    // everything on the 4201 origin — no CORS, and HttpOnly cookies bind
    // to the FE origin. Cognito's hosted-UI callback also lands here
    // (/auth/recruiter/callback → auth-service) so the post-login 302
    // returns the browser to the FE origin coherently.
    proxy: {
      '/auth': {
        target: 'http://localhost:3001', // auth-service
        changeOrigin: true,
        secure: false,
      },
      '/v1': {
        target: 'http://localhost:3000', // apps/api
        changeOrigin: true,
        secure: false,
      },
      // Increment-1 §3.2 (Lead-ruled run-config): the platform-admin backend.
      // 127.0.0.1 (not localhost) is deliberate — pins IPv4 so the proxy is
      // immune to the ::1/127.0.0.1 resolution ambiguity a stray dev server on
      // [::1]:3002 can introduce. The future platform-web FE (Increment-2)
      // reuses this seam.
      '/platform': {
        target: 'http://127.0.0.1:3002', // apps/platform-admin
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4301,
    host: '127.0.0.1',
  },
  build: {
    outDir: '../../dist/apps/ats-web',
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
