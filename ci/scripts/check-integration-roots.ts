// DEFAULT-DENY integration-root coverage guard (PR-B, Dev Execution Model v1.4 §12).
//
//   node --import jiti/register ci/scripts/check-integration-roots.ts
//
// Proves that ci/integration-roots.json (the canonical registry) covers EVERY
// integration-bearing Nx project, that every runner derives from it, and that no
// stale/divergent root definition survives anywhere. Exits non-zero with bounded
// diagnostics naming the exact project, file, registry problem, and stale source.
//
// This guard NEVER trusts a frozen count — the truth is derived from the file
// system on every run.
//
// Detection jurisdiction (Ruling 5): an integration spec is any *.spec.ts /
// *.test.ts that EITHER carries the `.integration.` suffix OR gates execution on
// ARAMO_RUN_INTEGRATION via a real skipIf/runIf. Every discovered spec is mapped
// to its owning Nx project by walking up to the nearest project.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { readRegistry, REPO_ROOT } from './integration-roots';

// ── FS discovery ─────────────────────────────────────────────────────────────
const SCAN_DIRS = ['apps', 'libs'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.nx',
  'coverage',
  'tmp',
  'build',
  '.vite',
  '.angular',
  'generated',
]);
const SPEC_RE = /\.(spec|test)\.ts$/;
const INTEGRATION_SUFFIX_RE = /\.integration\.(spec|test)\.ts$/;
// A real execution gate, not a prose mention: (describe|it|test).skipIf/runIf(… ARAMO_RUN_INTEGRATION …)
const GATE_RE = /(?:describe|it|test)\.(?:skipIf|runIf)\([^)]*ARAMO_RUN_INTEGRATION/;

function walk(absDir: string, out: string[]): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(resolve(absDir, entry.name), out);
    } else if (entry.isFile() && SPEC_RE.test(entry.name)) {
      out.push(resolve(absDir, entry.name));
    }
  }
}

function isIntegrationSpec(abs: string): boolean {
  if (INTEGRATION_SUFFIX_RE.test(abs)) return true;
  // Only read content for non-suffixed spec files (bounded IO).
  return GATE_RE.test(readFileSync(abs, 'utf8'));
}

