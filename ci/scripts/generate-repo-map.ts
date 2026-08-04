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
const EXCLUDE_RE =
  /(^|\/)node_modules\/|(^|\/)dist\/|\/prisma\/generated\/|^package-lock\.json$|^doc\/generated\//;

// Invocation-scan scope (Amendment v1.4 §1.4). .husky/** is included; its
// absence is recorded as a finding rather than skipped silently.
const SCAN_DIRS = ['.github/workflows', 'deploy', 'tools', 'scripts', 'ci/scripts', '.husky'];

// ---------------------------------------------------------------------------
// git / fs helpers
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
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
    const name =
      typeof json['name'] === 'string'
        ? (json['name'] as string)
        : rel.replace(/\/project\.json$/, '');
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
export function computeAliases(): {
  aliases: Record<string, string>;
  totals: Record<string, number>;
} {
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

// ---------------------------------------------------------------------------
// Compile-scope classifier (Amendment R-REPOMAP-4)
//
// Classifies a tracked file by whether it is inside its owning project's build
// tsconfig compile scope. This makes the map agree with the compiler by
// construction (the R-REPOMAP-2 pattern) and lets a reader see WHY an edge is or
// is not a real dependency — WITHOUT the map judging what a pattern means. The
// negative-control fixtures are `excluded` by their own tsconfig.{lib,app}.json;
// this reads that fact from the tsconfig, never a second hardcoded fixture list.
// ---------------------------------------------------------------------------

export type FileStatus = 'production' | 'excluded' | 'unscoped';
export type Classification = { status: FileStatus; excludedBy?: string };
type BuildScope = { root: string; include: string[]; exclude: string[] };

// Self-contained tsconfig-style glob to RegExp. Deliberately NOT a dependency on
// minimatch/picomatch: those are only transitive here, and relying on an
// undeclared transitive is a lockfile-fragility hazard. Handles the tsconfig
// include/exclude vocabulary: globstar across path segments, single star within
// one segment, "?", and literals. Path-relative, slash-separated.
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else {
      const c = glob[i]!;
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (
        c === '{' ||
        c === '}' ||
        c === '[' ||
        c === ']' ||
        c === '(' ||
        c === ')' ||
        c === '!'
      ) {
        // FAIL LOUD (R-REPOMAP-4 Ruling 3): brace expansion, char classes, extglob,
        // and negation are NOT implemented. A silent non-match here would put a
        // quarantined fixture into `production` and be trusted — the exact failure
        // this exercise exists to prevent. Add support explicitly, never guess.
        throw new Error(
          `generate-repo-map: unsupported glob metacharacter '${c}' in tsconfig pattern "${glob}". ` +
            `The compile-scope matcher handles *, **, ? and literals only.`,
        );
      } else if (/[^A-Za-z0-9/_-]/.test(c))
        re += '\\' + c; // escape any regex-special literal
      else re += c;
    }
  }
  return new RegExp(re + '$');
}

const globCache = new Map<string, RegExp>();
function globMatch(path: string, glob: string): boolean {
  let re = globCache.get(glob);
  if (re === undefined) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(path);
}

function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // tsconfig files may carry // and /* */ comments; strip and retry.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    return JSON.parse(stripped);
  }
}

/** Each project's build tsconfig (tsconfig.lib.json | tsconfig.app.json)
 *  include/exclude globs. include/exclude are NOT inherited via `extends`, so the
 *  leaf build tsconfig is authoritative. */
export function loadBuildScopes(projects: Project[]): Map<string, BuildScope> {
  const scopes = new Map<string, BuildScope>();
  for (const p of projects) {
    if (p.root === '.') continue;
    for (const name of ['tsconfig.lib.json', 'tsconfig.app.json']) {
      const abs = join(REPO_ROOT, p.root, name);
      if (!existsSync(abs)) continue;
      let json: { include?: unknown; exclude?: unknown };
      try {
        json = parseJsonc(readFileSync(abs, 'utf8')) as typeof json;
      } catch {
        continue;
      }
      scopes.set(p.name, {
        root: p.root,
        include: Array.isArray(json.include) ? (json.include as string[]) : [],
        exclude: Array.isArray(json.exclude) ? (json.exclude as string[]) : [],
      });
      break; // lib before app; first build tsconfig wins
    }
  }
  return scopes;
}

