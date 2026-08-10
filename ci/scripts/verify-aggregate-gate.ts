// GLH-1 (ATS Go-Live Hardening Charter v1.5) A + B — aggregate-gate membership wall.
//
// The `deployment-gate` job (.github/workflows/ci.yml) is the single required check
// branch protection enforces (PR-M0R-3 §4.1, VARIANT B). A job that RUNS in CI but is
// absent from `deployment-gate.needs` does NOT block a merge through that required check.
// Prior to GLH-1, `build` and `verify-vocabulary` ran but were NOT in `needs` — a green
// required check did not prove the nx build passed or the vocabulary wall held.
//
// This wall pins the GLH-critical members INTO the aggregate gate so they cannot silently
// drop out again. It is generic: it asserts a small REQUIRED set is a subset of the parsed
// `needs`, and that every REQUIRED member is a real job — it never enumerates the full gate
// list, so other tracks may add gates freely.
//
// Non-vacuous by construction: a built-in selftest feeds the validator a synthetic `needs`
// with a required member removed and FAILS if the omission is not detected. The wall runs
// the selftest first (proving the checker still catches the bug) then the real check.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const CI_YAML = resolve(ROOT, '.github', 'workflows', 'ci.yml');

// The job IDs (NOT display names) that MUST remain members of deployment-gate.needs.
// Keyed on GLH-1's mandate: build (A), verify-vocabulary (B), the env-passthrough wall
// (D), and this wall itself (self-pin so the guard cannot be silently unhooked).
// GLH-1 C (contract-parity) is NOT included — it is under ARCHITECTURE_HALT (no ratified
// governed-public-surface authority; see the v1.5 continuation record). Add
// 'contract-parity-check' here only when C is separately authorized and built.
export const REQUIRED_AGGREGATE_MEMBERS = [
  'build', // GLH-1 A — the CI-simulated nx build (catches the 3-place cross-lib wiring failure)
  'verify-vocabulary', // GLH-1 B — the trust-output vocabulary wall
  'env-passthrough-check', // GLH-1 D — prod env-passthrough parity
  'aggregate-gate-check', // GLH-1 self-pin — this wall must itself gate merges
] as const;

export interface GateModel {
  jobIds: string[];
  needs: string[];
}

/** Parse a ci.yml document into the set of job IDs and the deployment-gate.needs list. */
export function parseGateModel(ciYamlText: string): GateModel {
  const doc = parse(ciYamlText) as { jobs?: Record<string, { needs?: string[] }> };
  const jobs = doc.jobs ?? {};
  const jobIds = Object.keys(jobs);
  const gate = jobs['deployment-gate'];
  if (!gate) throw new Error('ci.yml has no `deployment-gate` job');
  const needs = Array.isArray(gate.needs) ? gate.needs : gate.needs ? [gate.needs] : [];
  return { jobIds, needs };
}

export interface Violation {
  member: string;
  reason: 'absent-from-needs' | 'not-a-real-job';
}

/**
 * Assert every REQUIRED member is (a) a real job in the workflow and (b) present in
 * deployment-gate.needs. Returns the list of violations (empty = pass).
 */
export function validateAggregateGate(
  model: GateModel,
  required: readonly string[] = REQUIRED_AGGREGATE_MEMBERS,
): Violation[] {
  const violations: Violation[] = [];
  const needsSet = new Set(model.needs);
  const jobSet = new Set(model.jobIds);
  for (const member of required) {
    if (!jobSet.has(member)) violations.push({ member, reason: 'not-a-real-job' });
    else if (!needsSet.has(member)) violations.push({ member, reason: 'absent-from-needs' });
  }
  return violations;
}

// ── Embedded selftest (isolated fixture; the "seeded failing test") ──────────────────────
// A synthetic model that IS a real job but is dropped from needs must be flagged. If it is
// not, the checker has gone vacuous and the wall fails loudly.
function selftest(): void {
  const fixture: GateModel = {
    jobIds: [
      'build',
      'verify-vocabulary',
      'env-passthrough-check',
      'aggregate-gate-check',
      'deployment-gate',
    ],
    needs: ['verify-vocabulary', 'env-passthrough-check', 'aggregate-gate-check'], // `build` deliberately omitted
  };
  const v = validateAggregateGate(fixture);
  const caughtBuild = v.some((x) => x.member === 'build' && x.reason === 'absent-from-needs');
  if (!caughtBuild) {
    console.error(
      'SELFTEST FAILED: verify-aggregate-gate did not detect a required member missing from deployment-gate.needs — the checker is vacuous.',
    );
    process.exit(2);
  }
}

function main(): void {
  selftest();
  const text = readFileSync(CI_YAML, 'utf8');
  const model = parseGateModel(text);
  const violations = validateAggregateGate(model);
  if (violations.length > 0) {
    console.error('✗ aggregate-gate membership violations:');
    for (const v of violations) {
      const msg =
        v.reason === 'not-a-real-job'
          ? `required member "${v.member}" is not a defined job in ci.yml`
          : `required member "${v.member}" is missing from deployment-gate.needs (runs but does not gate merges)`;
      console.error(`  - ${msg}`);
    }
    console.error(
      '\nGLH-1: build, verify-vocabulary, and the GLH-1 gate walls must be members of deployment-gate.needs.',
    );
    process.exit(1);
  }
  console.log(
    `✓ aggregate-gate: all ${REQUIRED_AGGREGATE_MEMBERS.length} GLH-required members present in deployment-gate.needs (${model.needs.length} total needs).`,
  );
}

main();
