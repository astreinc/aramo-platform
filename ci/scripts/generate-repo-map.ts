// D-REPOMAP-2 §4 (as amended by Amendment v1.4) — generated repo map.
//
// Emits a deterministic, byte-stable static index of the workspace under
// doc/generated/, maintained by the same generate-and-compare idiom as
// error-codes:check / version:sync-check / openapi:drift-check. The Lead lane
// reads it by path to discover coupling GitHub code-search cannot surface.
//
// Three artifacts (D-REPOMAP-1 §4.2):
//   repo-map.projects.json  — projects, aliases (+totals), exports, importedBy
//   repo-map.files.json     — tracked file paths
//   repo-map.coupling.json  — pathRefs, per-script typed references, unreferenced
//
// Determinism (D-REPOMAP-1 §4.4): every object key sorted; every array sorted
// by a stated key; explicit sort, never source order; no Date.now(), no SHAs,
// no absolute paths. Serialised through prettier's own API (D-REPOMAP-2 §3) so
// the committed bytes equal what `npm run format` would produce.
//
// The invocation scan (Amendment v1.4 §1.3) emits CLASSIFIED EVIDENCE, not a
// verdict: each occurrence of a script name is labelled npm-run / nx-target /
// script-body / prose. prose never counts. `unreferenced` is derived. This is
// R10 applied to static analysis — the generator proposes, a human disposes.
//
// Aliases self-derive (Amendment v1.4 §2.2): the emitted alias set equals the
// tsconfig.base.json paths keys at the built commit; totals are data, asserted
// against no frozen number.
//
// Run:       node --import jiti/register ci/scripts/generate-repo-map.ts
// Self-test: SELF_TEST=1 node --import jiti/register ci/scripts/generate-repo-map.ts

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as prettier from 'prettier';

const HERE = __dirname;
export const REPO_ROOT = resolve(HERE, '..', '..');

export const OUT_DIR = 'doc/generated';
export const OUT_FILES = {
  projects: `${OUT_DIR}/repo-map.projects.json`,
  files: `${OUT_DIR}/repo-map.files.json`,
  coupling: `${OUT_DIR}/repo-map.coupling.json`,
};

// git ls-files exclusions (D-REPOMAP-1 §4.2) plus doc/generated/ — the
// generator's OWN output. Excluding it is required for byte-stability: were it
// included, files.json would enumerate itself and pathRefs would match every
// path literal inside files.json. This mirrors the directive's existing
// **/prisma/generated/** exclusion (generated content is not indexed). Flagged
// to Lead in the Gate-5 report as a determinism-required divergence from the
// literal §4.2 exclusion list.
const EXCLUDE_RE = /(^|\/)node_modules\/|(^|\/)dist\/|\/prisma\/generated\/|^package-lock\.json$|^doc\/generated\//;

// Invocation-scan scope (Amendment v1.4 §1.4). .husky/** is included; its
// absence is recorded as a finding rather than skipped silently.
const SCAN_DIRS = ['.github/workflows', 'deploy', 'tools', 'scripts', 'ci/scripts', '.husky'];

