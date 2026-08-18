// Aramo T2-E1-HF1-B — repository-native Jiti runner (Stage-C policy bootstrap).
//
// Runs a TypeScript entrypoint through Jiti with module aliases derived
// AUTOMATICALLY from the canonical `tsconfig.base.json` `compilerOptions.paths`.
// This is the ONE canonical alias source. There is deliberately NO:
//   • hand-maintained JITI_ALIAS catalog / alias table,
//   • fake `node_modules/@aramo/*` package,
//   • root `tsconfig.json` added solely for Jiti discovery,
//   • deep import from `libs/auth`,
//   • duplication of any exported constant (`@aramo/auth` remains the owner /
//     exporter of `PLATFORM_TENANT_SENTINEL_ID`),
//   • assumption that compiled API output rewrites the TypeScript aliases.
//
// Rationale: installed Jiti (2.6.1) has no `JITI_TSCONFIG_PATHS` env var, so
// `node --import jiti/register` cannot see the `@aramo/*` tsconfig path aliases
// and the policy seed fails `Cannot find module '@aramo/auth'`. This runner
// reads those same aliases from `tsconfig.base.json`, converts them to absolute
// targets, and hands them to Jiti's supported programmatic `alias` option, so
// every `@aramo/*` specifier (including transitive imports) resolves to its
// tsconfig-declared source file.
//
// Usage: node deploy/jiti-tsconfig-runner.mjs <entry.ts> [args…]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { createJiti } from 'jiti';

const HERE = dirname(fileURLToPath(import.meta.url));
// deploy/ -> repository root. tsconfig.base.json is the canonical alias source.
const REPO_ROOT = resolve(HERE, '..');
const TSCONFIG = resolve(REPO_ROOT, 'tsconfig.base.json');

// Read compilerOptions.paths from tsconfig.base.json and translate each mapping
// to an ABSOLUTE alias target. baseUrl (default '.') anchors the relative
// targets, mirroring TypeScript's own path resolution. This repo declares only
// exact `@aramo/<name>` specifiers (no `…/*` wildcards); a wildcard mapping, if
// ever added, is skipped here rather than silently mis-resolved.
function loadAliasesFromTsconfig() {
  const cfg = JSON.parse(readFileSync(TSCONFIG, 'utf8'));
  const co = cfg.compilerOptions ?? {};
  const base = resolve(REPO_ROOT, co.baseUrl ?? '.');
  const paths = co.paths ?? {};
  const alias = {};
  for (const [specifier, targets] of Object.entries(paths)) {
    if (specifier.includes('*')) continue;
    if (!Array.isArray(targets) || targets.length === 0) continue;
    alias[specifier] = resolve(base, targets[0]);
  }
  return alias;
}

const entryArg = process.argv[2];
if (entryArg === undefined || entryArg.length === 0) {
  console.error('jiti-tsconfig-runner: missing <entry.ts> argument');
  process.exit(1);
}
const entry = isAbsolute(entryArg) ? entryArg : resolve(process.cwd(), entryArg);

const alias = loadAliasesFromTsconfig();
const jiti = createJiti(import.meta.url, { alias });

try {
  await jiti.import(entry);
} catch (err) {
  console.error('jiti-tsconfig-runner: entry failed:', err);
  process.exit(1);
}