/** Classify a tracked file against its owning project's compile scope. `excluded`
 *  records the FIRST matching exclude glob verbatim — no judgment about what the
 *  pattern means. A file in no project, or a project with no build tsconfig, is
 *  `unscoped` (it compiles in nothing). */
export function classifyFile(
  file: string,
  project: string | null,
  scopes: Map<string, BuildScope>,
): Classification {
  if (project === null) return { status: 'unscoped' };
  const scope = scopes.get(project);
  if (scope === undefined) return { status: 'unscoped' };
  const rel = file.startsWith(scope.root + '/') ? file.slice(scope.root.length + 1) : file;
  for (const pat of scope.exclude) {
    if (globMatch(rel, pat)) return { status: 'excluded', excludedBy: pat };
  }
  const included = scope.include.length === 0 || scope.include.some((pat) => globMatch(rel, pat));
  return { status: included ? 'production' : 'unscoped' };
}

const IMPORT_ALIAS_RE = /(?:from|import|require)\s*\(?\s*['"](@aramo\/[A-Za-z0-9._-]+)['"]/g;

// production edges omit `from` (deduped per project); excluded/unscoped keep it.
export type ImportEdge = {
  from?: string;
  project: string;
  status: FileStatus;
  excludedBy?: string;
};

/** Reverse index: alias → the import edges referencing it, each classified by the
 *  importing file's compile scope (Amendment R-REPOMAP-4). Records every edge —
 *  production, excluded (with the excluding pattern), or unscoped — and judges
 *  none; a reader disposes. A cross-scope import that lands in an `excluded`
 *  fixture is visibly not a real dependency. */
export function computeImportedBy(
  aliases: Record<string, string>,
  projects: Project[],
  tracked: string[],
  scopes: Map<string, BuildScope>,
): Record<string, ImportEdge[]> {
  const owner = ownerIndex(projects);
  const prod: Record<string, Set<string>> = {}; // alias -> production project names (deduped)
  const perFile: Record<string, Map<string, ImportEdge>> = {}; // alias -> from -> excluded|unscoped edge
  for (const alias of Object.keys(aliases)) {
    prod[alias] = new Set();
    perFile[alias] = new Map();
  }
  for (const rel of tracked) {
    if (!/\.(ts|tsx|js|jsx|mts|cts)$/.test(rel)) continue;
    if (!isTextFile(rel)) continue;
    const project = owner(rel);
    const text = readText(rel);
    const seenAlias = new Set<string>();
    for (const m of text.matchAll(IMPORT_ALIAS_RE)) {
      const alias = m[1]!;
      if (prod[alias] === undefined) continue;
      if (project !== null && alias === `@aramo/${project}`) continue; // self-import
      if (seenAlias.has(alias)) continue; // one edge per (importing file, alias)
      seenAlias.add(alias);
      const cls = classifyFile(rel, project, scopes);
      if (cls.status === 'production' && project !== null) {
        prod[alias].add(project); // dedup per project — the specific file is recoverable
      } else {
        const edge: ImportEdge = {
          from: rel,
          project: project ?? '(unscoped)',
          status: cls.status,
        };
        if (cls.excludedBy !== undefined) edge.excludedBy = cls.excludedBy;
        perFile[alias].set(rel, edge); // per file — file + pattern are the information
      }
    }
  }
  const out: Record<string, ImportEdge[]> = {};
  for (const alias of Object.keys(aliases).sort()) {
    const edges: ImportEdge[] = [...prod[alias]!].map((project) => ({
      project,
      status: 'production' as const,
    }));
    edges.push(...perFile[alias]!.values());
    edges.sort(
      (a, b) =>
        byCodeUnit(a.project, b.project) ||
        byCodeUnit(a.status, b.status) ||
        byCodeUnit(a.from ?? '', b.from ?? ''),
    );
    out[alias] = edges;
  }
  return out;
}

// ---------------------------------------------------------------------------
// coupling.json — pathRefs
// ---------------------------------------------------------------------------

export type PathRef = { from: string; to: string; status: FileStatus; excludedBy?: string };

const PATHLIKE_RE = /[A-Za-z0-9_@][A-Za-z0-9_@./-]*\/[A-Za-z0-9_@./-]*\.[A-Za-z0-9]+/g;

/** Pure: the deduped path-coupling edges a single file's CONTENT produces, by
 *  ARCHITECTURAL identity (from,to,status) — D-REPOMAP-3. Line-free; multiple
 *  occurrences of the same (from,to) collapse to one edge, so a blank-line
 *  insertion or an intra-file move does not change the output. Extracted so the
 *  drift-immunity properties are unit-assertable in runSelfTest. */
export function pathRefsForFile(
  from: string,
  lines: string[],
  trackedSet: Set<string>,
  cls: Classification,
): PathRef[] {
  const refs: PathRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i]!.match(PATHLIKE_RE);
    if (matches === null) continue;
    for (const cand of matches) {
      if (cand === from || !trackedSet.has(cand) || seen.has(cand)) continue;
      seen.add(cand);
      const ref: PathRef = { from, to: cand, status: cls.status };
      if (cls.excludedBy !== undefined) ref.excludedBy = cls.excludedBy;
      refs.push(ref);
    }
  }
  return refs;
}