// ---------------------------------------------------------------------------
// git / fs helpers
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readText(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** A tracked file is treated as text unless its bytes contain a NUL. */
function isTextFile(rel: string): boolean {
  const buf = readFileSync(join(REPO_ROOT, rel));
  return !buf.includes(0);
}

export function listTrackedFiles(): string[] {
  return git(['ls-files'])
    .split('\n')
    .filter((p) => p.length > 0 && !EXCLUDE_RE.test(p))
    .sort();
}

// ---------------------------------------------------------------------------
// Determinism: canonical key ordering + prettier round-trip serialisation
// ---------------------------------------------------------------------------

/** Recursively sort object keys. Arrays are left as-is — each producer sorts
 *  its arrays explicitly by a stated key, never by source order. */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Serialise through prettier's resolved config (D-REPOMAP-2 §3), so the bytes
 *  equal what `npm run format` would emit and the drift check stays stable. */
export async function serialise(relPath: string, value: unknown): Promise<string> {
  const cfg = await prettier.resolveConfig(join(REPO_ROOT, relPath));
  return prettier.format(JSON.stringify(canonical(value)), { ...cfg, filepath: relPath });
}

// ---------------------------------------------------------------------------
// projects.json
// ---------------------------------------------------------------------------

export type Project = {
  name: string;
  root: string;
  sourceRoot: string | null;
  tags: string[];
  targets: string[];
};

export function computeProjects(tracked: string[]): Project[] {
  const projects: Project[] = [];
  for (const rel of tracked) {
    if (!rel.endsWith('/project.json') && rel !== 'project.json') continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readText(rel)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof json['name'] === 'string' ? (json['name'] as string) : rel.replace(/\/project\.json$/, '');
    projects.push({
      name,
      root: rel === 'project.json' ? '.' : dirname(rel),
      sourceRoot: typeof json['sourceRoot'] === 'string' ? (json['sourceRoot'] as string) : null,
      tags: Array.isArray(json['tags']) ? [...(json['tags'] as string[])].sort() : [],
      targets:
        json['targets'] !== null && typeof json['targets'] === 'object'
          ? Object.keys(json['targets'] as Record<string, unknown>).sort()
          : [],
    });
  }
  return projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Aliases self-derived from tsconfig.base.json paths (Amendment v1.4 §2.2). */
export function computeAliases(): { aliases: Record<string, string>; totals: Record<string, number> } {
  const tsconfig = JSON.parse(readText('tsconfig.base.json')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const paths = tsconfig.compilerOptions?.paths ?? {};
  const aliases: Record<string, string> = {};
  let libs = 0;
  let apps = 0;
  for (const key of Object.keys(paths).sort()) {
    const target = paths[key]![0]!;
    aliases[key] = target;
    if (target.startsWith('libs/')) libs++;
    else if (target.startsWith('apps/')) apps++;
  }
  return { aliases, totals: { total: Object.keys(aliases).length, libs, apps } };
}

const EXPORT_DECL_RE =
  /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:const|let|var|function|async\s+function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;

/** Exported symbol names for each alias target (D-REPOMAP-1 §4.2). Regex-level,
 *  deterministic; approximate by design (this is an index, not a type checker). */
export function extractExports(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(EXPORT_DECL_RE)) names.add(m[1]!);
  for (const m of source.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1]!.split(',')) {
      const token = part.trim();
      if (token === '') continue;
      const asMatch = token.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      const name = asMatch ? asMatch[1]! : token.replace(/\s+as\s+.*/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'type') names.add(name);
    }
  }
  return [...names].sort();
}

export function computeExports(aliases: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    if (existsSync(join(REPO_ROOT, target))) out[alias] = extractExports(readText(target));
  }
  return out;
}

/** Longest project.root that prefixes a file path → owning project name. */
function ownerIndex(projects: Project[]): (file: string) => string | null {
  const roots = projects
    .filter((p) => p.root !== '.')
    .map((p) => ({ root: p.root + '/', name: p.name }))
    .sort((a, b) => b.root.length - a.root.length);
  return (file: string) => {
    for (const r of roots) if (file.startsWith(r.root)) return r.name;
    return null;
  };
}

const IMPORT_ALIAS_RE = /(?:from|import|require)\s*\(?\s*['"](@aramo\/[A-Za-z0-9._-]+)['"]/g;

/** Reverse index: alias → projects importing it (D-REPOMAP-1 §4.2). */
export function computeImportedBy(
  aliases: Record<string, string>,
  projects: Project[],
  tracked: string[],
): Record<string, string[]> {
  const owner = ownerIndex(projects);
  const acc: Record<string, Set<string>> = {};
  for (const alias of Object.keys(aliases)) acc[alias] = new Set();
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|jsx|mts|cts)$/.test(rel)) continue;
    if (!isTextFile(rel)) continue;
    const text = readText(rel);
    const project = owner(rel);
    if (project === null) continue;
    for (const m of text.matchAll(IMPORT_ALIAS_RE)) {
      const alias = m[1]!;
      if (acc[alias] !== undefined && alias !== `@aramo/${project}`) acc[alias].add(project);
    }
  }
  const out: Record<string, string[]> = {};
  for (const alias of Object.keys(acc).sort()) out[alias] = [...acc[alias]!].sort();
  return out;
}

// ---------------------------------------------------------------------------
// coupling.json — pathRefs
// ---------------------------------------------------------------------------

export type PathRef = { from: string; to: string; line: number };

const PATHLIKE_RE = /[A-Za-z0-9_@][A-Za-z0-9_@./-]*\/[A-Za-z0-9_@./-]*\.[A-Za-z0-9]+/g;

