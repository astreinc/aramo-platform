import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = resolve(fileURLToPath(import.meta.url), '..');

// D-ORG-3 — libs/org-admin-web unit config. Mirrors apps/ats-web (the specs
// moved from there): jsdom + the same test-setup (ResizeObserver polyfill,
// timer hygiene), fe-foundation resolved from source.
export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@aramo/fe-foundation': resolve(root, '../fe-foundation/src/index.ts'),
      '@aramo/document-templates-web': resolve(root, '../document-templates-web/src/index.ts'),
      // FIELD-PARITY-1 P1-1 — the one field catalog (scope:shared), imported by
      // @aramo/sign-client and @aramo/document-templates-web.
      '@aramo/sign-fields': resolve(root, '../sign-fields/src/index.ts'),
      // TEMPLATE-CONTENT-2 C-0 — the one set of content rules (scope:shared), imported by
      // @aramo/document-templates-web.
      '@aramo/template-content': resolve(root, '../template-content/src/index.ts'),
      // FIELD-PARITY-1 P1-5 — the one web placement editor (scope:shared), imported by
      // @aramo/document-templates-web (the console form Studio) and sign-web Prepare.
      '@aramo/field-placement-web': resolve(root, '../field-placement-web/src/index.ts'),
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