/** Every file containing a string literal that matches another tracked path,
 *  as {from,to,status} (D-REPOMAP-3 — architectural identity, line-free). */
export function computePathRefs(
  tracked: string[],
  projects: Project[],
  scopes: Map<string, BuildScope>,
): PathRef[] {
  const owner = ownerIndex(projects);
  const trackedSet = new Set(tracked);
  const refs: PathRef[] = [];
  for (const from of tracked) {
    if (!isTextFile(from)) continue;
    const cls = classifyFile(from, owner(from), scopes);
    refs.push(...pathRefsForFile(from, readText(from).split('\n'), trackedSet, cls));
  }
  return refs.sort(
    (a, b) =>
      byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to) || byCodeUnit(a.status, b.status),
  );
}

// ---------------------------------------------------------------------------
// coupling.json — typed script references (Amendment v1.4 §1.3)
// ---------------------------------------------------------------------------

export type RefKind = 'npm-run' | 'nx-target' | 'script-body' | 'prose';
export type ScriptRef = { kind: RefKind; path: string };
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

/** Pure: the deduped invocation references a single file's CONTENT produces for
 *  one script `name`, by (kind,path) identity — D-REPOMAP-3, line-free. Multiple
 *  occurrences of the same (kind,path) collapse; a blank-line insertion or an
 *  intra-file move does not change the output. Unit-assertable in runSelfTest. */
