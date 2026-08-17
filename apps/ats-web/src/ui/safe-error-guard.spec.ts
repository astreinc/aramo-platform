import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// T10-B2 §15 / F-018 (S1) — a TARGETED regression guard against reintroducing
// user-visible raw thrown-error messages. It scans presentation modules for the
// SPECIFIC unsafe render/return shapes only; it is NOT a blanket `.message` ban
// (safe stored `state.message` reads, typed mapped-object fields, and logging
// are all unaffected). New user-facing errors must route through a governed
// mapper or `safeErrorMessage(err, fallback)`.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = [
  'settings',
  'org',
  'teams',
  'users',
  'portal-disputes',
  'submittals',
  'integrations',
  'reporting',
];

const UNSAFE: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'raw-message ternary render',
    re: /instanceof\s+(?:Error|ApiError)\s*\?\s*[A-Za-z_$][\w$]*\.message\b/,
  },
  {
    name: 'mapper title fallback to raw message',
    re: /return\s*\{\s*title:\s*[A-Za-z_$][\w$]*\.message\s*\}/,
  },
  {
    name: 'direct return of raw message',
    re: /return\s+[A-Za-z_$][\w$]*\.message\s*;/,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.spec\.(ts|tsx)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

describe('raw-error regression guard (T10-B2 §15/F-018)', () => {
  it('no presentation module renders/returns a raw thrown-error message', () => {
    const violations: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(SRC, d))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            for (const { name, re } of UNSAFE) {
              if (re.test(line)) {
                violations.push(
                  `${file.replace(SRC, 'src')}:${i + 1} — ${name}: ${line.trim()}`,
                );
              }
            }
          });
      }
    }
    expect(violations).toEqual([]);
  });
});
