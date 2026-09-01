// Offer migration SQL generator entry — Offer Lifecycle slice #2 (D2).
//
// Emits the offer init migration deterministically from the typed lifecycle
// registry via the same generate-and-compare idiom as the placement generator.
// The committed migration.sql IS this output; verify-offer-sql.ts
// (offer:sql:check) rejects any hand edit by byte-comparison.
//
// Run: node --import jiti/register ci/scripts/generate-offer-sql.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  generateOfferMigrationSql,
  generateOfferCompensationSnapshotSql,
  generateOfferRevisionSql,
} from '../../libs/placement/src/lib/generator/offer-sql-generator.js';

const HERE = __dirname;
export const REPO_ROOT = resolve(HERE, '..', '..');

export const OFFER_MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260824120000_init_offer_model/migration.sql';

// L4-A / P1 — the FORWARD compensation-snapshot migration. The init above is
// FROZEN (byte-identical); this one ADDs the comp columns. Both are build artifacts.
export const OFFER_COMPENSATION_MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260901130000_offer_compensation_snapshot/migration.sql';

// L4-B / P2 — the FORWARD OfferRevision history migration (after the comp snapshot).
export const OFFER_REVISION_MIGRATION_REL_PATH =
  'libs/placement/prisma/migrations/20260901140000_offer_revision_history/migration.sql';

export function renderOfferMigration(): { rel: string; content: string } {
  return { rel: OFFER_MIGRATION_REL_PATH, content: generateOfferMigrationSql() };
}

export function renderOfferCompensationMigration(): { rel: string; content: string } {
  return {
    rel: OFFER_COMPENSATION_MIGRATION_REL_PATH,
    content: generateOfferCompensationSnapshotSql(),
  };
}

export function renderOfferRevisionMigration(): { rel: string; content: string } {
  return { rel: OFFER_REVISION_MIGRATION_REL_PATH, content: generateOfferRevisionSql() };
}

function writeArtifact(rel: string, content: string): void {
  const abs = join(REPO_ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  console.log(`wrote ${rel}`);
}

function main(): void {
  const init = renderOfferMigration();
  const comp = renderOfferCompensationMigration();
  const rev = renderOfferRevisionMigration();
  writeArtifact(init.rel, init.content);
  writeArtifact(comp.rel, comp.content);
  writeArtifact(rev.rel, rev.content);
  console.log('offer:sql:generate ok');
}

// Only run when executed directly — NOT when imported by the verifier.
if (process.argv[1] !== undefined && /generate-offer-sql\.ts$/.test(process.argv[1])) {
  main();
}
