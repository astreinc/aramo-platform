import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Portal P1 PR-3 §PR-3.1 — SELF-TESTING NEGATIVE CONTROL for the Portal⊥ATS
// import wall (apps/portal-web, scope:portal). Mirrors the platform-web control
// + the I15 CIP⊥ATS control: it does not just assert the current tree is clean —
// it PROVES the enforcement mechanism FIRES on a breach.
//
// The committed fixture (../portal-negative-control/portal-imports-ats.fixture.ts)
// is a scope:portal file (this app) importing a scope:ats lib (`engagement`). We
// lint it with `eslint --no-ignore` and assert @nx/enforce-module-boundaries
// rejects it — a PORTAL→ATS import is CI-red.
//
// The rule SKIPS silently without a cached project graph; this spec WARMS it
// (`nx show projects`) before invoking eslint, and guards against that
// silent-skip failure mode. If the wall is ever weakened so the import passes,
// THIS spec goes red.

const ROOT = resolve(__dirname, '../../../..');
const REL =
  'apps/portal-web/src/portal-negative-control/portal-imports-ats.fixture.ts';
const ABS = resolve(ROOT, REL);

describe('Portal⊥ATS wall (portal-web FE) — negative control', () => {
  it('the committed synthetic-breach fixture exists', () => {
    expect(existsSync(ABS)).toBe(true);
  });

  it('eslint REJECTS the scope:portal → scope:ats import (@nx/enforce-module-boundaries fires)', () => {
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
      `expected eslint to FAIL on the PORTAL→ATS fixture.\nstatus=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
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
    expect(boundaryMsgs.some((m) => /scope:portal/.test(m.message))).toBe(true);
  }, 300_000);
});
