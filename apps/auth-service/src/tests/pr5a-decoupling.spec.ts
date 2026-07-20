import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Auth-Decoupling §4.5 (PR-5a) + §3.4 (PR-5b, WIDENED) — THE ACCEPTANCE TEST.
// A DIRECTORY-WIDE SWEEP (not per-file): no pure file imports any Aramo DOMAIN lib.
// PR-5b relocated the pure side into libs/auth-core behind the scope:auth wall, so
// this sweep now covers TWO directories:
//   - libs/auth-core/src/lib/ — the portable core (NO exemptions; belt-and-braces
//     alongside the lint wall, with a clearer message than a boundary violation).
//   - apps/auth-service/src/app/auth/ — now only auth.module.ts + the adapters,
//     which are EXEMPT (importing Aramo domain is their job, §0).
// Comment-stripped (PR-2/3 §3.4 precedent).

const REPO_ROOT = resolve(__dirname, '../../../..');
const AUTH_CORE_LIB = resolve(REPO_ROOT, 'libs/auth-core/src/lib');
const AUTH_APP_DIR = resolve(__dirname, '../app/auth');

const FORBIDDEN_LIBS = [
  '@aramo/identity',
  '@aramo/identity-index',
  '@aramo/mailer',
  '@aramo/portal-identity',
] as const;

// In the app dir only the adapters + composition root may import Aramo domain;
// in libs/auth-core NOTHING may.
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

describe('§4.5/§3.4 — the pure side (libs/auth-core + app pure files) imports no Aramo domain lib', () => {
  // libs/auth-core: EVERY file must be clean (the portable core). app/auth: only
  // non-exempt files (none remain — adapters + module are exempt), kept for
  // regression if a new pure file is ever added back to the app.
  const coreFiles = listTsFiles(AUTH_CORE_LIB);
  const appFiles = listTsFiles(AUTH_APP_DIR).filter((f) => !isExempt(f.split('/').pop()!));
  const files = [...coreFiles, ...appFiles];

  it('the sweep found the relocated pure core (guards against an empty glob)', () => {
    expect(coreFiles.length).toBeGreaterThan(15);
  });

  for (const file of files) {
    const label = file.slice(REPO_ROOT.length + 1);
    it(`${label} imports none of the four Aramo domain libs`, () => {
      const specs = importSpecifiers(readFileSync(file, 'utf8'));
      const leaks = specs.filter((s) => (FORBIDDEN_LIBS as readonly string[]).includes(s));
      expect(leaks).toEqual([]);
    });
  }
});
