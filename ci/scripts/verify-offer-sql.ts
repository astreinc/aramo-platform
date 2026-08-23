// Offer migration SQL verifier — Offer Lifecycle slice #2 (D2).
//
// Regenerates the offer migration in memory via the SAME generator the author
// ran, then byte-compares against the committed migration.sql. Exits non-zero
// on any difference — the generate-and-compare drift idiom that makes the SQL a
// build artifact rather than editable source: a hand edit cannot survive CI.
//
// Run: node --import jiti/register ci/scripts/verify-offer-sql.ts

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, renderOfferMigration } from './generate-offer-sql.js';

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

function main(): void {
  const { rel, content } = renderOfferMigration();
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`offer:sql:check FAIL — committed migration missing: ${rel}`);
    console.error('run: npm run offer:sql:generate');
    process.exit(1);
  }
  const committed = readFileSync(abs, 'utf8');
  if (committed !== content) {
    console.error(`offer:sql:check FAIL — committed ${rel} drifted from the registry-generated SQL.`);
    console.error('the committed migration is a BUILD ARTIFACT; never hand-edit it. run: npm run offer:sql:generate');
    console.error(boundedDiff(committed, content));
    process.exit(1);
  }
  console.log(`offer:sql:check ok — ${rel} is byte-identical to the registry-generated SQL.`);
}

main();
