import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIVE_EPISODE_EXCLUSION_STATUSES } from '../lib/pipeline-state.js';

// ==== B-index-parity — registry <-> SQL drift guard ====
//
// The live-scoped partial unique (`Pipeline_live_episode_key`) carries the
// live-slot EXCLUSION set as a LITERAL PostgreSQL enum list, because a migration
// is immutable SQL and cannot import the TypeScript status registry.
//
// Accidental-Add Correction — the exclusion set now carries the THREE canonical
// terminals (`not_in_consideration` + `completed` + `voided`); a voided episode
// releases the live slot. The LAST migration that recreates `Pipeline_live_episode_key`
// is the VOID index-recreate; this guard parses IT and asserts its predicate equals
// LIVE_EPISODE_EXCLUSION_STATUSES. A partition change fails this proof until a new
// migration updates the DB invariant.
//
// Pure unit test (no Postgres): it parses the migration file and compares to the
// registry-derived exclusion set.
const CANONICALIZE_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
);

// Extract the exclusion set encoded by the `Pipeline_live_episode_key` CREATE's
// `WHERE status NOT IN ('a','b')` predicate. (The migration DROPs then CREATEs;
// only the CREATE carries a NOT IN, so slicing from the first mention and matching
// the first NOT IN finds the recreate predicate.)
function parsePartialIndexExclusions(sql: string): string[] {
  const createStart = sql.indexOf('Pipeline_live_episode_key');
  if (createStart < 0) {
    throw new Error('Pipeline_live_episode_key not found in the canonicalize migration');
  }
  const create = sql.slice(createStart);
  const m = /NOT\s+IN\s*\(([^)]*)\)/i.exec(create);
  if (!m) {
    throw new Error('Pipeline_live_episode_key: WHERE ... NOT IN (...) predicate not found');
  }
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0)
    .sort();
}

describe('B-index-parity: live-index migration predicate == LIVE_EPISODE_EXCLUSION_STATUSES', () => {
  it('the partial-index NOT IN list equals the 3-member canonical-terminal exclusion set (incl. voided)', () => {
    const parsed = parsePartialIndexExclusions(readFileSync(CANONICALIZE_MIGRATION, 'utf8'));
    const registry = [...LIVE_EPISODE_EXCLUSION_STATUSES].sort();

    // The canonical exclusion set = the three canonical terminals (VOID releases the slot).
    expect(registry).toEqual(['completed', 'not_in_consideration', 'voided']);
    expect(parsed).toEqual(registry);
  });
});
