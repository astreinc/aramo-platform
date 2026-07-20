import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Auth-Decoupling PR-5a §4.5 — THE ACCEPTANCE TEST, and PR-5b's precondition.
// A DIRECTORY-WIDE SWEEP (not per-file): no file in apps/auth-service/src/app/auth/
// except *.adapter.ts imports any Aramo DOMAIN library. Exhaustive — 5b moves this
// exact "pure side" into libs/auth-core behind the scope:auth wall, so any leak
// here means the wall fails on the first try.
//
// EXEMPT: *.adapter.ts (adapters — importing Aramo domain is their job) AND
// auth.module.ts (the composition root / wiring — it wires the Aramo modules to
// supply the adapters; §0: "adapters + wiring stay in apps/auth-service, untagged,
// unconstrained by design"). Comment-stripped (PR-2/3 §3.4 precedent).

const AUTH_DIR = resolve(__dirname, '../app/auth');

const FORBIDDEN_LIBS = [
  '@aramo/identity',
  '@aramo/identity-index',
  '@aramo/mailer',
  '@aramo/portal-identity',
] as const;

// Files that MAY import Aramo domain: the adapters + the composition root.
function isExempt(basename: string): boolean {
  return basename.endsWith('.adapter.ts') || basename === 'auth.module.ts';
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importSpecifiers(code: string): string[] {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
  // capture the module specifier of every `from '...'` / `from "..."`
  const specs: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) specs.push(m[1]!);
  return specs;
}

describe('§4.5 — the pure side of apps/auth-service/src/app/auth imports no Aramo domain lib', () => {
  const files = listTsFiles(AUTH_DIR).filter((f) => !isExempt(f.split('/').pop()!));

  it('the sweep found a non-trivial set of pure files (guards against an empty glob)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const basename = file.split('/').slice(-2).join('/');
    it(`${basename} imports none of the four Aramo domain libs`, () => {
      const specs = importSpecifiers(readFileSync(file, 'utf8'));
      const leaks = specs.filter((s) => (FORBIDDEN_LIBS as readonly string[]).includes(s));
      expect(leaks).toEqual([]);
    });
  }
});
