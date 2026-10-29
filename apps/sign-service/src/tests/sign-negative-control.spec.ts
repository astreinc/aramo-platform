import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §3 H-1 — SELF-TESTING
// NEGATIVE CONTROL for the Sign⊥ATS import wall, mirroring the platform and I15 controls:
// it PROVES the enforcement mechanism fires on a breach, not just that the tree is clean.
//
// The committed fixture (../sign-negative-control/sign-imports-ats.fixture.ts) is a
// scope:sign file (this app, `sign-service`) importing a scope:ats lib (`pipeline`). We lint
// it with `eslint --no-ignore` and assert @nx/enforce-module-boundaries rejects it.
// Isolation: eslint.config.mjs `ignores` ('**/sign-negative-control/**') and
// apps/sign-service/tsconfig.app.json `exclude`. The boundary rule SKIPS silently without a
// cached project graph, so this spec warms it first (`nx show projects`).

const ROOT = resolve(__dirname, '../../../..');
const REL =
  'apps/sign-service/src/sign-negative-control/sign-imports-ats.fixture.ts';
const ABS = resolve(ROOT, REL);

describe('Sign⊥ATS wall — negative control', () => {
  it('the committed synthetic-breach fixture exists', () => {
    expect(existsSync(ABS)).toBe(true);
  });

  it('eslint REJECTS the scope:sign → scope:ats import (@nx/enforce-module-boundaries fires)', () => {
    // Warm the nx project graph so the boundary rule has it available (it
    // no-ops without a cached graph). NX_DAEMON=false keeps graph resolution
    // file-based and deterministic across the two subprocesses.
    const env = { ...process.env, NX_DAEMON: 'false' };
    const warm = spawnSync('npx', ['nx', 'show', 'projects'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env,
    });
    expect(
      warm.status,
      `failed to warm the nx project graph.\nstdout:\n${warm.stdout}\nstderr:\n${warm.stderr}`,
    ).toBe(0);

    const res = spawnSync(
      'npx',
      ['eslint', '--no-ignore', '--format', 'json', REL],
      { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env },
    );

    // Guard against the silent-skip failure mode: if the rule no-ops, eslint
    // exits 0 with no boundary message — that is a BROKEN negative control, and
    // this assertion surfaces it (rather than a false green).
    expect(res.stderr).not.toMatch(/No cached ProjectGraph is available/);

    // Non-zero exit = lint failed = the wall fired on the breach.
    expect(
      res.status,
      `expected eslint to FAIL on the SIGN→ATS fixture.\nstatus=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).not.toBe(0);

    // Prove the failure is SPECIFICALLY the module-boundary wall. A crash would
    // make stdout non-JSON → parse throws → this test fails loudly (honest).
    const results = JSON.parse(res.stdout) as Array<{
      messages: Array<{ ruleId: string | null; message: string }>;
    }>;
    const boundaryMsgs = results
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === '@nx/enforce-module-boundaries');

    expect(
      boundaryMsgs.length,
      `no @nx/enforce-module-boundaries error reported. messages:\n${JSON.stringify(results, null, 2)}`,
    ).toBeGreaterThan(0);
    // The scope:sign depConstraint is the one that must reject the ats edge.
    expect(boundaryMsgs.some((m) => /scope:sign/.test(m.message))).toBe(
      true,
    );
  }, 300_000);
});
