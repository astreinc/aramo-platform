import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// PUB-1 PR-1a (§2.2, Amendment v1.1 G0-R1) — SELF-TESTING NEGATIVE CONTROL for
// the Public⊥ATS import wall. Mirrors the platform (PLATFORM⊥ATS) and I15
// (CIP⊥ATS) controls: it does not just assert the current tree is clean — it
// PROVES the enforcement mechanism actually FIRES on a breach.
//
// The committed fixture (../public-negative-control/public-imports-ats.fixture.ts)
// is a scope:public file (this app, `public-web`) importing a scope:ats lib
// (`engagement`). We lint it with `eslint --no-ignore` and assert
// @nx/enforce-module-boundaries rejects it — a PUBLIC→ATS import is CI-red.
//
// Isolation (so it never reds a real target):
//   - eslint.config.mjs `ignores` ('**/public-negative-control/**') keeps it
//     out of the real lint:nx-boundaries gate.
//   - apps/public-web/tsconfig.json `exclude` keeps it out of the build. It
//     stays committed, so it is in the nx project graph.
//
// The @nx/enforce-module-boundaries rule SKIPS silently when no cached project
// graph is available. This spec WARMS it first (`nx show projects`) before
// invoking eslint. Without that, the rule would no-op and the wall would appear
// (falsely) to pass.
//
// If the wall is ever removed or weakened so the import passes, THIS spec goes
// red — the negative control and the wall fail together, by design.

const ROOT = resolve(__dirname, '../../../..');
const REL =
  'apps/public-web/src/public-negative-control/public-imports-ats.fixture.ts';
const ABS = resolve(ROOT, REL);

describe('Public⊥ATS wall — negative control', () => {
  it('the committed synthetic-breach fixture exists', () => {
    expect(existsSync(ABS)).toBe(true);
  });

  it('eslint REJECTS the scope:public → scope:ats import (@nx/enforce-module-boundaries fires)', () => {
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
      `expected eslint to FAIL on the PUBLIC→ATS fixture.\nstatus=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
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
    // The scope:public depConstraint is the one that must reject the ats edge.
    expect(boundaryMsgs.some((m) => /scope:public/.test(m.message))).toBe(true);
  }, 300_000);
});
