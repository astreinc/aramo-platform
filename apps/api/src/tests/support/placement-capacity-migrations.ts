import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Track 4 / T4-B2 — SHARED test helper (CLAUDE.md: a re-point rippling into N gated
// specs gets ONE shared helper, not N duplicated migration lists). After the B2
// reader cutover, a requisition read DERIVES openings_available from the
// placement-owned ACTIVE ContractAssignment population, so EVERY app-level
// integration spec that reads a requisition (GET/list/transition/create returning a
// view) must have the placement schema — including ContractAssignment — in its
// container, or the read 500s on a missing relation.
//
// Returns the full placement migration chain in chronological (filename) order.
// Placement is a self-contained schema (UUID-only cross-schema refs, no FK), so
// these can be appended after any other lib's migrations. Applied the same way the
// callers apply their own migrations (whole-file query; no splitter needed).
export function placementCapacityMigrations(root: string): string[] {
  const dir = resolve(root, 'libs/placement/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