/** Every file containing a string literal that matches another tracked path,
 *  as {from,to,line} (D-REPOMAP-1 §4.2 — the PR-5b path-coupling class). */
export function computePathRefs(tracked: string[]): PathRef[] {
  const trackedSet = new Set(tracked);
  const refs: PathRef[] = [];
  const seen = new Set<string>();
  for (const from of tracked) {
    if (!isTextFile(from)) continue;
    const lines = readText(from).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i]!.match(PATHLIKE_RE);
      if (matches === null) continue;
      for (const cand of matches) {
        if (cand === from || !trackedSet.has(cand)) continue;
        const key = `${from} ${cand} ${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ from, to: cand, line: i + 1 });
      }
    }
  }
  return refs.sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// coupling.json — typed script references (Amendment v1.4 §1.3)
// ---------------------------------------------------------------------------

export type RefKind = 'npm-run' | 'nx-target' | 'script-body' | 'prose';
export type ScriptRef = { kind: RefKind; path: string; line: number };
export type ScriptEntry = { name: string; references: ScriptRef[] };

// Deterministic, locale-INDEPENDENT string order (D-REPOMAP-1 §4.4: output must
// be identical across Linux and macOS). String.localeCompare is locale-sensitive
// and must never be used for emitted ordering; compare by UTF-16 code unit.
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const NAME_TOKEN = /[A-Za-z0-9:_-]/;

/** Whole-token occurrences of `name` in `line`; a name token is bounded by any
 *  character outside [A-Za-z0-9:_-], so `format` never matches inside
 *  `format:check` and `lint` never matches inside `eslint`. */
function tokenPositions(line: string, name: string): number[] {
  const out: number[] = [];
  let i = 0;
  while ((i = line.indexOf(name, i)) !== -1) {
    const before = i > 0 ? line[i - 1]! : '';
    const after = i + name.length < line.length ? line[i + name.length]! : '';
    if (!NAME_TOKEN.test(before) && !NAME_TOKEN.test(after)) out.push(i);
    i += name.length;
  }
  return out;
}

const NPM_RUN_PREFIX = /npm run (?:--?[A-Za-z][\w-]* )*$/;

/** Classify a single whole-token occurrence by the syntactic form that
 *  precedes it. Only npm-run / nx-target are recognised invocation forms in the
 *  scanned trees; everything else is prose and never counts. Definition C
 *  (Amendment v1.4 §1.2) is honoured: `nx -t <name>` is nx-target, kept
 *  distinct from an npm-run of the same-named script. */
export function classifyOccurrence(line: string, at: number): RefKind {
  const prefix = line.slice(0, at);
  if (NPM_RUN_PREFIX.test(prefix)) return 'npm-run';
  if (/(?:^|\s)-t[= ]$/.test(prefix) || /--target[= ]$/.test(prefix)) return 'nx-target';
  return 'prose';
}

export type ScriptScan = {
  scripts: ScriptEntry[];
  unreferenced: string[];
  scanScope: { dirs: string[]; huskyPresent: boolean; files: number };
};

export function computeScriptRefs(tracked: string[]): ScriptScan {
  const pkgText = readText('package.json');
  const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts).sort();

  // package.json line index for each script name (for script-body provenance).
  const pkgLines = pkgText.split('\n');
  const scriptLine: Record<string, number> = {};
  for (const name of names) {
    const idx = pkgLines.findIndex((l) => new RegExp(`^\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`).test(l));
    if (idx !== -1) scriptLine[name] = idx + 1;
  }

  const scanFiles = tracked.filter((rel) => SCAN_DIRS.some((d) => rel === d || rel.startsWith(d + '/')));
  const huskyPresent = tracked.some((rel) => rel.startsWith('.husky/'));

  const fileLines = new Map<string, string[]>();
  for (const rel of scanFiles) {
    if (isTextFile(rel)) fileLines.set(rel, readText(rel).split('\n'));
  }

  const entries: ScriptEntry[] = [];
  const unreferenced: string[] = [];

  for (const name of names) {
    const references: ScriptRef[] = [];

    // (a) invocation scan across the six scope trees.
    for (const [rel, lines] of fileLines) {
      for (let i = 0; i < lines.length; i++) {
        for (const at of tokenPositions(lines[i]!, name)) {
          references.push({ kind: classifyOccurrence(lines[i]!, at), path: rel, line: i + 1 });
        }
      }
    }

    // (b) script-body: the name appearing inside ANOTHER script's command
    //     string (Amendment v1.4 §1.3). package.json is not in the scan trees;
    //     this is its dedicated source.
    for (const [owner, body] of Object.entries(scripts)) {
      if (owner === name) continue;
      if (tokenPositions(body, name).length > 0) {
        references.push({ kind: 'script-body', path: 'package.json', line: scriptLine[owner] ?? 0 });
      }
    }

    references.sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line || byCodeUnit(a.kind, b.kind));
    entries.push({ name, references });

    // unreferenced = zero references of a COUNTING kind (prose excluded).
    if (!references.some((r) => r.kind !== 'prose')) unreferenced.push(name);
  }

  return {
    scripts: entries,
    unreferenced: unreferenced.sort(),
    scanScope: { dirs: [...SCAN_DIRS].sort(), huskyPresent, files: scanFiles.length },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function computeMap(): { projects: unknown; files: unknown; coupling: unknown } {
  const tracked = listTrackedFiles();
  const projects = computeProjects(tracked);
  const { aliases, totals } = computeAliases();

  return {
    projects: {
      aliases,
      aliasTotals: totals,
      exports: computeExports(aliases),
      importedBy: computeImportedBy(aliases, projects, tracked),
      projects,
    },
    files: { files: tracked },
    coupling: {
      pathRefs: computePathRefs(tracked),
      ...computeScriptRefs(tracked),
    },
  };
}

export async function renderAll(): Promise<{ rel: string; content: string }[]> {
  const map = computeMap();
  return [
    { rel: OUT_FILES.projects, content: await serialise(OUT_FILES.projects, map.projects) },
    { rel: OUT_FILES.files, content: await serialise(OUT_FILES.files, map.files) },
    { rel: OUT_FILES.coupling, content: await serialise(OUT_FILES.coupling, map.coupling) },
  ];
}

// ---------------------------------------------------------------------------
// self-test + main
// ---------------------------------------------------------------------------

function runSelfTest(): void {
  const line = "steps.push(['verify:vocabulary', () => run('npm run --silent verify:vocabulary')]);";
  const pos = tokenPositions(line, 'verify:vocabulary');
  if (pos.length !== 2) throw new Error(`self-test: expected 2 tokens, got ${pos.length}`);
  if (classifyOccurrence(line, pos[0]!) !== 'prose') throw new Error('self-test: first occurrence should be prose');
  if (classifyOccurrence(line, pos[1]!) !== 'npm-run') throw new Error('self-test: flag-tolerant npm-run missed');

  if (tokenPositions('npm run format:check', 'format').length !== 0) {
    throw new Error('self-test: `format` wrongly matched inside `format:check`');
  }
  if (classifyOccurrence('npx nx affected -t lint', 'npx nx affected -t '.length) !== 'nx-target') {
    throw new Error('self-test: `-t lint` should classify nx-target');
  }
  if (classifyOccurrence('# -Fc custom format captures', '# -Fc custom '.length) !== 'prose') {
    throw new Error('self-test: comment word should classify prose');
  }
  if (extractExports("export const A = 1;\nexport { b as C };\nexport type T = X;").join(',') !== 'A,C,T') {
    throw new Error('self-test: export extraction wrong');
  }
  const c = canonical({ b: 1, a: [{ y: 2, x: 1 }] }) as Record<string, unknown>;
  if (JSON.stringify(c) !== '{"a":[{"x":1,"y":2}],"b":1}') throw new Error('self-test: canonical ordering wrong');
  console.log('self-test ok: classifier, whole-token, export extraction, canonical ordering');
}

async function main(): Promise<void> {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const rendered = await renderAll();
  mkdirSync(join(REPO_ROOT, OUT_DIR), { recursive: true });
  for (const { rel, content } of rendered) {
    writeFileSync(join(REPO_ROOT, rel), content, 'utf8');
    console.log(`wrote ${rel}`);
  }
  console.log('repo-map:generate ok');
}

// Only run when executed directly — NOT when imported by the verifier, which
// must regenerate in memory and compare, never write to disk.
if (process.argv[1] !== undefined && /generate-repo-map\.ts$/.test(process.argv[1])) {
  void main();
}
