import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaService as PlacementPrismaService } from '@aramo/placement';

// Track 4 / T4-B2 — ONE shared harness for the requisition<->placement capacity
// cutover proofs (CLAUDE.md: a re-point rippling into N gated specs gets ONE shared
// helper, not N duplicated migration-lists + splitters). The reader cutover makes
// every requisition read pull placement's ACTIVE ContractAssignment count, so any
// spec exercising a requisition read (via the REAL requisition Prisma client, which
// SELECTs the FULL current column set) now needs BOTH complete schemas.
//
// Directory-scan both chains (never a remembered list — the E6/§8 curator lesson):
// a migration added to either dir is picked up here automatically, in filename
// order (timestamp-prefixed → chronological).
function migrationsIn(libDir: string): string[] {
  const dir = resolve(__dirname, `../../../${libDir}/prisma/migrations`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => resolve(dir, name, 'migration.sql'));
}

export const CAPACITY_B2_MIGRATIONS = [
  ...migrationsIn('requisition'),
  ...migrationsIn('placement'),
];

// Apply the requisition-init + placement migration set to a fresh container URL.
export async function applyCapacityB2Migrations(url: string): Promise<void> {
  const setup = new PlacementPrismaService(url);
  await setup.$connect();
  try {
    for (const path of CAPACITY_B2_MIGRATIONS) {
      for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setup.$executeRawUnsafe(trimmed);
      }
    }
  } finally {
    await setup.$disconnect();
  }
}

// Comment-aware DDL splitter — skips `;` inside `--` line comments (several
// requisition/placement migrations carry them; a comment-blind splitter mis-splits)
// and tolerates `$$` dollar-quoted bodies.
export function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
