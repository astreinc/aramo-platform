import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Track 3 / E2 (T0 v1.1 §2.4) — the reset marker GUC name must stay confined.
//
// Allowed to name `app.tenant_reset` (BEFORE the tenant-reset service PR):
//   - the canonical T0 directive (a .md, outside this .ts scan),
//   - the E2 migration trigger definitions (a .sql, outside this .ts scan),
//   - the dedicated E2 integration proof (a .spec.ts, excluded below).
// After the reset PR, the tenant-reset service becomes an additional allowed path.
//
// PROHIBITED: controllers, DTOs, request input, environment/config readers,
// generic repositories/helpers, any unrelated production code.
//
// This scans ALL tracked PRODUCTION TypeScript (libs + apps, excluding *.spec.ts
// and /tests/) and asserts the token appears in NONE — NOT a raw "only in two
// files" allowlist (the canonical directive contains it too; this scan simply
// never looks at .md / .sql / test files).
const MARKER = 'app.tenant_reset';

describe('reset-marker confinement (§2.4)', () => {
  it('app.tenant_reset does not appear in any production TypeScript', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    const files = execSync('git ls-files "libs/**/*.ts" "apps/**/*.ts"', { cwd: root, maxBuffer: 32 * 1024 * 1024 })
      .toString()
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.spec.ts') && !f.includes('/tests/'));

    const offenders = files.filter((f) => readFileSync(join(root, f), 'utf8').includes(MARKER));

    expect(
      offenders,
      `app.tenant_reset must not appear in production code (only the E2 migration .sql, its ` +
        `integration proof, and the canonical directive may name it). Offending files:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
