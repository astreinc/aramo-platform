import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// Commercial-revision-marker confinement — EXACT-PATH, DEFAULT-DENY (T6-B1 §5.2).
//
// The governed effective_to first-close capability is gated on a transaction-local
// GUC. Its literal name is CONSTRUCTED from fragments below, so THIS file never
// contains the string and never allowlists itself (mirrors the reset-marker
// confinement precedent). Every tracked file that names the marker MUST be one of
// the EXACT repository paths in the allowlist — no directory/prefix wildcards.
//
// THE RULE: a file is allowlisted ONLY when it CONTAINS THE LITERAL MARKER and has
// an authorized reason to. At B1 the blessed literal-bearing files are (1) the
// trigger migration that DEFINES the exact-value close capability and (2) the
// dedicated integration proof that EXERCISES it via raw SET LOCAL. There is NO
// production setter in B1 — when B2 introduces the first production setter, its file
// must be added here explicitly. The marker must NOT appear in controllers, DTOs,
// request schemas, resolvers, env/config readers, generic repositories, or any
// unrelated production code, test, or fixture.
const MARKER = ['app', 'assignment_commercial_revision'].join('.');

const EXACT_ALLOWLIST = new Set<string>([
  // T6-B1 trigger migration — defines the exact-value effective_to first-close.
  'libs/placement/prisma/migrations/20260812140000_t6_b1_effective_window_substrate/migration.sql',
  // Dedicated T6-B1 integration proof — exercises the capability via raw SET LOCAL.
  'libs/placement/src/tests/t6-b1-effective-window.integration.spec.ts',
  // T6-B1 HTTP resolver proof — exercises the governed effective_to close via raw
  // SET LOCAL to build a valid non-overlapping future-version scenario.
  'apps/api/src/tests/placement-http.integration.spec.ts',
]);

describe('commercial-revision-marker confinement — exact-path default-deny (T6-B1 §5.2)', () => {
  it('every tracked file naming the commercial-revision marker is in the exact allowlist', () => {
    const root = execSync('git rev-parse --show-toplevel').toString().trim();
    let occurrences: string[] = [];
    try {
      // git grep searches tracked file CONTENTS for the fixed string; the marker is
      // passed as a runtime argument, never present in this file's source.
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
      `the commercial-revision marker appears outside the exact-path allowlist (default-deny). Offending exact paths:\n  ${offenders.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });
});
