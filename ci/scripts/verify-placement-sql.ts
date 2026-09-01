// Placement migration SQL verifier — Track 3 / E1-a §5c.
//
// Regenerates the placement migration in memory via the SAME generator the
// author ran, then byte-compares against the committed migration.sql. Exits
// non-zero on any difference with a bounded diff. This is the generate-and-
// compare drift idiom (repo-map / error-codes / version:sync). It is what
// makes the SQL a build artifact rather than an editable source (§5c): a hand
// edit to the committed SQL cannot survive CI.
//
// Run: node --import jiti/register ci/scripts/verify-placement-sql.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  renderPlacementCollapseMigration,
  renderPlacementMigration,
} from './generate-placement-sql.js';

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

function verifyArtifact(rel: string, content: string): void {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(
      `placement:sql:check FAILED — ${rel} missing. Run \`npm run placement:sql:generate\` and commit the result.`,
    );
    process.exit(1);
  }
  const committed = readFileSync(abs, 'utf8');
  if (committed !== content) {
    console.error(`placement:sql:check FAILED — ${rel} drifted from the generator output:`);
    console.error(boundedDiff(committed, content));
    console.error('The migration SQL is a generated build artifact; edit the lifecycle registry, not the SQL.');
    process.exit(1);
  }
}

function main(): void {
  // The FROZEN init (byte-pinned to the historical snapshot) AND the L4-0
  // forward collapse migration are both generated build artifacts.
  const init = renderPlacementMigration();
  const collapse = renderPlacementCollapseMigration();
  verifyArtifact(init.rel, init.content);
  verifyArtifact(collapse.rel, collapse.content);
  console.log('placement:sql:check ok (frozen init + forward collapse migration)');
}

main();
