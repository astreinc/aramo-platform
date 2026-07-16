import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CI-Velocity PR-1 (Aramo-CI-Velocity-Directive-v1_0-LOCKED §PR-1) — the COMPUTED
// prepush. The diff→verification mapping is computed from Nx's dependency graph +
// path rules, NOT remembered. It supersedes-in-mechanism the six interim run-set
// rules (full ARAMO_RUN_INTEGRATION per touched root; catalog-addition ⇒ owning
// unit suite; eslint+vocab per touched file; co-located specs; openapi:lint on
// yaml touch) — they are now performed unconditionally or via `nx affected`.
//
// Contract: print the computed plan FIRST (auditable — Gate-6 cites it), then run
// (a) nx affected build/test/lint, (b) affected integration roots (serial —
// harness hardening kills the Docker-saturation flake), (c) the unconditional
// cheap walls, (d) path-computed openapi + pact + caddy walls. Non-zero exit on
// any failure. Walls are NEVER affected-scoped (Charter invariant).

const BASE = 'origin/main';
const ROOT = resolve(__dirname, '..', '..');

// The integration roots (ARAMO_RUN_INTEGRATION=1). Each is run iff its Nx project
// is in the affected set (a dep change propagates through the graph).
const INTEGRATION_ROOTS = [
  'libs/consent',
  'libs/examination',
  'libs/job-domain',
  'libs/matching',
  'libs/talent-evidence',
  'apps/api',
  'libs/evidence',
  'libs/submittal',
  'libs/engagement',
  'libs/ai-draft',
  'libs/canonicalization',
  'libs/identity-index',
  'libs/portal-identity',
];

function run(cmd: string): void {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}
function capture(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
function projectName(root: string): string {
  const pj = resolve(ROOT, root, 'project.json');
  if (existsSync(pj)) {
    try {
      return (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name ?? root;
    } catch {
      /* fall through */
    }
  }
  return root;
}

// ── Compute ──────────────────────────────────────────────────────────────────
capture('git fetch origin main --quiet'); // best-effort; offline still works vs the cached ref
const mergeBase = capture(`git merge-base ${BASE} HEAD`) || BASE;
const touched = new Set(
  [
    ...capture(`git diff --name-only ${mergeBase}...HEAD`).split('\n'),
    ...capture('git diff --name-only').split('\n'),
    ...capture('git diff --name-only --cached').split('\n'),
    ...capture('git ls-files --others --exclude-standard').split('\n'),
  ].filter(Boolean),
);
const affected = new Set<string>(
  JSON.parse(capture(`npx nx show projects --affected --base=${BASE} --json`) || '[]'),
);
const anyTouched = (re: RegExp): boolean => [...touched].some((f) => re.test(f));

const openapiTouched = anyTouched(/^openapi\/.*\.ya?ml$/);
// The pact provider (aramo-core = the `api` project) replays against the app;
// any change nx propagates to `api` — or a direct pact/ edit — can break a
// contract. This is the path-computed provider-state-feeding rule.
const pactFires = anyTouched(/^pact\//) || affected.has('api');
const caddyTouched = anyTouched(/^deploy\/caddy\//);

const integrationRoots = INTEGRATION_ROOTS.filter((r) => affected.has(projectName(r)));
const touchedLintable = [...touched].filter(
  (f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f) && existsSync(resolve(ROOT, f)),
);

// ── Print the plan (the audit list Gate-6 cites) ─────────────────────────────
console.log('\n══════════ prepush computed plan ══════════');
console.log(`base=${BASE}  merge-base=${mergeBase.slice(0, 12)}  touched=${touched.size} file(s)`);
console.log(`affected projects: ${[...affected].sort().join(', ') || '(none)'}`);
console.log('▸ nx affected -t build,test,lint');
console.log(
  `▸ integration (serial, --no-file-parallelism): ${integrationRoots.join(', ') || '(none affected)'}`,
);
console.log(
  '▸ unconditional walls: vocabulary, error-codes, identity-index privacy-wall, portal/ats/ingestion refusal, version:sync-check' +
    (touchedLintable.length ? `, eslint(${touchedLintable.length} touched)` : ''),
);
console.log(
  `▸ openapi walls: ${openapiTouched ? 'validate+lint+drift (openapi/*.yaml touched)' : 'skipped (no openapi change)'}`,
);
console.log(
  `▸ pact walls: ${pactFires ? 'consumer+provider (pact/ touched or api affected)' : 'skipped (no pact/api change)'}`,
);
console.log(`▸ caddy check: ${caddyTouched ? 'deploy/caddy touched — validate' : 'skipped'}`);
console.log('═══════════════════════════════════════════\n');

// ── Build the step list ──────────────────────────────────────────────────────
const steps: Array<[string, () => void]> = [];
steps.push([
  'nx affected build/test/lint',
  () => run(`npx nx affected -t build test lint --base=${BASE}`),
]);
for (const r of integrationRoots) {
  steps.push([
    `integration:${r}`,
    () => run(`ARAMO_RUN_INTEGRATION=1 npx vitest run --root ${r} --no-file-parallelism`),
  ]);
}
// Unconditional cheap walls (seconds; never affected-scoped).
steps.push(['verify:vocabulary', () => run('npm run --silent verify:vocabulary')]);
steps.push(['error-codes:check', () => run('npm run --silent error-codes:check')]);
steps.push([
  'identity-index:privacy-wall',
  () => run('npm run --silent identity-index:privacy-wall'),
]);
steps.push(['portal:refusal-check', () => run('npm run --silent portal:refusal-check')]);
steps.push(['ats:refusal-check', () => run('npm run --silent ats:refusal-check')]);
steps.push(['ingestion:refusal-check', () => run('npm run --silent ingestion:refusal-check')]);
steps.push(['version:sync-check', () => run('npm run --silent version:sync-check')]);
if (touchedLintable.length > 0) {
  steps.push([
    'eslint(touched)',
    () => run(`npx eslint ${touchedLintable.map((f) => JSON.stringify(f)).join(' ')}`),
  ]);
}
// Path-computed walls.
if (openapiTouched) {
  steps.push(['openapi:validate', () => run('npm run --silent openapi:validate')]);
  steps.push(['openapi:lint', () => run('npm run --silent openapi:lint')]);
  steps.push(['openapi:drift-check', () => run('npm run --silent openapi:drift-check')]);
}
if (pactFires) {
  steps.push(['pact:consumer', () => run('npm run --silent pact:consumer')]);
  steps.push(['pact:provider', () => run('npm run --silent pact:provider')]);
}
if (caddyTouched) {
  // deploy/caddy is a runtime artifact — no nx project consumes it, so `affected`
  // cannot mis-map it. Its authoritative gate is CI docker-build(caddy); locally
  // we `caddy validate` when the binary is present, else print the pointer.
  steps.push([
    'caddy:validate',
    () => {
      const hasCaddy = capture('command -v caddy') !== '';
      if (hasCaddy) run('caddy validate --config deploy/caddy/Caddyfile --adapter caddyfile');
      else
        console.log(
          '  (caddy CLI absent — deploy/caddy is gated by CI docker-build(caddy); `docker build -f deploy/caddy/Dockerfile deploy/caddy` to check locally)',
        );
    },
  ]);
}

// ── Run (fail-slow: collect every failure so one push shows all of them) ──────
const failures: string[] = [];
for (const [name, fn] of steps) {
  console.log(`\n▶ ${name}`);
  try {
    fn();
  } catch {
    failures.push(name);
    console.error(`✗ ${name} FAILED`);
  }
}

console.log('\n══════════ prepush summary ══════════');
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL GREEN — safe to push.');
