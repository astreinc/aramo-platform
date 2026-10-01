// DEFAULT-DENY api-spec-location guard.
//
//   node --import jiti/register ci/scripts/check-api-spec-location.ts
//   SELF_TEST=1 node --import jiti/register ci/scripts/check-api-spec-location.ts
//
// apps/api/vitest.config.ts has `include: ['src/tests/**/*.spec.ts']`, so a
// *.spec.ts / *.test.ts that lives ANYWHERE else under apps/api/src is NEVER
// discovered by vitest — it silently never runs (dead coverage, false green).
// This guard fails loudly, naming every offender, so a co-located spec cannot
// slip in unnoticed again. The truth is derived from the file system on every
// run (never a frozen count).
import { readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const API_SRC = resolve(REPO_ROOT, 'apps/api/src');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.nx',
  '.git',
  'coverage',
  'generated',
  'tmp',
  'build',
]);
const SPEC_RE = /\.(spec|test)\.ts$/;

// PURE classifier (self-testable): a repo-relative POSIX path is an offender iff
// it is an apps/api/src spec/test file NOT under apps/api/src/tests/.
export function isApiSpecOffender(relPosix: string): boolean {
  if (!relPosix.startsWith('apps/api/src/')) return false;
  if (!SPEC_RE.test(relPosix)) return false;
  return !relPosix.startsWith('apps/api/src/tests/');
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SPEC_RE.test(name)) out.push(full);
  }
}

const toPosixRel = (full: string): string =>
  relative(REPO_ROOT, full).split(sep).join('/');

// ── SELF-TEST: prove the classifier flags offenders and allows the legal set ──
if (process.env['SELF_TEST'] === '1') {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ['apps/api/src/my-desk/my-desk.service.spec.ts', true],
    ['apps/api/src/foo/bar.test.ts', true],
    ['apps/api/src/tests/my-desk.service.spec.ts', false],
    ['apps/api/src/tests/sub/x.integration.spec.ts', false],
    ['apps/api/src/my-desk/my-desk.service.ts', false], // not a spec
    ['libs/x/src/y.spec.ts', false], // not apps/api
  ];
  let ok = true;
  for (const [p, want] of cases) {
    const got = isApiSpecOffender(p);
    if (got !== want) {
      ok = false;
      console.error(`self-test FAIL: ${p} — expected ${want}, got ${got}`);
    }
  }
  if (!ok) {
    console.error('api-spec-location self-test FAILED');
    process.exit(1);
  }
  console.log(
    'api-spec-location self-test ok: flags apps/api specs outside src/tests; allows src/tests + non-spec + non-api.',
  );
  process.exit(0);
}

const found: string[] = [];
walk(API_SRC, found);
const offenders = found.map(toPosixRel).filter(isApiSpecOffender).sort();

if (offenders.length > 0) {
  console.error(
    `api-spec-location: ${offenders.length} apps/api spec file(s) live OUTSIDE apps/api/src/tests/ and are NEVER discovered by vitest (dead coverage):`,
  );
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(
    'Fix: move each into apps/api/src/tests/ (adjust relative imports) so vitest (include: src/tests/**) runs it.',
  );
  process.exit(1);
}

console.log(
  'api-spec-location ok: every apps/api *.spec.ts/*.test.ts lives under src/tests/ (discoverable).',
);
