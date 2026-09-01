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

import {
  generatePlacementMigrationSql,
  generatePlacementOfferStateCollapseSql,
} from '../../libs/placement/src/lib/generator/placement-sql-generator.js';

const HERE = __dirname;
export const REPO_ROOT = resolve(HERE, '..', '..');

// The committed artifact paths. Each timestamp is verified unique repo-wide at
// authoring time (§ migration-list sweep by timestamp, never path).
export const MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260803180000_init_placement_model/migration.sql';

// L4-0: the FORWARD collapse migration — a SEPARATE generator-owned artifact.
// The init above is FROZEN (regenerates byte-identical from the historical
// snapshot); this one narrows the live enum to the collapsed 6-value set
// fail-loud (col::text::new-type). Both are build artifacts under sql:check.
export const COLLAPSE_MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260901120000_l4_placement_offer_state_collapse/migration.sql';

export function renderPlacementMigration(): { rel: string; content: string } {
  return { rel: MIGRATION_REL_PATH, content: generatePlacementMigrationSql() };
}

export function renderPlacementCollapseMigration(): { rel: string; content: string } {
  return { rel: COLLAPSE_MIGRATION_REL_PATH, content: generatePlacementOfferStateCollapseSql() };
}

function writeArtifact(rel: string, content: string): void {
  const abs = join(REPO_ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  console.log(`wrote ${rel}`);
}

function main(): void {
  const init = renderPlacementMigration();
  const collapse = renderPlacementCollapseMigration();
  writeArtifact(init.rel, init.content);
  writeArtifact(collapse.rel, collapse.content);
  console.log('placement:sql:generate ok');
}

// Only run when executed directly — NOT when imported by the verifier, which
// must regenerate in memory and compare, never write to disk.
if (process.argv[1] !== undefined && /generate-placement-sql\.ts$/.test(process.argv[1])) {
  main();
}
