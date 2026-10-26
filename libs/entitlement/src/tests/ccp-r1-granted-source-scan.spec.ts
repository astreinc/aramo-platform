import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// CCP-R1 (TD-A7-3, Architect program acceptance disposition) — granted_source has NO database
// default, so every INSERT into entitlement."TenantEntitlement" must name its source. This source
// scan walks apps/, libs/, pact/, tools/, deploy/ and scripts/ and fails on any INSERT whose column
// list omits granted_source, outside the closed exemption list below (each one runs against a
// pre-A7 schema, where the column does not exist yet). It also pins the production write-path
// inventory (doc/ccp/slices/CCP-A7-acceptance.md, R1) and forbids an ORM write to the table.

const REPO_ROOT = resolve(__dirname, '../../../..');
const ROOTS = ['apps', 'libs', 'pact', 'tools', 'deploy', 'scripts'];
const EXT = /\.(ts|tsx|js|mjs|cjs|sh|sql|py)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', 'coverage', 'tmp', 'generated']);
const SELF = 'libs/entitlement/src/tests/ccp-r1-granted-source-scan.spec.ts';

// Closed exemption list: path -> exact count of INSERT sites that may omit granted_source.
const EXEMPT: Record<string, { count: number; why: string }> = {
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql': {
    count: 1,
    why: 'immutable init migration seed; the column is added later by the A7 migration',
  },
  'libs/entitlement/src/tests/ccp-a7-revoke-provenance.integration.spec.ts': {
    count: 2,
    why: 'one pre-A7 row the A7 backfill must stamp MIGRATION; one R1-E-1 proof that an omitted source fails NOT NULL',
  },
  'libs/subscription/src/tests/fixtures/ccp-a11-production-like.ts': {
    count: 1,
    why: 'models production before CCP (pre-A7 schema); the A7 backfill then stamps these rows MIGRATION',
  },
  'tools/sign-naming/naming.pg-integration.sh': {
    count: 1,
    why: 'the pre-rename (pre-A7) tree builds the old world before the new migrations run',
  },
};

// The production write path: ONE shared statement, reached through EntitlementRepository.grantCapabilities
// and grantCapabilitiesInTx, each of which requires granted_source in its signature.
const PRODUCTION_INSERT_SITES = ['libs/entitlement/src/lib/entitlement-provenance.ts'];

interface Site {
  path: string;
  line: number;
  columns: string;
}

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
  return out;
}

function scan(): { sites: Site[]; texts: Map<string, string> } {
  const sites: Site[] = [];
  const texts = new Map<string, string>();
  const re = /insert\s+into\s+[^\s(]*TenantEntitlement(?!Event)\W/gi;
  for (const root of ROOTS) {
    for (const abs of files(resolve(REPO_ROOT, root))) {
      const path = relative(REPO_ROOT, abs).split('\\').join('/');
      if (path === SELF) continue;
      const src = readFileSync(abs, 'utf8');
      texts.set(path, src);
      for (const m of src.matchAll(re)) {
        const tail = src.slice(m.index, m.index + 600);
        const columns = /^[^(]*\(([^)]*)\)/.exec(tail)?.[1] ?? '';
        sites.push({ path, line: src.slice(0, m.index).split('\n').length, columns: columns.replace(/\s+/g, ' ').trim() });
      }
    }
  }
  return { sites, texts };
}

const isProduction = (p: string) =>
  !/(^|\/)(tests?|testing|e2e|fixtures)\//.test(p) && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(p) && !p.startsWith('pact/') && !p.startsWith('tools/') && !p.includes('/prisma/migrations/');

describe('CCP-R1 granted_source source scan (no default, no silent MIGRATION fallback)', () => {
  const { sites, texts } = scan();

  it('R1-U-1 every INSERT into TenantEntitlement names granted_source, outside the closed pre-A7 exemption list', () => {
    expect(sites.length).toBeGreaterThan(0);
    const missing = sites.filter((s) => !/\bgranted_source\b/.test(s.columns));
    const byPath = new Map<string, number>();
    for (const s of missing) byPath.set(s.path, (byPath.get(s.path) ?? 0) + 1);
    const unexpected = missing.filter((s) => EXEMPT[s.path] === undefined).map((s) => `${s.path}:${s.line} (${s.columns})`);
    expect(unexpected).toEqual([]);
    expect(Object.fromEntries(byPath)).toEqual(Object.fromEntries(Object.entries(EXEMPT).map(([p, e]) => [p, e.count])));
  });

  it('R1-U-2 the production write-path inventory is exactly the shared provenance upsert', () => {
    expect([...new Set(sites.filter((s) => isProduction(s.path)).map((s) => s.path))].sort()).toEqual(PRODUCTION_INSERT_SITES);
  });

  it('R1-U-3 no ORM write to TenantEntitlement (every write is the raw provenance statement)', () => {
    const orm = /\btenantEntitlement\s*\.\s*(create|createMany|createManyAndReturn|upsert|update|updateMany)\s*\(/;
    const hits = [...texts].filter(([, src]) => orm.test(src)).map(([p]) => p);
    expect(hits).toEqual([]);
  });

  it('R1-U-4 schema.prisma declares granted_source without @default', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'libs/entitlement/prisma/schema.prisma'), 'utf8');
    const model = /model TenantEntitlement \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';
    const line = model.split('\n').find((l) => /^\s*granted_source\s/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/^\s*granted_source\s+String\s*$/);
  });
});
