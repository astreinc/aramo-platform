import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Platform-Console Inc-2 PR-2 §3 — SELF-TESTING NEGATIVE CONTROL for the
// Platform⊥ATS import wall, now protecting FE code (apps/platform-web,
// scope:platform). Mirrors the platform-admin control + the I15 CIP⊥ATS control:
// it does not just assert the current tree is clean — it PROVES the enforcement
// mechanism FIRES on a breach.
//
// The committed fixture (../platform-negative-control/platform-imports-ats.fixture.ts)
// is a scope:platform file (this app) importing a scope:ats lib (`engagement`).
// We lint it with `eslint --no-ignore` and assert @nx/enforce-module-boundaries
// rejects it — a PLATFORM→ATS import is CI-red.
//
// The rule SKIPS silently without a cached project graph; this spec WARMS it
// (`nx show projects`) before invoking eslint, and guards against that
// silent-skip failure mode. If the wall is ever weakened so the import passes,
// THIS spec goes red.

const ROOT = resolve(__dirname, '../../../..');
const REL =
  'apps/platform-web/src/platform-negative-control/platform-imports-ats.fixture.ts';
const ABS = resolve(ROOT, REL);

describe('Platform⊥ATS wall (platform-web FE) — negative control', () => {
  it('the committed synthetic-breach fixture exists', () => {
    expect(existsSync(ABS)).toBe(true);
  });

  it('eslint REJECTS the scope:platform → scope:ats import (@nx/enforce-module-boundaries fires)', () => {
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
      `expected eslint to FAIL on the PLATFORM→ATS fixture.\nstatus=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
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
    expect(boundaryMsgs.some((m) => /scope:platform/.test(m.message))).toBe(
      true,
    );
  }, 300_000);
});
