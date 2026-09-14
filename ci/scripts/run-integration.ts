// Registry-driven serial integration runner (PR-B, Dev Execution Model v1.4 §12).
//
//   node --import jiti/register ci/scripts/run-integration.ts
//
// The SINGLE serial executor for the integration lane, consumed by both
// ci-integration.sh (CI) and package.json `tests:integration` (local full run).
// Roots come only from the canonical registry ci/integration-roots.json — no
// embedded --root chain anywhere.
//
// Modes (env):
//   CI_AFFECTED=1  → run only roots whose Nx project is affected vs NX_BASE..NX_HEAD
//                    (PR lane; needs NX_BASE + NX_HEAD, set by nrwl/nx-set-shas).
//   otherwise      → run ALL roots (merge_group / push / schedule / local full).
//
// Every root — including apps/api — runs directly via the canonical command
//   ARAMO_RUN_INTEGRATION=1 vitest run --no-file-parallelism --root <root>
// Serial + --no-file-parallelism is the harness-hardening invariant (one Postgres
// container at a time); it is NOT routed through Nx.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getRoots, REPO_ROOT } from './integration-roots';

function projectName(root: string): string {
  const pj = resolve(REPO_ROOT, root, 'project.json');
  if (existsSync(pj)) {
    try {
      return (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name ?? root;
    } catch {
      /* fall through */
    }
  }
  return root;
}

const allRoots = getRoots();
if (allRoots.length === 0) {
  console.error('::error::ci/integration-roots.json produced no roots — registry unreadable or empty.');
  process.exit(1);
}

let roots = allRoots;
if (process.env.CI_AFFECTED === '1') {
  const base = process.env.NX_BASE;
  const head = process.env.NX_HEAD;
  if (!base || !head) {
    console.error('::error::CI_AFFECTED=1 requires NX_BASE and NX_HEAD.');
    process.exit(1);
  }
  const affected = new Set<string>(
    JSON.parse(
      execSync(`npx nx show projects --affected --base=${base} --head=${head} --json`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim() || '[]',
    ) as string[],
  );
  roots = allRoots.filter((r) => affected.has(projectName(r)));
  console.log(`::notice::PR lane — affected integration roots: ${roots.join(', ') || '(none)'}`);
} else {
  console.log(`::notice::Full lane — all ${roots.length} integration roots (serial)`);
}

if (roots.length === 0) {
  console.log('No affected integration roots — nothing to run.');
  process.exit(0);
}

const failures: string[] = [];
for (const r of roots) {
  console.log(`\n▶ integration: ${r}`);
  try {
    execSync(`ARAMO_RUN_INTEGRATION=1 npx vitest run --no-file-parallelism --root ${r}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
  } catch {
    failures.push(r);
    console.error(`✗ integration:${r} FAILED`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAILED integration root(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\n✓ all integration roots green.');
