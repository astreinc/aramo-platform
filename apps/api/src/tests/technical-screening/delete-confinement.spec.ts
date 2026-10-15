import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// TIP-E2E INC-3 — screening DELETE confinement, EXACT-PATH, DEFAULT-DENY
// (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §10.1, §13 row 26; recon matrix row 26).
//
// The screening tables carry NO delete trigger and NO session marker (D8). The
// deletion boundary is therefore enforced HERE, in CI:
//   Rule 1 — a Prisma delete on a screening model may appear ONLY in the screening
//            repository (DRAFT finding removal inside the version-guarded tx).
//   Rule 2 — a SQL reference to a technical_screening table (the only way raw SQL
//            can DELETE one) may appear ONLY in the exact files listed, each with a
//            reason. The talent-erasure service is the ONLY production path that
//            DELETEs through raw SQL (its INVENTORY).
// Tokens are CONSTRUCTED from fragments so this file never matches itself
// (the marker-confinement precedent). No directory/prefix wildcards.

const ROOT = resolve(__dirname, '../../../../..');
const SCHEMA = ['technical', 'screening'].join('_');
const SQL_TABLE = new RegExp(`"?${SCHEMA}"?\\.\\s*"Screening`);
const PRISMA_DELETE = new RegExp(
  ['screening', '(Session|Finding|EvidencePublication|Event)', '\\.delete'].join(''),
);

const PRISMA_DELETE_ALLOWLIST = new Set<string>([
  // DRAFT finding removal — version-guarded, in the same tx as FINDING_REMOVED.
  'libs/technical-screening/src/lib/technical-screening.repository.ts',
]);

const SQL_TABLE_ALLOWLIST = new Set<string>([
  // The init migration — DEFINES the tables and their UPDATE-immutability triggers.
  'libs/technical-screening/prisma/migrations/20261016120000_inc3_technical_screening_init/migration.sql',
  // The repository — SELECT … FOR UPDATE on an intent and the merge re-key UPDATE
  // (no DELETE in raw SQL; Rule 1 covers its one Prisma delete).
  'libs/technical-screening/src/lib/technical-screening.repository.ts',
  // The talent-erasure service — the ONLY governed raw-SQL DELETE path (INVENTORY).
  'apps/api/src/talent-identity/talent-erasure.service.ts',
  // The tenant-reset service — PRESERVE_INVENTORY COUNT queries only (T0 PRESERVE;
  // the tables are absent from DELETE_INVENTORY).
  'libs/tenant-reset/src/lib/tenant-reset.service.ts',
  // Integration proofs that exercise the triggers / erasure / reset directly.
  'libs/technical-screening/src/tests/technical-screening.integration.spec.ts',
  'apps/api/src/tests/tr15-b2-erasure.integration.spec.ts',
  'apps/api/src/tests/tenant-reset.integration.spec.ts',
  'apps/api/src/tests/technical-screening/screening-http.integration.spec.ts',
  // The Pact provider — its throwaway test database TRUNCATEs screening rows between
  // interactions and seeds the screening provider state (never a production path).
  'pact/provider/src/verify-api.ts',
]);

function scannedFiles(): string[] {
  const out = execSync('git ls-files --cached --others --exclude-standard -- apps libs pact ci tools scripts', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|sql|sh)$/.test(f))
    .filter((f) => !f.includes('/prisma/generated/') && !f.includes('/node_modules/'));
}

describe('TIP-E2E INC-3 — screening delete confinement (default-deny)', () => {
  const files = scannedFiles();
  const hits = { prismaDelete: [] as string[], sqlTable: [] as string[] };
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    if (PRISMA_DELETE.test(text)) hits.prismaDelete.push(f);
    if (SQL_TABLE.test(text)) hits.sqlTable.push(f);
  }

  it('Rule 1 — a Prisma delete on a screening model appears only in the screening repository', () => {
    expect(hits.prismaDelete.filter((f) => !PRISMA_DELETE_ALLOWLIST.has(f))).toEqual([]);
  });

  it('Rule 2 — raw SQL naming a technical_screening table appears only in the allowlisted files', () => {
    expect(hits.sqlTable.filter((f) => !SQL_TABLE_ALLOWLIST.has(f))).toEqual([]);
  });

  it('the allowlists are live (every entry exists and still matches — no stale exemptions)', () => {
    for (const f of PRISMA_DELETE_ALLOWLIST) expect(hits.prismaDelete).toContain(f);
    for (const f of SQL_TABLE_ALLOWLIST) expect(hits.sqlTable).toContain(f);
  });
});
