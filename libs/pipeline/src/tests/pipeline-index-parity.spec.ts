import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TERMINAL_STATUSES } from '../lib/pipeline-state.js';

// ==== B-index-parity [E6 §3] — registry <-> SQL drift guard ====
//
// The E6 migration's live-scoped partial unique (`Pipeline_live_episode_key`)
// carries the terminal set as a LITERAL PostgreSQL enum list, because a
// migration is immutable SQL and cannot import the TypeScript status registry.
// The registry (pipeline-state.ts) remains the SEMANTIC SOURCE OF TRUTH; the
// migration is an intentionally duplicated enforcement surface, held honest by
// THIS drift test.
//
// A future status-registry change that alters the live/terminal partition
// (e.g. adding a terminal state, or making an existing state terminal) MUST FAIL
// this proof until a new migration updates the database invariant. This is a
// pure unit test (no Postgres): it parses the migration file and compares to the
// registry-derived TERMINAL_STATUSES.
const E6_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
);

// Extract the terminal set encoded by the `Pipeline_live_episode_key` CREATE's
// `WHERE status NOT IN ('a','b','c')` predicate.
function parsePartialIndexTerminals(sql: string): string[] {
  const createStart = sql.indexOf('Pipeline_live_episode_key');
  if (createStart < 0) {
    throw new Error('Pipeline_live_episode_key CREATE not found in the E6 migration');
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

describe('B-index-parity [E6]: migration live-scoped predicate == registry terminal set', () => {
  it('the partial-index NOT IN list equals the registry-derived TERMINAL_STATUSES', () => {
    const parsed = parsePartialIndexTerminals(readFileSync(E6_MIGRATION, 'utf8'));
    const registry = [...TERMINAL_STATUSES].sort();

    // Non-vacuity: both sides are the real three terminal statuses, not empty.
    expect(registry).toEqual(['client_declined', 'not_in_consideration', 'placed']);
    expect(parsed).toEqual(registry);
  });
});
