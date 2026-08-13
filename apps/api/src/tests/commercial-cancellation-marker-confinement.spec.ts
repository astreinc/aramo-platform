import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// Commercial-CANCELLATION-marker confinement — EXACT-PATH, DEFAULT-DENY (T6-B3 §9).
//
// The governed cancellation + future-boundary re-open capability is gated on a
// SEPARATE transaction-local GUC, distinct from the B1/B2 revision (first-close)
// marker. Its literal name is CONSTRUCTED from fragments below, so THIS file never
// contains the string and never allowlists itself (mirrors the reset- and revision-
// marker confinement precedents). Every tracked file that names the cancellation
// marker MUST be one of the EXACT repository paths in the allowlist — no directory
// or prefix wildcards.
//
// THE RULE: a file is allowlisted ONLY when it CONTAINS THE LITERAL MARKER and has an
// authorized reason to. At B3 the blessed literal-bearing files are (1) the trigger
// migration that DEFINES the cancellation + re-open branches, (2) the production
// setter in the placement repository (explicit cancellation + END reconciliation),
// and (3) the dedicated integration proof that EXERCISES the branches via raw SET
// LOCAL. The marker must NOT appear in controllers, DTOs, request schemas, resolvers,
// env/config readers, generic repositories, or any unrelated production code, test, or
// fixture. In particular it must NOT be conflated with the revision marker's allowlist
// (§9: cancellation authority is not equivalent to revision authority).
const MARKER = ['app', 'assignment_commercial_cancellation'].join('.');

const EXACT_ALLOWLIST = new Set<string>([
  // T6-B3 trigger migration — defines the write-once cancellation branch and the
  // future-only re-open branch under the exact-value cancellation capability.
  'libs/placement/prisma/migrations/20260813130000_t6_b3_commercial_cancellation/migration.sql',
  // T6-B3 production setter — the cancellation + END reconciliation transactions in
  // the placement repository SET LOCAL the marker to cancel a tail and re-open a
  // future boundary (END additionally sets the revision marker for the final close).
  'libs/placement/src/lib/placement.repository.ts',
  // Dedicated T6-B3 integration proof — exercises both new branches via raw SET LOCAL
  // (trigger truth table, cancellation continuity, END reconciliation matrix).
  'libs/placement/src/tests/t6-b3-commercial-cancellation.integration.spec.ts',
]);

describe('commercial-cancellation-marker confinement — exact-path default-deny (T6-B3 §9)', () => {
  it('every tracked file naming the commercial-cancellation marker is in the exact allowlist', () => {
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
      `the commercial-cancellation marker appears outside the exact-path allowlist (default-deny). Offending exact paths:\n  ${offenders.join(
        '\n  ',
      )}`,
    ).toEqual([]);
  });
});
