import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ATI-SEP-1 — the ONE shared migration collector + DDL splitter for the ATS-side
// Talent Intelligence integration specs (T8 integration, backfill). Both specs
// need the same documents + talent_evidence + talent_record + entitlement schema
// on a throwaway Postgres; this keeps that behaviour uniform (shared-helper law).

const ROOT = resolve(__dirname, '../../../../..');
export const INTELLIGENCE_INTEGRATION_MIGRATION_LIBS = ['documents', 'talent-evidence', 'talent-record', 'entitlement'] as const;

// Every migration.sql of the listed libs, globally ordered by timestamped name.
export function collectIntelligenceIntegrationMigrations(): string[] {
  const all: { name: string; path: string }[] = [];
  for (const lib of INTELLIGENCE_INTEGRATION_MIGRATION_LIBS) {
    const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && /^\d+_/.test(d.name)) all.push({ name: d.name, path: resolve(dir, d.name, 'migration.sql') });
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.path);
}

// Dollar-quote / comment / string-literal aware splitter (top-level `;` only).
export function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let tag: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (tag === null && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      cur += '\n';
      i = nl + 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m !== null && (tag === null || tag === m[0])) {
        tag = tag === null ? m[0] : null;
        cur += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (tag === null && ch === "'") {
      cur += ch;
      i += 1;
      while (i < sql.length) {
        cur += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            cur += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (tag === null && ch === ';') {
      if (cur.trim().length > 0) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}