export function scriptRefsForFile(name: string, lines: string[], path: string): ScriptRef[] {
  const out: ScriptRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    for (const at of tokenPositions(lines[i]!, name)) {
      const kind = classifyOccurrence(lines[i]!, at);
      const key = `${kind} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, path });
    }
  }
  return out;
}

export function computeScriptRefs(tracked: string[]): ScriptScan {
  const pkgText = readText('package.json');
  const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const names = Object.keys(scripts).sort();

  const scanFiles = tracked.filter((rel) =>
    SCAN_DIRS.some((d) => rel === d || rel.startsWith(d + '/')),
  );
  const huskyPresent = tracked.some((rel) => rel.startsWith('.husky/'));

  const fileLines = new Map<string, string[]>();
  for (const rel of scanFiles) {
    if (isTextFile(rel)) fileLines.set(rel, readText(rel).split('\n'));
  }

  const entries: ScriptEntry[] = [];
  const unreferenced: string[] = [];

  for (const name of names) {
    const references: ScriptRef[] = [];
    // D-REPOMAP-3: reference identity is (kind,path), not textual. Dedup so
    // multiple occurrences of the same (kind,path) collapse to one reference and
    // an unrelated line shift no longer changes canonical output.
    const seenRef = new Set<string>();
    const addRef = (kind: RefKind, path: string): void => {
      const key = `${kind} ${path}`;
      if (seenRef.has(key)) return;
      seenRef.add(key);
      references.push({ kind, path });
    };

    // (a) invocation scan across the six scope trees (line-free per-file dedup).
    for (const [rel, lines] of fileLines) {
      for (const ref of scriptRefsForFile(name, lines, rel)) addRef(ref.kind, ref.path);
    }

    // (b) script-body: the name appearing inside ANOTHER script's command
    //     string (Amendment v1.4 §1.3). package.json is not in the scan trees;
    //     this is its dedicated source.
    for (const [owner, body] of Object.entries(scripts)) {
      if (owner === name) continue;
      if (tokenPositions(body, name).length > 0) {
        addRef('script-body', 'package.json');
      }
    }

    references.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.kind, b.kind));
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
  const scopes = loadBuildScopes(projects);

  return {
    projects: {
      aliases,
      aliasTotals: totals,
      exports: computeExports(aliases),
      importedBy: computeImportedBy(aliases, projects, tracked, scopes),
      projects,
    },
    files: { files: tracked },
    coupling: {
      pathRefs: computePathRefs(tracked, projects, scopes),
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

export function runSelfTest(): void {
  const line =
    "steps.push(['verify:vocabulary', () => run('npm run --silent verify:vocabulary')]);";
  const pos = tokenPositions(line, 'verify:vocabulary');
  if (pos.length !== 2) throw new Error(`self-test: expected 2 tokens, got ${pos.length}`);
  if (classifyOccurrence(line, pos[0]!) !== 'prose')
    throw new Error('self-test: first occurrence should be prose');
  if (classifyOccurrence(line, pos[1]!) !== 'npm-run')
    throw new Error('self-test: flag-tolerant npm-run missed');

  if (tokenPositions('npm run format:check', 'format').length !== 0) {
    throw new Error('self-test: `format` wrongly matched inside `format:check`');
  }
  if (classifyOccurrence('npx nx affected -t lint', 'npx nx affected -t '.length) !== 'nx-target') {
    throw new Error('self-test: `-t lint` should classify nx-target');
  }
  if (classifyOccurrence('# -Fc custom format captures', '# -Fc custom '.length) !== 'prose') {
    throw new Error('self-test: comment word should classify prose');
  }
  if (
    extractExports('export const A = 1;\nexport { b as C };\nexport type T = X;').join(',') !==
    'A,C,T'
  ) {
    throw new Error('self-test: export extraction wrong');
  }

  // D-REPOMAP-3 — coupling drift-immunity: identity is architectural, not
  // textual. Every assertion below MUST fail against the pre-amendment generator
  // (which keyed on line and emitted one record per textual occurrence).
  {
    // pathRefs — via pathRefsForFile.
    const T = new Set(['a/one.ts', 'a/two.ts']);
    const cls: Classification = { status: 'production' };
    const pr = (ls: string[]): string => JSON.stringify(pathRefsForFile('a/from.ts', ls, T, cls));
    const pbase = ['top', "x 'a/one.ts'", 'bottom'];
    if (pr(pbase) !== pr(['top', '', "x 'a/one.ts'", 'bottom']))
      throw new Error('self-test D-REPOMAP-3: blank-line changed pathRefs');
    if (pr(pbase) !== pr(['top', 'bottom', 'mid', "x 'a/one.ts'"]))
      throw new Error('self-test D-REPOMAP-3: intra-file move changed pathRefs');
    if (JSON.parse(pr(["a 'a/one.ts'", "b 'a/one.ts'", "c 'a/one.ts'"])).length !== 1)
      throw new Error('self-test D-REPOMAP-3: duplicate occurrence duplicated the pathRef edge');
    if (JSON.parse(pr(["a 'a/one.ts'", "b 'a/two.ts'"])).length !== 2)
      throw new Error('self-test D-REPOMAP-3: new relationship not recorded');
    if (JSON.parse(pr(['nothing here'])).length !== 0)
      throw new Error('self-test D-REPOMAP-3: delete-final did not remove the pathRef edge');

    // scriptRefs — via scriptRefsForFile.
    const sr = (ls: string[]): string =>
      JSON.stringify(scriptRefsForFile('verify:vocabulary', ls, 'ci/scripts/x.ts'));
    const sbase = ['top', 'npm run verify:vocabulary', 'bottom'];
    if (sr(sbase) !== sr(['top', '', 'npm run verify:vocabulary', 'bottom']))
      throw new Error('self-test D-REPOMAP-3: blank-line changed scriptRefs');
    if (sr(sbase) !== sr(['top', 'bottom', 'npm run verify:vocabulary']))
      throw new Error('self-test D-REPOMAP-3: intra-file move changed scriptRefs');
    if (JSON.parse(sr(['npm run verify:vocabulary', 'npm run verify:vocabulary'])).length !== 1)
      throw new Error('self-test D-REPOMAP-3: duplicate occurrence duplicated the scriptRef');
  }

  // glob matcher (R-REPOMAP-4)
  const gm: [string, string, boolean][] = [
    ['src/i15-negative-control/cip.fixture.ts', 'src/i15-negative-control/**', true],
    ['src/lib/matcher.ts', 'src/i15-negative-control/**', false],
    ['src/tests/x.spec.ts', 'src/tests/**/*', true],
    ['src/tests/deep/x.ts', 'src/tests/**/*', true],
    ['src/tests/x.spec.ts', '**/*.spec.ts', true],
    ['src/lib/matcher.ts', 'src/**/*.ts', true],
    ['src/lib/matcher.tsx', 'src/**/*.ts', false],
    ['a.ts', 'src/**/*.ts', false],
  ];
  for (const [p, g, want] of gm) {
    if (globMatch(p, g) !== want) throw new Error(`self-test: glob ${g} vs ${p} expected ${want}`);
  }
  // fail-loud on unsupported glob syntax (R-REPOMAP-4 Ruling 3)
  for (const bad of ['src/{a,b}/**', 'src/[abc].ts', 'src/+(x)/**', 'src/!(y)/**']) {
    let threw = false;
    try {
      globToRegExp(bad);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`self-test: matcher must throw on unsupported glob "${bad}"`);
  }

  // compile-scope classifier (R-REPOMAP-4)
  const scopes = new Map([
    [
      'matching',
      {
        root: 'libs/matching',
        include: ['src/**/*.ts'],
        exclude: ['src/tests/**/*', '**/*.spec.ts', 'src/i15-negative-control/**'],
      },
    ],
  ]);
  const fx = classifyFile(
    'libs/matching/src/i15-negative-control/cip-imports-ats.fixture.ts',
    'matching',
    scopes,
  );
  if (fx.status !== 'excluded' || fx.excludedBy !== 'src/i15-negative-control/**') {
    throw new Error(`self-test: fixture should be excluded by its glob, got ${JSON.stringify(fx)}`);
  }
  if (
    classifyFile('libs/matching/src/lib/matcher.ts', 'matching', scopes).status !== 'production'
  ) {
    throw new Error('self-test: lib source should be production');
  }
  if (classifyFile('libs/matching/src/tests/x.spec.ts', 'matching', scopes).status !== 'excluded') {
    throw new Error('self-test: spec should be excluded');
  }
  if (classifyFile('deploy/pg-backup.sh', null, scopes).status !== 'unscoped') {
    throw new Error('self-test: no-project file should be unscoped');
  }
  const c = canonical({ b: 1, a: [{ y: 2, x: 1 }] }) as Record<string, unknown>;
  if (JSON.stringify(c) !== '{"a":[{"x":1,"y":2}],"b":1}')
    throw new Error('self-test: canonical ordering wrong');
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
