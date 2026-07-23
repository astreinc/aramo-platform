// @ts-check
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

const require = createRequire(import.meta.url);
// Resolve Astro's OWN nested `cookie` (2.x, ESM, named exports) from Astro's
// package context — not a hardcoded node_modules path.
const astroDir = dirname(require.resolve('astro/package.json'));
const astroCookie = require.resolve('cookie', { paths: [astroDir] });

// PUB-1a — Astro scaffold config (PUB-1 §2.1; In-Session Ruling R-S1-1:
// astro@7.1.3 + @astrojs/react@6.0.1 + @astrojs/sitemap@3.7.3, exact-pinned,
// superseding §2.1 "v5.x"). Static-first public marketing site: zero client JS
// on scaffold pages. `site` drives @astrojs/sitemap's absolute URLs. The design
// system (PUB-2), page copy (PUB-3), and legal text (PUB-4) are out of PUB-1.
export default defineConfig({
  site: 'https://aramo.ai',
  output: 'static',
  integrations: [react(), sitemap()],
  vite: {
    resolve: {
      // ─── Cookie-resolution workaround (RATIFIED: In-Session Ruling R-S2-2) ───
      // Astro 7 externalizes its own `cookie@2.x` (ESM, named exports
      // `parseCookie`/`stringifySetCookie`) in the prerender bundle. In THIS
      // monorepo, express/cookie-parser hoist `cookie@0.7.2` (CommonJS,
      // `parse`/`serialize` only) to the workspace root, which shadows Astro's
      // nested copy at prerender-resolution time → "Named export 'parseCookie'
      // not found" and the build fails. Aliasing `cookie` to Astro's own nested
      // 2.x (resolved above from Astro's package context) pins the resolution to
      // the version Astro's code expects, leaving express / cookie-parser on
      // 0.7.2 untouched. Scaffold-local (astro.config only); NO root dependency
      // change, NO Astro downgrade. A global `overrides` to cookie@2.x would
      // break express (the 2.x API is renamed); `vite.ssr.noExternal` does not
      // help (the prerender entry is Node-resolved, not Vite-bundled).
      //
      // REMOVE WHEN: the monorepo's transitive `cookie` reaches 2.x at the root
      // (i.e. express/cookie-parser upgrade so the hoisted copy already carries
      // the named exports), OR Astro stops externalizing its bundled cookie.
      // Verify removal by deleting this alias and confirming `nx build
      // public-web` still exits 0. See PUB-1a Gate-5 report (R-S1-1 / R-S2-2).
      //
      // ─── SIBLING NOTE — vitest toolchain override (R-FIX-1) ───
      // Adding astro also bumped the vitest-SHARED chain via npm dedup (rolldown
      // rc.17 → 1.1.5, vite 8.0.10 → 8.1.5); rolldown 1.1.5 rejects TS
      // constructor parameter decorators (`@Inject()`), breaking DI/integration
      // specs across libs/mailer, libs/identity, libs/task, apps/api. That is
      // pinned OUT-OF-BAND in the root package.json `overrides` block:
      //   "vitest": { "vite": "8.0.10" }   (JSON carries no comments, so the
      // REMOVE-WHEN lives here). REMOVE WHEN: upstream rolldown parses TS param
      // decorators again; RETEST on every vitest/vite upgrade. Astro keeps its
      // own nested vite@8.1.5/rolldown@1.1.5 — this override touches only the
      // vitest subtree, so the alias above and the astro build are unaffected.
      alias: { cookie: astroCookie },
    },
  },
});
