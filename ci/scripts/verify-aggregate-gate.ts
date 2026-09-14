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
// (D), the contract-parity wall (C — now ratified and built), and this wall itself
// (self-pin so the guard cannot be silently unhooked).
export const REQUIRED_AGGREGATE_MEMBERS = [
  'build', // GLH-1 A — the CI-simulated nx build (catches the 3-place cross-lib wiring failure)
  'verify-vocabulary', // GLH-1 B — the trust-output vocabulary wall
  'env-passthrough-check', // GLH-1 D — prod env-passthrough parity
  'contract-parity-check', // GLH-1-C — governed API route<->OpenAPI parity
  'aggregate-gate-check', // GLH-1 self-pin — this wall must itself gate merges
] as const;

// CI-Velocity-2 (§PR-2) — the cheap governance walls consolidated into the single
// `static-governance` job (one runner, one `npm ci`, one named step each). Before
// consolidation each was a standalone job listed in deployment-gate.needs, so it
// could not silently vanish (a dangling `needs` ref is a hard workflow error). As
// named STEPS they lose that implicit protection — so this wall machine-enforces
// their continued presence: every entry MUST be a named step of `static-governance`,
// and `static-governance` MUST itself be a member of deployment-gate.needs. Removing
// any folded wall now fails THIS check (it no longer "runs but does not gate"). These
// step names are the exact `name:` values in .github/workflows/ci.yml.
export const STATIC_GOVERNANCE_JOB = 'static-governance';
export const REQUIRED_STATIC_GOVERNANCE_STEPS = [
  'openapi:validate',
  'openapi:lint',
  'openapi:drift-check',
  'portal:refusal-check',
  'ats:refusal-check',
  'ingestion:refusal-check',
  'frontdoor:conf-check',
  'version:sync-check',
  'error-codes:check',
  'orphan-scopes:self-test',
  'orphan-scopes:check',
  'dead-error-codes:self-test',
  'dead-error-codes:check',
  'pipeline:write-authority:self-test',
  'pipeline:write-authority:check',
  'integration-roots:check',
  'repo-map:check',
  'release-manifest:check',
  'identity-index:privacy-wall',
] as const;

export interface GateModel {
  jobIds: string[];
  needs: string[];
  /** `name:` values of every step in the static-governance job (empty if the job is absent). */
  staticGovernanceSteps: string[];
}

