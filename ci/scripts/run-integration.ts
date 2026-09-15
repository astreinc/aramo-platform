// Registry-driven serial integration runner (PR-B, Dev Execution Model v1.4 §12).
//
//   node --import jiti/register ci/scripts/run-integration.ts
//
// The SINGLE serial executor for the integration lane, consumed by both
// ci-integration.sh (CI) and package.json `tests:integration` (local full run).
// Roots come only from the canonical registry ci/integration-roots.json — no
// embedded --root chain anywhere.
//
// Modes (env), evaluated in this precedence:
//   CI_ROOT=<root>    → run EXACTLY that one registry root (one CI matrix leg;
//                       does NOT require NX_BASE/HEAD — discovery already selected it).
//   CI_EMIT_MATRIX=1  → do not run anything; PRINT the selected root set as a GitHub
//                       Actions job output (`matrix`=JSON array of {root,project},
//                       `has_roots`=true|false) for a dynamic integration matrix.
//                       Honours CI_AFFECTED exactly like the serial runner below.
//   CI_AFFECTED=1     → run only roots whose Nx project is affected vs NX_BASE..NX_HEAD
//                       (local/legacy serial PR lane; needs NX_BASE + NX_HEAD).
//   otherwise         → run ALL roots (merge_group / push / schedule / local full).
//
// Every root — including apps/api — runs directly via the canonical command
//   ARAMO_RUN_INTEGRATION=1 vitest run --no-file-parallelism --root <root>
// Serial + --no-file-parallelism is the harness-hardening invariant (one Postgres
// container at a time) — preserved WITHIN each runner in every mode: the serial
// runner runs one root at a time on one box; each CI_ROOT matrix leg is its own
// box with its own single Postgres. Root SELECTION is registry-driven in all modes
// (one source: ci/integration-roots.json); it is NOT routed through Nx execution.
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
  console.error(
    '::error::ci/integration-roots.json produced no roots — registry unreadable or empty.',
  );
  process.exit(1);
}

/** Registry roots selected for this lane (all, or only the affected ones on a PR). */
function selectRoots(): string[] {
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
    return allRoots.filter((r) => affected.has(projectName(r)));
  }
  return allRoots;
}

// ── Mode 1: single-root matrix leg (CI_ROOT) ─────────────────────────────────
// One CI runner runs exactly one registry root. Validated against the canonical
// registry so a stale/hand-typed leg can never run an unregistered path.
const singleRoot = process.env.CI_ROOT;
if (singleRoot) {
  if (!allRoots.includes(singleRoot)) {
    console.error(
      `::error::CI_ROOT="${singleRoot}" is not a registry root in ci/integration-roots.json.`,
    );
    process.exit(1);
  }
  runRoots([singleRoot]);
}

// ── Mode 2: emit the dynamic matrix (CI_EMIT_MATRIX) ─────────────────────────
// No execution — just publish the selected roots so the matrix job can fan out.
if (process.env.CI_EMIT_MATRIX === '1') {
  const selected = selectRoots();
  const entries = selected.map((r) => ({ root: r, project: projectName(r) }));
  const matrix = JSON.stringify({ include: entries });
  const hasRoots = entries.length > 0 ? 'true' : 'false';
  console.log(
    `::notice::integration discovery — ${
      process.env.CI_AFFECTED === '1' ? 'affected' : 'full'
    } lane selected root(s): ${selected.join(', ') || '(none)'}`,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `matrix=${matrix}\nhas_roots=${hasRoots}\n`);
  } else {
    // Local invocation (no Actions runner): print for inspection.
    console.log(`matrix=${matrix}`);
    console.log(`has_roots=${hasRoots}`);
  }
  process.exit(0);
}

// ── Mode 3: serial run of the selected root set (default / merge_group / local) ─
const roots = selectRoots();
console.log(
  process.env.CI_AFFECTED === '1'
    ? `::notice::PR lane — affected integration roots: ${roots.join(', ') || '(none)'}`
    : `::notice::Full lane — all ${roots.length} integration roots (serial)`,
);

if (roots.length === 0) {
  console.log('No affected integration roots — nothing to run.');
  process.exit(0);
}
runRoots(roots);

// ── Shared serial executor ───────────────────────────────────────────────────
// Hoisted declaration — safe to call from the mode branches above. Always exits
// the process (never returns), so the mode branches read as terminal.
function runRoots(rootsToRun: string[]): never {
  const failures: string[] = [];
  for (const r of rootsToRun) {
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
  process.exit(0);
}
