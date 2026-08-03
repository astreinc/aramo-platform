// Placement migration SQL generator entry — Track 3 / E1-a §5c.
//
// Emits the placement init migration deterministically from the typed
// lifecycle registry via the same generate-and-compare idiom as
// repo-map:generate. The committed migration.sql IS this output; editing it
// by hand is prohibited and verify-placement-sql.ts (placement:sql:check)
// rejects any drift by byte-comparison.
//
// Run: node --import jiti/register ci/scripts/generate-placement-sql.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { generatePlacementMigrationSql } from '../../libs/placement/src/lib/generator/placement-sql-generator.js';

const HERE = __dirname;
export const REPO_ROOT = resolve(HERE, '..', '..');

// The committed artifact path. The timestamp is verified unique repo-wide at
// authoring time (§ migration-list sweep by timestamp, never path).
export const MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260803180000_init_placement_model/migration.sql';

export function renderPlacementMigration(): { rel: string; content: string } {
  return { rel: MIGRATION_REL_PATH, content: generatePlacementMigrationSql() };
}

function main(): void {
  const { rel, content } = renderPlacementMigration();
  const abs = join(REPO_ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  console.log(`wrote ${rel}`);
  console.log('placement:sql:generate ok');
}

// Only run when executed directly — NOT when imported by the verifier, which
// must regenerate in memory and compare, never write to disk.
if (process.argv[1] !== undefined && /generate-placement-sql\.ts$/.test(process.argv[1])) {
  main();
}
