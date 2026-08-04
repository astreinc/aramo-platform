// D-REPOMAP-2 §4.2 (as amended by Amendment v1.4) — repo map verifier.
//
// Regenerates the map in memory via the SAME module the generator uses, then
// byte-compares against the committed files under doc/generated/. Exits non-zero
// on any difference, printing which file drifted and a bounded diff excerpt.
// This is the generate-and-compare drift idiom (error-codes / version:sync).
//
// It also enforces the self-derived acceptance checks that must never stale
// (Amendment v1.4 §2.2): the emitted alias set equals the tsconfig.base.json
// paths keys, and every alias target resolves to a file on disk.
//
// Run: node --import jiti/register ci/scripts/verify-repo-map.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { computeAliases, REPO_ROOT, renderAll, runSelfTest } from './generate-repo-map';

function boundedDiff(expected: string, actual: string, context = 3): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const max = Math.max(e.length, a.length);
  let first = -1;
  for (let i = 0; i < max; i++) {
    if (e[i] !== a[i]) {
      first = i;
      break;
    }
  }
  if (first === -1) return '(files differ in length only)';
  const start = Math.max(0, first - context);
  const end = Math.min(max, first + context + 1);
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`  committed:${i + 1}: ${e[i]}`);
      if (a[i] !== undefined) out.push(`  regenerated:${i + 1}: ${a[i]}`);
    } else if (e[i] !== undefined) {
      out.push(`  ${i + 1}: ${e[i]}`);
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const issues: string[] = [];

  // 0. Generator self-test — pure invariants incl. D-REPOMAP-3 coupling
  //    drift-immunity (identity is architectural, not textual: blank-line /
  //    intra-file move / duplicate-occurrence stability for pathRefs AND
  //    scripts[].references). Run here so it gates via repo-map:check, not only
  //    under SELF_TEST=1.
  try {
    runSelfTest();
  } catch (err) {
    issues.push(`generator self-test failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 1. Drift check: regenerate and byte-compare.
  const rendered = await renderAll();
  for (const { rel, content } of rendered) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      issues.push(`${rel}: missing — run \`npm run repo-map:generate\` and commit the result`);
      continue;
    }
    const committed = readFileSync(abs, 'utf8');
    if (committed !== content) {
      issues.push(`${rel}: drifted from committed content\n${boundedDiff(committed, content)}`);
    }
  }

  // 2. Alias self-derivation (Amendment v1.4 §2.2) — set-equality + resolvability.
  const { aliases } = computeAliases();
  const tsconfig = JSON.parse(readFileSync(join(REPO_ROOT, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const pathKeys = new Set(Object.keys(tsconfig.compilerOptions?.paths ?? {}));
  const aliasKeys = new Set(Object.keys(aliases));
  for (const k of aliasKeys)
    if (!pathKeys.has(k))
      issues.push(`alias set-equality: emitted alias '${k}' not in tsconfig paths`);
  for (const k of pathKeys)
    if (!aliasKeys.has(k))
      issues.push(`alias set-equality: tsconfig path '${k}' missing from emitted aliases`);
  for (const [k, target] of Object.entries(aliases)) {
    if (!existsSync(join(REPO_ROOT, target)))
      issues.push(`alias resolvability: '${k}' → '${target}' does not resolve`);
  }

  if (issues.length === 0) {
    console.log('repo-map:check ok');
    return;
  }
  console.error(`repo-map:check FAILED — ${issues.length} issue(s):`);
  for (const i of issues) console.error(`  ${i}`);
  process.exit(1);
}

void main();
