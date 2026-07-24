import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// PUB-5 §1.2 — SELF-TESTING NEGATIVE CONTROL for the Public⊥ATS import wall on
// the public-intake app. Mirrors the audited apps/public-web control: it does
// not just assert the tree is clean — it PROVES the boundary rule FIRES on a
// breach.
//
// The committed fixture (../public-negative-control/intake-imports-ats.fixture.ts)
// is a scope:public file importing a scope:ats lib (`engagement`). We lint it
// with `eslint --no-ignore` and assert @nx/enforce-module-boundaries rejects it
// — a PUBLIC→ATS import is CI-red. The rule SKIPS silently without a cached
// project graph, so this spec WARMS it first (`nx show projects`).

const ROOT = resolve(__dirname, '../../../..');
const REL =
  'apps/public-intake/src/public-negative-control/intake-imports-ats.fixture.ts';
const ABS = resolve(ROOT, REL);

describe('Public⊥ATS wall — public-intake negative control', () => {
  it('the committed synthetic-breach fixture exists', () => {
    expect(existsSync(ABS)).toBe(true);
  });

  it('eslint REJECTS the scope:public → scope:ats import (@nx/enforce-module-boundaries fires)', () => {
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

    expect(res.stderr).not.toMatch(/No cached ProjectGraph is available/);
    expect(
      res.status,
      `expected eslint to FAIL on the PUBLIC→ATS fixture.\nstatus=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).not.toBe(0);

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
    expect(boundaryMsgs.some((m) => /scope:public/.test(m.message))).toBe(true);
  }, 300_000);
});
