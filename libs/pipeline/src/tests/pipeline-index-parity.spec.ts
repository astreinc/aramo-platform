import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIVE_EPISODE_EXCLUSION_STATUSES } from '../lib/pipeline-state.js';

// ==== B-index-parity [L2-C SB-2] — registry <-> SQL drift guard (pivoted) ====
//
// The live-scoped partial unique (`Pipeline_live_episode_key`) carries the
// live-slot EXCLUSION set as a LITERAL PostgreSQL enum list, because a migration
// is immutable SQL and cannot import the TypeScript status registry.
//
// L2-C SB-2 PIVOT: the partition is now the explicit `LIVE_EPISODE_EXCLUSION_STATUSES`
// registry — the CANONICAL successful terminal `completed` + `not_in_consideration`,
// plus the LEGACY terminals `placed` + `client_declined` kept for history (§4
// tri-state). The prior `TERMINAL_STATUSES` (empty-edge) derivation cannot
// distinguish canonical from legacy terminals, so this guard pivots to the
// exclusion set and parses the L2-C INDEX-RECREATE migration (the E6 predicate is
// superseded). A partition change that omits `completed` OR drops a legacy member
// fails this proof until a new migration updates the DB invariant.
//
// Pure unit test (no Postgres): it parses the migration file and compares to the
// registry-derived exclusion set.
const INDEX_RECREATE_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
);

// Extract the exclusion set encoded by the `Pipeline_live_episode_key` CREATE's
// `WHERE status NOT IN ('a','b','c','d')` predicate. (The migration DROPs then
// CREATEs; only the CREATE carries a NOT IN, so slicing from the first mention and
// matching the first NOT IN finds the recreate predicate.)
function parsePartialIndexExclusions(sql: string): string[] {
  const createStart = sql.indexOf('Pipeline_live_episode_key');
  if (createStart < 0) {
    throw new Error('Pipeline_live_episode_key not found in the index-recreate migration');
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

describe('B-index-parity [L2-C]: index-recreate predicate == LIVE_EPISODE_EXCLUSION_STATUSES', () => {
  it('the partial-index NOT IN list equals the 4-member exclusion set (incl. the canonical `completed`)', () => {
    const parsed = parsePartialIndexExclusions(readFileSync(INDEX_RECREATE_MIGRATION, 'utf8'));
    const registry = [...LIVE_EPISODE_EXCLUSION_STATUSES].sort();

    // Non-vacuity: the REAL 4-member exclusion set — the two canonical terminals
    // (`completed`, `not_in_consideration`) + the two legacy terminals kept for
    // history (`placed`, `client_declined`). Omitting `completed` (which JOINS the
    // exclusion set) or dropping a legacy member (SB-1: no restamping) fails here.
    expect(registry).toEqual([
      'client_declined',
      'completed',
      'not_in_consideration',
      'placed',
    ]);
    expect(parsed).toEqual(registry);
  });
});