/** Parse a ci.yml document into job IDs, deployment-gate.needs, and static-governance step names. */
export function parseGateModel(ciYamlText: string): GateModel {
  const doc = parse(ciYamlText) as {
    jobs?: Record<string, { needs?: string[]; steps?: Array<{ name?: string }> }>;
  };
  const jobs = doc.jobs ?? {};
  const jobIds = Object.keys(jobs);
  const gate = jobs['deployment-gate'];
  if (!gate) throw new Error('ci.yml has no `deployment-gate` job');
  const needs = Array.isArray(gate.needs) ? gate.needs : gate.needs ? [gate.needs] : [];
  const sg = jobs[STATIC_GOVERNANCE_JOB];
  const staticGovernanceSteps = (sg?.steps ?? [])
    .map((s) => s.name)
    .filter((n): n is string => typeof n === 'string');
  return { jobIds, needs, staticGovernanceSteps };
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

export interface StaticGovernanceViolation {
  reason: 'job-missing' | 'job-not-in-needs' | 'step-missing';
  detail: string;
}

/**
 * CI-Velocity-2 — assert the consolidated `static-governance` job exists, gates merges
 * (is a member of deployment-gate.needs), and still carries every folded wall as a named
 * step. Any folded wall removed from the job now fails here instead of silently ceasing
 * to gate. Returns the list of violations (empty = pass).
 */
export function validateStaticGovernance(
  model: GateModel,
  requiredSteps: readonly string[] = REQUIRED_STATIC_GOVERNANCE_STEPS,
): StaticGovernanceViolation[] {
  const violations: StaticGovernanceViolation[] = [];
  if (!model.jobIds.includes(STATIC_GOVERNANCE_JOB)) {
    violations.push({
      reason: 'job-missing',
      detail: `job "${STATIC_GOVERNANCE_JOB}" is not defined in ci.yml`,
    });
    return violations; // nothing else is meaningful without the job
  }
  if (!model.needs.includes(STATIC_GOVERNANCE_JOB)) {
    violations.push({
      reason: 'job-not-in-needs',
      detail: `"${STATIC_GOVERNANCE_JOB}" is not a member of deployment-gate.needs (its folded walls would run but not gate)`,
    });
  }
  const stepSet = new Set(model.staticGovernanceSteps);
  for (const step of requiredSteps) {
    if (!stepSet.has(step)) {
      violations.push({
        reason: 'step-missing',
        detail: `folded wall step "${step}" is absent from the "${STATIC_GOVERNANCE_JOB}" job (validation dropped)`,
      });
    }
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
      'contract-parity-check',
      'aggregate-gate-check',
      'deployment-gate',
    ],
    needs: [
      'verify-vocabulary',
      'env-passthrough-check',
      'contract-parity-check',
      'aggregate-gate-check',
    ], // `build` deliberately omitted
    staticGovernanceSteps: [],
  };
  const v = validateAggregateGate(fixture);
  const caughtBuild = v.some((x) => x.member === 'build' && x.reason === 'absent-from-needs');
  if (!caughtBuild) {
    console.error(
      'SELFTEST FAILED: verify-aggregate-gate did not detect a required member missing from deployment-gate.needs — the checker is vacuous.',
    );
    process.exit(2);
  }

  // CI-Velocity-2 — a static-governance fixture with the job present + gating but ONE
  // folded wall step dropped MUST be flagged; and a job absent from needs MUST be flagged.
  const sgFixture: GateModel = {
    jobIds: [STATIC_GOVERNANCE_JOB, 'deployment-gate'],
    needs: [STATIC_GOVERNANCE_JOB],
    staticGovernanceSteps: REQUIRED_STATIC_GOVERNANCE_STEPS.filter((s) => s !== 'repo-map:check'),
  };
  const sgv = validateStaticGovernance(sgFixture);
  const caughtStep = sgv.some(
    (x) => x.reason === 'step-missing' && x.detail.includes('repo-map:check'),
  );
  if (!caughtStep) {
    console.error(
      'SELFTEST FAILED: verify-aggregate-gate did not detect a folded wall dropped from static-governance — the checker is vacuous.',
    );
    process.exit(2);
  }
  const notGating: GateModel = {
    jobIds: [STATIC_GOVERNANCE_JOB, 'deployment-gate'],
    needs: [],
    staticGovernanceSteps: [...REQUIRED_STATIC_GOVERNANCE_STEPS],
  };
  if (!validateStaticGovernance(notGating).some((x) => x.reason === 'job-not-in-needs')) {
    console.error(
      'SELFTEST FAILED: verify-aggregate-gate did not detect static-governance absent from deployment-gate.needs.',
    );
    process.exit(2);
  }
}

function main(): void {
  selftest();
  const text = readFileSync(CI_YAML, 'utf8');
  const model = parseGateModel(text);
  const violations = validateAggregateGate(model);
  const sgViolations = validateStaticGovernance(model);
  if (violations.length > 0 || sgViolations.length > 0) {
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
        'GLH-1: build, verify-vocabulary, and the GLH-1 gate walls must be members of deployment-gate.needs.',
      );
    }
    if (sgViolations.length > 0) {
      console.error('✗ static-governance consolidation violations:');
      for (const v of sgViolations) console.error(`  - ${v.detail}`);
      console.error(
        'CI-Velocity-2: the consolidated static-governance job must gate merges and carry every folded wall as a named step.',
      );
    }
    process.exit(1);
  }
  console.log(
    `✓ aggregate-gate: all ${REQUIRED_AGGREGATE_MEMBERS.length} GLH-required members present in deployment-gate.needs (${model.needs.length} total needs); ` +
      `static-governance gates + carries all ${REQUIRED_STATIC_GOVERNANCE_STEPS.length} folded walls as named steps.`,
  );
}

main();
