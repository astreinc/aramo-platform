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
// THE RULE (PR-C prose alignment, PO Ruling): a file is allowlisted ONLY when it
// CONTAINS THE LITERAL MARKER and has an authorized reason to. The blessed
// literal-bearing files are the trigger migrations that DEFINE the exact-value
// escape, the dedicated migration integration proofs that EXERCISE the escape via
// raw SET LOCAL, and the tenant-reset SERVICE that SETS it. Behavioral proofs that
// drive the reset through the service WITHOUT naming the literal (e.g. the
// tenant-reset six-part integration proof) do NOT contain the string and therefore
// do NOT need allowlisting. The marker must NOT appear in controllers, DTOs,
// request schemas, resolvers, env/config readers, generic repositories or SQL
// helpers, or any unrelated production code, test, or fixture.
const MARKER = ['app', 'tenant_reset'].join('.');

const EXACT_ALLOWLIST = new Set<string>([
  // E2 trigger migration — defines the exact-value escape.
  'libs/pre-start-requirement/prisma/migrations/20260804090000_init_pre_start_requirement/migration.sql',
  // Dedicated E2 integration proof — exercises the escape via raw SET LOCAL.
  'libs/pre-start-requirement/src/tests/pre-start-requirement.repository.integration.spec.ts',
  // The tenant-reset service — the ONLY production code that sets the marker.
  'libs/tenant-reset/src/lib/tenant-reset.service.ts',
  // PR-C placement reset-escape migration — defines the exact-value escape on the
  // placement OutboxEvent + PlacementProcessEvent DELETE-reject triggers.
  'libs/placement/prisma/migrations/20260806090000_placement_tenant_reset_escape/migration.sql',
  // Track 5 / T5-P1 — the AssignmentRateVersion append-only migration: its
  // DELETE-reject trigger carries the same exact-value escape so governed tenant
  // reset can delete the child (registered in tenant-reset.service.ts).
  'libs/placement/prisma/migrations/20260810130000_t5_assignment_rate_version/migration.sql',
  // Track 6 / T6-B1 — the effective-window migration CREATE OR REPLACEs the same
  // ARV mutation trigger, preserving the tenant_reset DELETE escape byte-for-byte
  // while adding the governed effective_to first-close UPDATE branch.
  'libs/placement/prisma/migrations/20260812140000_t6_b1_effective_window_substrate/migration.sql',
  // Track 6 / T6-B1 — the effective-window integration proof exercises the
  // tenant-reset DELETE escape (§12.3 regression + defensive-corruption cleanup)
  // via raw SET LOCAL.
  'libs/placement/src/tests/t6-b1-effective-window.integration.spec.ts',
  // Track 6 / T6-B1 — the placement-http resolver spec cleans up its injected
  // legacy-overlap fixture via the tenant-reset escape inside a self-restoring DDL
  // window (§10 defensive proof).
  'apps/api/src/tests/placement-http.integration.spec.ts',
  // Track 6 / T6-B3 — the commercial-cancellation migration CREATE OR REPLACEs the
  // same ARV mutation trigger AGAIN, preserving the tenant_reset DELETE escape
  // byte-for-byte while adding the cancellation + future-only re-open branches.
  'libs/placement/prisma/migrations/20260813130000_t6_b3_commercial_cancellation/migration.sql',
  // Track 6 / T6-B3 — the cancellation integration proof exercises the tenant-reset
  // DELETE escape (proving it stays independent of the cancellation capability, §29)
  // via raw SET LOCAL.
  'libs/placement/src/tests/t6-b3-commercial-cancellation.integration.spec.ts',
  // Track 7 / T7-P2 — the falloff+remedy migration CREATE OR REPLACEs the placement
  // event DELETE-reject trigger and adds the PermanentPlacementRemedy immutability
  // trigger, both carrying the same exact-value tenant_reset DELETE escape.
  'libs/placement/prisma/migrations/20260815120000_t7_p2_falloff_remedy/migration.sql',
  // Track 7 / T7-P2 — the falloff+remedy integration proof exercises the tenant-reset
  // DELETE escape (remedy-row cleanup) via raw SET LOCAL.
  'libs/placement/src/tests/t7-p2-falloff-remedy.integration.spec.ts',
  // Track 7 / T7-P3 — the guarantee-term-versioning migration's append-only trigger carries
  // the same exact-value tenant_reset DELETE escape on the version table.
  'libs/placement/prisma/migrations/20260816120000_t7_p3_guarantee_term_versioning/migration.sql',
  // Track 7 / T7-P3 — the guarantee-term-versioning integration proof exercises the
  // tenant-reset DELETE escape (governed version-row cleanup) via raw SET LOCAL.
  'libs/placement/src/tests/t7-p3-guarantee-term-versioning.integration.spec.ts',
  // T9-B4 — the commercial-margin read integration proof exercises the tenant-reset
  // DELETE escape (self-restoring DDL window: cleans up the injected corrupt
  // >1-current-version rows before re-adding the overlap EXCLUDE) via raw SET LOCAL.
  'libs/placement/src/tests/commercial-margin-read.integration.spec.ts',
  // Track 7 / T7-PX — the Contract-to-Permanent conversion migration: its
  // PermanentPlacementConversionLineage append-only trigger carries the same exact-value
  // tenant_reset DELETE escape (the AssignmentRateVersion / remedy precedent).
  'libs/placement/prisma/migrations/20260817120000_t7_px_contract_to_permanent_conversion/migration.sql',
  // Slice #3 — the AssignmentExtension append-only trigger carries the same
  // exact-value tenant_reset DELETE escape (the AssignmentRateVersion precedent).
  'libs/placement/prisma/migrations/20260825120000_assignment_extension_horizon/migration.sql',
  // Slice #4 — the CommercialRevisionProposalEvent append-only trigger carries the
  // same exact-value tenant_reset DELETE escape (the AssignmentExtension precedent).
  'libs/placement/prisma/migrations/20260826120000_commercial_revision_proposal/migration.sql',
  // L1-F1 — the RequisitionLifecycleEvent append-only trigger carries the same
  // exact-value tenant_reset DELETE escape (the placement precedent) so governed
  // tenant reset can delete the lifecycle-event rows (registered in tenant-reset.service.ts).
  'libs/requisition/prisma/migrations/20260827120000_requisition_lifecycle_event_append_only/migration.sql',
  // L1-F1 — the append-only integration proof exercises the tenant-reset DELETE
  // escape (governed lifecycle-event-row cleanup) via raw SET LOCAL.
  'apps/api/src/tests/requisition-lifecycle-append-only.integration.spec.ts',
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
