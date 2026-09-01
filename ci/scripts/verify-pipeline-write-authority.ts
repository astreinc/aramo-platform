// L3-A — Pipeline write-authority guard (Client-Consideration authority contract).
//
// Codifies the "no Pipeline downstream-state mirroring" invariant that Lane 2
// established and Phase-0 (#732) finished cleaning up: the Pipeline aggregate is
// written ONLY by its owner (libs/pipeline, via the system-gated
// PipelineRepository); downstream client-consideration surfaces
// (Submittal / ClientSelection) reference a Pipeline episode by UUID only and
// must NEVER write its status — the exact mirror this program forbids
// (precedent: the retired `Submittal → Pipeline.submitted` mirror).
//
// Two machine-checked invariants:
//   W1 (raw-SQL sole-ownership): a raw `UPDATE`/`INSERT` against
//       "pipeline"."Pipeline" may appear ONLY under libs/pipeline. This is the
//       shape the retired mirror actually took (raw SQL in apps/api/submit-talent).
//   W2 (no coupling): the client-consideration domains must not import
//       @aramo/pipeline at all, so they physically cannot call a Pipeline write
//       method (I15 / SB-7 UUID-ref wall). Enforced dirs:
//         libs/submittal, libs/client-selection,
//         apps/api/src/submit-talent, apps/api/src/client-selection.
//
// Product code only — *.spec.ts, **/tests/**, and *.sql migrations are out of
// scope (tests legitimately seed Pipeline rows; migrations are the owner's).
//
// Run:       node --import jiti/register ci/scripts/verify-pipeline-write-authority.ts
// Self-test: SELF_TEST=1 node --import jiti/register ci/scripts/verify-pipeline-write-authority.ts

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// ── pure detectors (unit-testable; self-test exercises these exact fns) ────────

// NB: no trailing \b — the table ref ends in a `"` (non-word char), so a word
// boundary after it can never match. (The guard's own self-test caught this.)
const RAW_PIPELINE_WRITE =
  /\b(UPDATE|INSERT\s+INTO)\s+"pipeline"\."Pipeline"/i;

/** Lines in `text` that raw-write the Pipeline table. Returns 1-based line nums. */
export function findRawPipelineWrites(text: string): number[] {
  return text
    .split('\n')
    .map((line, i) => (RAW_PIPELINE_WRITE.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

const PIPELINE_IMPORT = /(from\s+['"]@aramo\/pipeline['"]|require\(\s*['"]@aramo\/pipeline['"])/;

/** Lines in `text` that couple to @aramo/pipeline. Returns 1-based line nums. */
export function findPipelineImports(text: string): number[] {
  return text
    .split('\n')
    .map((line, i) => (PIPELINE_IMPORT.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

// ── file enumeration ───────────────────────────────────────────────────────

function gitFiles(pathspecs: string[]): string[] {
  const out = execSync(
    `git ls-files -- ${pathspecs.map((p) => `'${p}'`).join(' ')}`,
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter(Boolean);
}

const NON_PRODUCT = /(\.spec\.ts$|\.test\.ts$|\/tests\/|\/__tests__\/)/;

// ── self-test: prove the detectors fire (built-in non-vacuous proof) ─────────

function selfTest(): void {
  const badSql = `const q = 'UPDATE "pipeline"."Pipeline" SET status = $1'`;
  const badInsert = `await db.query('INSERT INTO "pipeline"."Pipeline" (id) VALUES ($1)')`;
  const goodSqlRead = `const q = 'SELECT id FROM "pipeline"."Pipeline" WHERE id = $1 FOR UPDATE'`;
  const badImport = `import { PipelineRepository } from '@aramo/pipeline';`;
  const goodImport = `import { SubmittalRepository } from '@aramo/submittal';`;

  const checks: Array<[string, boolean]> = [
    ['raw UPDATE detected', findRawPipelineWrites(badSql).length === 1],
    ['raw INSERT detected', findRawPipelineWrites(badInsert).length === 1],
    ['raw SELECT/read NOT flagged', findRawPipelineWrites(goodSqlRead).length === 0],
    ['@aramo/pipeline import detected', findPipelineImports(badImport).length === 1],
    ['unrelated import NOT flagged', findPipelineImports(goodImport).length === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    console.error('SELF_TEST FAILED (guard is vacuous):');
    failed.forEach((f) => console.error(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log('SELF_TEST ok — both detectors fire on a planted violation and pass clean input.');
  process.exit(0);
}

// ── main scan ────────────────────────────────────────────────────────────────

const CONSIDERATION_DIRS = [
  'libs/submittal',
  'libs/client-selection',
  'apps/api/src/submit-talent',
  'apps/api/src/client-selection',
];

function main(): void {
  const violations: string[] = [];

  // W1 — raw-SQL Pipeline writes outside libs/pipeline (product code only).
  const w1Files = gitFiles([
    'libs/**/*.ts',
    'apps/**/*.ts',
    ':!libs/pipeline/**',
  ]).filter((f) => !NON_PRODUCT.test(f));
  for (const f of w1Files) {
    const lines = findRawPipelineWrites(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
    for (const ln of lines) {
      violations.push(
        `W1 raw Pipeline write outside libs/pipeline: ${f}:${ln} — only the ` +
          `system-gated PipelineRepository (libs/pipeline) may write Pipeline.`,
      );
    }
  }

  // W2 — @aramo/pipeline coupling inside the client-consideration domains.
  const w2Files = gitFiles(
    CONSIDERATION_DIRS.map((d) => `${d}/**/*.ts`),
  ).filter((f) => !NON_PRODUCT.test(f));
  for (const f of w2Files) {
    const lines = findPipelineImports(readFileSync(resolve(REPO_ROOT, f), 'utf8'));
    for (const ln of lines) {
      violations.push(
        `W2 client-consideration domain couples to @aramo/pipeline: ${f}:${ln} — ` +
          `reference the Pipeline episode by UUID only; never import the write surface.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `pipeline:write-authority FAILED — ${violations.length} violation(s):`,
    );
    violations.forEach((v) => console.error(`  ✗ ${v}`));
    process.exit(1);
  }
  console.log(
    'pipeline:write-authority ok — Pipeline is written only by its owner; ' +
      'no client-consideration mirror. (W1 raw-SQL sole-ownership, W2 no coupling.)',
  );
}

if (process.env.SELF_TEST === '1') selfTest();
else main();
