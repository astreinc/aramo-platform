import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// Reset-marker confinement — EXACT-PATH, DEFAULT-DENY (T0 v1.1 §2.4).
//
// The reset GUC marker name is CONSTRUCTED from fragments below, so THIS file
// never contains the literal string and therefore never needs to allowlist
// itself (approval record §8D — "construct the token from fragments so it does
// not match itself"). Every tracked file that names the marker MUST be one of
// the EXACT repository paths in the allowlist. Everything else fails — no
// directory/prefix/suffix wildcards, no broad test/CI exclusions.
//
// The marker may appear ONLY in: the E2 trigger migration (defines the escape),
// the dedicated E2 integration proof, the tenant-reset SERVICE (sets it), and
// the tenant-reset six-part integration proof. It must NOT appear in controllers,
// DTOs, request schemas, resolvers, env/config readers, generic repositories or
// SQL helpers, or any unrelated production code, test, or fixture.
const MARKER = ['app', 'tenant_reset'].join('.');

const EXACT_ALLOWLIST = new Set<string>([
  // E2 trigger migration — defines the exact-value escape.
  'libs/pre-start-requirement/prisma/migrations/20260804090000_init_pre_start_requirement/migration.sql',
  // Dedicated E2 integration proof — exercises the escape via raw SET LOCAL.
  'libs/pre-start-requirement/src/tests/pre-start-requirement.repository.integration.spec.ts',
  // The tenant-reset service — the ONLY production code that sets the marker.
  'libs/tenant-reset/src/lib/tenant-reset.service.ts',
]);

describe('reset-marker confinement — exact-path default-deny (§2.4)', () => {
  it('every tracked file naming the reset marker is in the exact allowlist', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    let occurrences: string[] = [];
    try {
      // git grep searches tracked file CONTENTS for the fixed string; the marker
      // is passed as a runtime argument, never present in this file's source.
      occurrences = execSync(`git grep -l -F -e ${JSON.stringify(MARKER)}`, {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      })
        .toString()
        .split('\n')
        .filter((f) => f.length > 0);
    } catch {
      // git grep exits non-zero when there are zero matches — treat as none.
      occurrences = [];
    }

    const offenders = occurrences.filter((f) => !EXACT_ALLOWLIST.has(f));
    expect(
      offenders,
      `the reset marker appears outside the exact-path allowlist (default-deny). Offending exact paths:\n  ${offenders.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });
});