/** Nearest-ancestor project.json → { rootPath (repo-relative), name }, or null. */
function owningProject(abs: string): { rootPath: string; name: string } | null {
  let dir = dirname(abs);
  while (dir.startsWith(REPO_ROOT)) {
    const pj = resolve(dir, 'project.json');
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name;
        if (name) return { rootPath: relative(REPO_ROOT, dir), name };
      } catch {
        /* unreadable project.json — treated as unresolved below */
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const rel = (abs: string): string => relative(REPO_ROOT, abs);

// ── Build the grounded bearing set ───────────────────────────────────────────
const errors: string[] = [];
const specFiles: string[] = [];
for (const d of SCAN_DIRS) {
  const abs = resolve(REPO_ROOT, d);
  if (existsSync(abs)) walk(abs, specFiles);
}
specFiles.sort();

/** rootPath → { name, specs: relative paths } for every integration-bearing project. */
const bearing = new Map<string, { name: string; specs: string[] }>();
/** every discovered integration spec (relative path) → its resolution. */
const specOwner = new Map<string, { rootPath: string; name: string } | null>();

for (const abs of specFiles) {
  if (!isIntegrationSpec(abs)) continue;
  const owner = owningProject(abs);
  specOwner.set(rel(abs), owner);
  if (!owner) {
    // Rule 6 — a discovered integration spec that cannot be mapped to an Nx project.
    errors.push(
      `UNRESOLVED OWNER: integration spec ${rel(abs)} does not resolve to any Nx project ` +
        `(no ancestor project.json with a name). Add project configuration or remove the spec.`,
    );
    continue;
  }
  const cur = bearing.get(owner.rootPath) ?? { name: owner.name, specs: [] };
  cur.specs.push(rel(abs));
  bearing.set(owner.rootPath, cur);
}

// ── Load registry ────────────────────────────────────────────────────────────
const registry = readRegistry();
const roots = registry.roots;
const aliases = registry.coverageAliases;
const exemptions = registry.exemptions;
const rootSet = new Set(roots);
const aliasProjects = new Set(aliases.map((a) => a.project));
const exemptProjects = new Set(exemptions.map((e) => e.project));

function nxProjectName(rootPath: string): string | null {
  const pj = resolve(REPO_ROOT, rootPath, 'project.json');
  if (!existsSync(pj)) return null;
  try {
    return (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

// ── Ordering + shape (deterministic registry) ───────────────────────────────
const sortedRoots = [...roots].sort();
if (JSON.stringify(roots) !== JSON.stringify(sortedRoots)) {
  errors.push(
    `NONDETERMINISTIC ORDER: ci/integration-roots.json "roots" must be sorted ascending. ` +
      `Expected order:\n  ${sortedRoots.join('\n  ')}`,
  );
}
const dupRoots = roots.filter((r, i) => roots.indexOf(r) !== i);
if (dupRoots.length > 0) {
  errors.push(`DUPLICATE ROOT(S): ${[...new Set(dupRoots)].join(', ')} appear(s) more than once in roots.`);
}
const sortedAliases = [...aliases].map((a) => a.project).sort();
if (JSON.stringify(aliases.map((a) => a.project)) !== JSON.stringify(sortedAliases)) {
  errors.push(`NONDETERMINISTIC ORDER: coverageAliases must be sorted ascending by project.`);
}
const sortedExempt = [...exemptions].map((e) => e.project).sort();
if (JSON.stringify(exemptions.map((e) => e.project)) !== JSON.stringify(sortedExempt)) {
  errors.push(`NONDETERMINISTIC ORDER: exemptions must be sorted ascending by project.`);
}

// A project must be exactly ONE of: root, coverageAlias, exemption.
for (const r of roots) {
  if (aliasProjects.has(r)) errors.push(`OVERLAP: ${r} is both a root and a coverageAlias.`);
  if (exemptProjects.has(r)) errors.push(`OVERLAP: ${r} is both a root and an exemption.`);
}
for (const a of aliasProjects) {
  if (exemptProjects.has(a)) errors.push(`OVERLAP: ${a} is both a coverageAlias and an exemption.`);
}

// ── Rule 2 — every root resolves to a real Nx project AND has executable coverage ─
for (const r of roots) {
  if (!nxProjectName(r)) {
    errors.push(`UNRESOLVED ROOT: registry root "${r}" has no Nx project (missing/invalid ${r}/project.json).`);
    continue;
  }
  if (!bearing.has(r)) {
    errors.push(
      `EMPTY ROOT: registry root "${r}" contains no executable integration spec. ` +
        `Remove it from roots, or add its integration coverage. ` +
        `(If its proof is hosted by another project, use a coverageAlias instead.)`,
    );
  }
}

// ── Rule 3 — coverageAliases ─────────────────────────────────────────────────
for (const a of aliases) {
  const where = `coverageAlias(${a.project})`;
  if (!nxProjectName(a.project)) {
    errors.push(`${where}: project has no Nx project (missing/invalid ${a.project}/project.json).`);
  }
  const ownSpecs = bearing.get(a.project);
  if (ownSpecs) {
    errors.push(
      `${where}: project owns its OWN integration spec(s) [${ownSpecs.specs.join(', ')}] — ` +
        `it must be a root, not a coverage alias.`,
    );
  }
  if (!rootSet.has(a.coveredBy)) {
    errors.push(`${where}: coveredBy="${a.coveredBy}" is not an executable root.`);
  }
  if (!a.proof || !existsSync(resolve(REPO_ROOT, a.proof))) {
    errors.push(`${where}: proof path "${a.proof}" does not exist.`);
  } else {
    const proofOwner = owningProject(resolve(REPO_ROOT, a.proof));
    if (!proofOwner || proofOwner.rootPath !== a.coveredBy) {
      errors.push(
        `${where}: proof "${a.proof}" is owned by ${proofOwner?.rootPath ?? '(unresolved)'}, ` +
          `not by coveredBy="${a.coveredBy}".`,
      );
    }
  }
}

// ── Rule 4 — exemptions still match a real detected file ─────────────────────
for (const e of exemptions) {
  const where = `exemption(${e.project})`;
  if (!e.file || !specOwner.has(e.file)) {
    errors.push(
      `${where}: file "${e.file}" is not a currently-detected integration spec — ` +
        `the exemption is stale and must be removed.`,
    );
    continue;
  }
  const owner = specOwner.get(e.file);
  if (!owner || owner.rootPath !== e.project) {
    errors.push(
      `${where}: file "${e.file}" is owned by ${owner?.rootPath ?? '(unresolved)'}, not by "${e.project}".`,
    );
  }
}

// ── Rule 1 — DEFAULT-DENY completeness: every bearing project is covered ──────
for (const [rootPath, info] of [...bearing.entries()].sort()) {
  const covered = rootSet.has(rootPath) || exemptProjects.has(rootPath);
  if (!covered) {
    errors.push(
      `UNCOVERED PROJECT: "${rootPath}" (nx: ${info.name}) owns integration spec(s):\n` +
        info.specs.map((s) => `    - ${s}`).join('\n') +
        `\n  but is absent from ci/integration-roots.json roots and has no valid exemption. ` +
        `Add "${rootPath}" to roots (default), or file a narrow exemption per Ruling 1.`,
    );
  }
}

// ── Divergence detection (Rules 7 & 8) — runners must consume the registry ───
interface Surface {
  label: string;
  file: string;
  mustReference: RegExp;
  refHint: string;
  /** operative text to scan for embedded root literals (defaults to whole file). */
  slice?: (raw: string) => string;
  forbid: RegExp;
  forbidHint: string;
}
const BARE_ROOT_LINE = /^\s*['"]?(?:libs|apps)\/[a-z0-9-]+\/?['"]?,?\s*$/m;
const surfaces: Surface[] = [
  {
    label: 'ci/scripts/ci-integration.sh',
    file: 'ci/scripts/ci-integration.sh',
    mustReference: /run-integration|integration-roots/,
    refHint: 'delegate to ci/scripts/run-integration.ts (which reads the registry)',
    forbid: BARE_ROOT_LINE,
    forbidHint: 'an embedded root-path list (ROOTS=( … ))',
  },
  {
    label: 'ci/scripts/prepush.ts',
    file: 'ci/scripts/prepush.ts',
    mustReference: /['"]\.\/integration-roots['"]|integration-roots/,
    refHint: "import { getRoots } from './integration-roots'",
    forbid: BARE_ROOT_LINE,
    forbidHint: 'an embedded INTEGRATION_ROOTS array of path literals',
  },
  {
    label: "package.json (script 'tests:integration')",
    file: 'package.json',
    mustReference: /run-integration/,
    refHint: 'invoke ci/scripts/run-integration.ts',
    slice: (raw) => {
      const m = /"tests:integration"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
      return m ? m[1] : '';
    },
    forbid: /--root\s+(?:libs|apps)\//,
    forbidHint: 'an embedded --root chain',
  },
];
for (const s of surfaces) {
  const abs = resolve(REPO_ROOT, s.file);
  if (!existsSync(abs)) {
    errors.push(`MISSING RUNNER: ${s.file} not found.`);
    continue;
  }
  const raw = readFileSync(abs, 'utf8');
  const operative = s.slice ? s.slice(raw) : raw;
  if (!s.mustReference.test(operative)) {
    errors.push(`STALE RUNNER: ${s.label} does not consume the canonical registry — it must ${s.refHint}.`);
  }
  if (s.forbid.test(operative)) {
    errors.push(`DIVERGENT RUNNER: ${s.label} still contains ${s.forbidHint}. All roots must come from ci/integration-roots.json.`);
  }
}

// ── Rule 10 — no frozen operative root count anywhere ────────────────────────
// A literal integer adjacent to the word "root(s)" on the same line, EXCLUDING
// runtime-derived counts (${#…}, .length). Runners must derive counts at runtime.
const COUNT_SURFACES = [
  'ci/scripts/ci-integration.sh',
  'ci/scripts/prepush.ts',
  '.github/workflows/ci.yml',
];
// A cardinality literal qualifying "root(s)": "16 roots", "16 integration roots",
// "roots … (18)", "set (18)". Deliberately NOT matching env literals like
// ARAMO_RUN_INTEGRATION=1 or exit codes ("exits 0"), which carry no count meaning.
const FROZEN_COUNT = /\b\d+\s+(?:integration\s+)?roots?\b|\broots?\b[^\n]{0,16}\(\s*\d+\s*\)|\bset\s*\(\s*\d+\s*\)/i;
const DERIVED = /\$\{#|\.length\b/;
for (const f of COUNT_SURFACES) {
  const abs = resolve(REPO_ROOT, f);
  if (!existsSync(abs)) continue;
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (FROZEN_COUNT.test(line) && !DERIVED.test(line)) {
        errors.push(`FROZEN COUNT: ${f}:${i + 1} pins a literal integration-root count — derive it at runtime.\n    ${line.trim()}`);
      }
    });
}
// package.json operative script slice (JSON — no comments; scan the two scripts only).
try {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  for (const key of ['tests:integration', 'tests:integration:check']) {
    const v = pkg.scripts?.[key];
    if (v && FROZEN_COUNT.test(v)) {
      errors.push(`FROZEN COUNT: package.json script "${key}" pins a literal root count — derive it at runtime.`);
    }
  }
} catch {
  errors.push('UNREADABLE: package.json could not be parsed.');
}

// ── Report ───────────────────────────────────────────────────────────────────
const bearingCount = bearing.size;
if (errors.length > 0) {
  console.error('\n✗ integration-root coverage guard FAILED\n');
  for (const e of errors) console.error(`  • ${e}\n`);
  console.error(
    `Summary (derived): ${bearingCount} integration-bearing project(s), ` +
      `${roots.length} registry root(s), ${aliases.length} coverage alias(es), ${exemptions.length} exemption(s).`,
  );
  process.exit(1);
}
console.log(
  `✓ integration-root coverage guard PASSED — ${bearingCount} bearing project(s) all covered ` +
    `by ${roots.length} root(s) + ${aliases.length} alias(es) + ${exemptions.length} exemption(s); ` +
    `all runners consume ci/integration-roots.json.`,
);
