import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

// CCP-A8 — ONE shared helper for the gated specs that apply a HAND-KEPT prefix of the subscription
// chain (pre-A4 + A4 + A5 goldens, the lifecycle spec) and then run the CURRENT code (CLAUDE.md:
// one shared test helper, not N duplicated edits). From CCP-A8 the allowance reader also reads
// subscription."SupportExtension" (a PAST_DUE row past grace may be kept sending by an overlay), so
// the code under test needs the HEAD schema. This applies every subscription migration the spec has
// NOT applied, in name order, whole-file (dollar-quoted bodies). The behaviour is uniform: none of
// these specs writes an overlay, so their observed results are the pre-A8 ones (no overlay row →
// the reader is exactly the pre-A8 rule; asserted by the unchanged goldens).

const SUB_DIR = resolve(__dirname, '../../../prisma/migrations');

/** Every subscription migration not in `applied` (absolute paths), in name order. */
export function remainingSubscriptionMigrations(applied: readonly string[]): string[] {
  const done = new Set(applied.map((p) => resolve(p)));
  return readdirSync(SUB_DIR)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(SUB_DIR, n, 'migration.sql'))
    .filter((p) => !done.has(p));
}

export async function applyRemainingSubscriptionMigrations(pg: Client, applied: readonly string[]): Promise<string[]> {
  const rest = remainingSubscriptionMigrations(applied);
  for (const m of rest) await pg.query(readFileSync(m, 'utf8'));
  return rest;
}
