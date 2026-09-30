// GS-2 P1 tripwire — the workspace has ONE canonical Postgres test-container image
// (ARAMO_POSTGRES_TEST_IMAGE in libs/common/src/lib/testing/postgres-test-image.ts). This
// guard FAILS if any git-tracked .ts under apps/ or libs/ constructs a Testcontainers
// PostgreSqlContainer with a literal `postgres:` image outside that module — so the DB test
// runtime cannot silently split again (a literal postgres:17 would not be pgvector-capable
// and would break any spec applying a vector-owning migration chain). Truth is derived from
// the FS on every run; no frozen count.
//
//   node --import jiti/register ci/scripts/verify-postgres-test-image.ts
import { execFileSync } from 'node:child_process';

const CANONICAL = 'libs/common/src/lib/testing/postgres-test-image.ts';

function gitGrep(): string {
  try {
    return execFileSync(
      'git',
      ['grep', '-nE', "PostgreSqlContainer\\((['\"])postgres:", '--', 'apps/**/*.ts', 'libs/**/*.ts'],
      { encoding: 'utf8' },
    );
  } catch (e: unknown) {
    // git grep exits 1 when there are zero matches — the success case.
    const err = e as { status?: number };
    if (err.status === 1) return '';
    throw e;
  }
}

const violations = gitGrep()
  .split('\n')
  .filter((l) => l.trim() !== '' && !l.startsWith(CANONICAL));

if (violations.length > 0) {
  console.error('✗ pg-test-image:check — literal `postgres:` container image outside the canonical constant:');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n  Use ARAMO_POSTGRES_TEST_IMAGE from @aramo/common (${CANONICAL}).`);
  process.exit(1);
}

console.log('pg-test-image:check ok — all Testcontainers callers use ARAMO_POSTGRES_TEST_IMAGE.');
