import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

// ATI-SEP-1 A7 (ADR-0036 Decision 1) — SELF-TESTING NEGATIVE CONTROLS for the
// ATS / Talent Intelligence wall. Modeled on libs/matching/src/tests/i15-negative-control.spec.ts:
// committed breach fixtures live in dedicated probe projects
// (tools/intelligence-boundary-probes/*, tagged scope:ats / scope:cip /
// scope:intelligence) so no real library gains a cross-wall graph edge. We lint
// them with `eslint --no-ignore` and assert @nx/enforce-module-boundaries fires.
//
// A fifth case lints an in-memory file (--stdin-filename) placed in the UNTAGGED
// apps/api composition root, proving the apps/** override also walls it.
//
// The boundary rule SKIPS silently without a cached project graph, so the graph
// is warmed first (`nx show projects`), exactly as the I15 control does.

const ROOT = resolve(__dirname, '../../../..');
const PROBES = 'tools/intelligence-boundary-probes';

const CASES = [
  { name: 'scope:ats → scope:intelligence', rel: `${PROBES}/ats-probe/intelligence-negative-control/ats-imports-intelligence.fixture.ts`, tag: /scope:ats/ },
  { name: 'scope:cip → scope:intelligence', rel: `${PROBES}/cip-probe/intelligence-negative-control/cip-imports-intelligence.fixture.ts`, tag: /scope:cip/ },
  { name: 'scope:intelligence → scope:ats', rel: `${PROBES}/intelligence-probe/intelligence-negative-control/intelligence-imports-ats.fixture.ts`, tag: /scope:intelligence/ },
  { name: 'scope:intelligence → scope:cip', rel: `${PROBES}/intelligence-probe/intelligence-negative-control/intelligence-imports-cip.fixture.ts`, tag: /scope:intelligence/ },
] as const;

type EslintResult = { filePath: string; messages: Array<{ ruleId: string | null; message: string }> };

const ENV = { ...process.env, NX_DAEMON: 'false' };

function boundaryMessages(results: EslintResult[], rel: string): string[] {
  const hit = results.find((r) => r.filePath === resolve(ROOT, rel) || r.filePath.endsWith(rel));
  return (hit?.messages ?? []).filter((m) => m.ruleId === '@nx/enforce-module-boundaries').map((m) => m.message);
}

describe('ATI-SEP-1 A7 — ATS / Talent Intelligence wall negative controls', () => {
  let results: EslintResult[] = [];
  let status: number | null = null;
  let stderr = '';

  beforeAll(() => {
    const warm = spawnSync('npx', ['nx', 'show', 'projects'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: ENV });
    expect(warm.status, `failed to warm the nx project graph.\n${warm.stdout}\n${warm.stderr}`).toBe(0);
    const res = spawnSync('npx', ['eslint', '--no-ignore', '--format', 'json', ...CASES.map((c) => c.rel)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: ENV,
    });
    status = res.status;
    stderr = res.stderr;
    results = JSON.parse(res.stdout) as EslintResult[];
  }, 600_000);

  it('the committed synthetic-breach fixtures exist', () => {
    for (const c of CASES) expect(existsSync(resolve(ROOT, c.rel)), c.rel).toBe(true);
  });

  it('eslint fails (non-silent) on the fixtures', () => {
    expect(stderr).not.toMatch(/No cached ProjectGraph is available/);
    expect(status).not.toBe(0);
  });

  for (const c of CASES) {
    it(`REJECTS ${c.name}`, () => {
      const msgs = boundaryMessages(results, c.rel);
      expect(msgs.length, `no boundary error for ${c.rel}: ${JSON.stringify(results, null, 2)}`).toBeGreaterThan(0);
      expect(msgs.some((m) => c.tag.test(m))).toBe(true);
    });
  }

  it('REJECTS an untagged apps/api file importing scope:intelligence (apps/** override)', () => {
    const res = spawnSync(
      'npx',
      ['eslint', '--format', 'json', '--stdin', '--stdin-filename', 'apps/api/src/intelligence-wall-probe.ts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300_000,
        env: ENV,
        input: "import { IntelligenceCoreModule } from '@aramo/intelligence-core';\n\nexport const PROBE = IntelligenceCoreModule;\n",
      },
    );
    expect(res.stderr).not.toMatch(/No cached ProjectGraph is available/);
    const msgs = (JSON.parse(res.stdout) as EslintResult[])
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === '@nx/enforce-module-boundaries')
      .map((m) => m.message);
    expect(msgs.length, res.stdout).toBeGreaterThan(0);
    expect(msgs.some((m) => /scope:intelligence/.test(m))).toBe(true);
  }, 300_000);

  it('ALLOWS an untagged apps/api file importing the shared contract (HTTP seam)', () => {
    const res = spawnSync(
      'npx',
      ['eslint', '--format', 'json', '--stdin', '--stdin-filename', 'apps/api/src/intelligence-wall-probe.ts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 300_000,
        env: ENV,
        input: "import { TALENT_CREATED } from '@aramo/intelligence-contracts';\n\nexport const PROBE = TALENT_CREATED;\n",
      },
    );
    const msgs = (JSON.parse(res.stdout) as EslintResult[])
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === '@nx/enforce-module-boundaries');
    expect(msgs, res.stdout).toEqual([]);
  }, 300_000);
});
