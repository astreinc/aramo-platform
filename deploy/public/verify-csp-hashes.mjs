// deploy/public/verify-csp-hashes.mjs (PUB-5 PR-5b, R-PUB5-7 + D-PUB5-CSP-STYLE-1)
// — CSP hash drift gate. Zero dependencies (node crypto/fs/path only).
//
// The hardened CSP allow-lists inline content by sha256 hash instead of
// 'unsafe-inline', for TWO directives:
//   • script-src — Astro's client:visible hydration ships as INLINE <script>
//     bootstraps (the IntersectionObserver + the <astro-island> runtime).
//   • style-src  — one inline <style> survives on island pages: Astro's fixed
//     `astro-island{display:contents}` reset. (All authored/scoped styles are
//     externalised via astro.config `build.inlineStylesheets:'never'`, so no
//     other inline style exists — see D-PUB5-CSP-STYLE-1.)
//
// Both hash sets are Astro-version-coupled: an upgrade can silently change the
// inline bootstrap or reset and break the page under the strict CSP. This gate
// asserts, per directive, that the set of inline-element hashes in the built
// HTML equals the set of hashes in that nginx CSP directive — EXACTLY — and
// exits non-zero (with named-page diagnostics) on any drift.
//
// It runs inside the image build (deploy/public/Dockerfile), where dist/ and
// nginx.conf are both present — so the image build IS the gate.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'apps/public-web/dist';
const NGINX = process.argv[3] ?? 'deploy/public/nginx.conf';

const cspHash = (body) =>
  `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

// The two inline surfaces the CSP hash-gates. `re` captures the inline element's
// body (a <script>/<style> WITHOUT a src=), keyed to its CSP directive.
const SURFACES = [
  {
    directive: 'script-src',
    label: 'inline-script',
    re: /<script(?![^>]*\bsrc=)[^>]*>([\s\S]+?)<\/script>/g,
  },
  {
    directive: 'style-src',
    label: 'inline-style',
    re: /<style(?![^>]*\bsrc=)[^>]*>([\s\S]+?)<\/style>/g,
  },
];

// --- Allowed set per directive: the sha256 tokens in that CSP directive ---
const nginx = readFileSync(NGINX, 'utf8');
const allowedFor = (directive) => {
  const set = new Set();
  for (const line of nginx.matchAll(/Content-Security-Policy[^\n]*/g)) {
    // capture the directive's value up to the next ';' or the closing '"'
    const seg = line[0].match(new RegExp(`${directive}\\s+([^;"]*)`));
    if (seg) {
      for (const h of seg[1].matchAll(/'sha256-[A-Za-z0-9+/=]+'/g)) set.add(h[0]);
    }
  }
  return set;
};

// --- Built HTML pages ---
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
};
const pages = walk(DIST);

let ok = true;
const summaries = [];

for (const surface of SURFACES) {
  const allowed = allowedFor(surface.directive);
  const found = new Map(); // hash -> [pages]
  for (const file of pages) {
    const html = readFileSync(file, 'utf8');
    for (const m of html.matchAll(surface.re)) {
      const h = cspHash(m[1]);
      if (!found.has(h)) found.set(h, []);
      found.get(h).push(file.replace(`${DIST}/`, ''));
    }
  }

  const foundSet = new Set(found.keys());
  const notAllowed = [...foundSet].filter((h) => !allowed.has(h));
  const stale = [...allowed].filter((h) => !foundSet.has(h));

  if (notAllowed.length > 0) {
    ok = false;
    console.error(
      `CSP DRIFT (${surface.directive}) — ${surface.label}s in built HTML NOT in the nginx allow-list:`,
    );
    for (const h of notAllowed) {
      console.error(`  ${h}  (pages: ${found.get(h).join(', ')})`);
    }
  }
  if (stale.length > 0) {
    ok = false;
    console.error(
      `CSP DRIFT (${surface.directive}) — hashes in the nginx allow-list NOT present in any built HTML (stale):`,
    );
    for (const h of stale) console.error(`  ${h}`);
  }

  summaries.push({ surface, found });
}

if (!ok) {
  console.error(
    '\nUpdate the CSP hash set(s) in deploy/public/nginx.conf to match the built output (RETEST-WHEN Astro is upgraded).',
  );
  process.exit(1);
}

for (const { surface, found } of summaries) {
  console.log(
    `CSP hash gate OK (${surface.directive}) — ${found.size} ${surface.label} hash(es) match the nginx allow-list exactly.`,
  );
  for (const [h, ps] of found) console.log(`  ${h}  (${ps.length} page(s))`);
}
