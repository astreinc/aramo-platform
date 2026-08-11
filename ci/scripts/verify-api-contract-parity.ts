// GLH-1-C (ATS Go-Live Hardening Charter v1.5) — governed API contract-parity wall.
//
// Ratified taxonomy (Charter v1.5 amendment): every live production HTTP route is exactly
// one of XP (external partner) | AP (first-party application) | SS (session/auth) |
// AD (adapter/ingestion) | PZ (public session-less first-party) | IZ (infra/health). There is
// NO intentionally-undocumented (XD) class. Governed = XP∪AP∪SS∪AD∪PZ; exempt = IZ.
//
// Classification authority = ci/config/api-surface-manifest.json (controller-keyed, with
// route-level overrides). Default-deny: a live route with no classification FAILS.
//
// Three directions (GA scope = method + normalized path ONLY; no schema/scope/security parity):
//   D1 governed live route  → matching OpenAPI op  OR  explicit transitionalUndocumented entry
//   D2 OpenAPI op           → matching live handler (no orphans)
//   D3 live route           → manifest classification (no unclassified)
// transitionalUndocumented is a RATCHET: existing debt may be enumerated (exact METHOD+path),
// but a NEW governed-undocumented route not already listed FAILS D1.
//
// Route inventory is derived from source via the TypeScript AST (not fragile regex): the
// @Controller base + each @Get/@Post/@Put/@Patch/@Delete/@All handler path, composed and
// normalized (path params → '*'). FAIL-CLOSED: a decorator arg that is not a string literal
// is reported as `unresolved-route` (never silently skipped).
//
// Non-vacuous by construction: an embedded selftest drives synthetic fixtures through the
// validator for every failure mode (D1/D2/D3, ratchet, normalization, method-mismatch, IZ)
// and aborts if any is not detected.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const OPENAPI_DIR = resolve(ROOT, 'openapi');
const MANIFEST_PATH = resolve(ROOT, 'ci', 'config', 'api-surface-manifest.json');

const VERB_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
};
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export interface LiveRoute {
  method: string; // HTTP verb, uppercase
  path: string; // normalized full path (params → '*')
  rawPath: string; // pre-normalization full path
  controller: string; // repo-relative controller file
  line: number;
}
export interface UnresolvedRoute {
  controller: string;
  line: number;
  reason: string;
}
export interface OpenApiOp {
  method: string;
  pathForms: string[]; // normalized full-path forms (pathKey and serversBase+pathKey)
  spec: string;
  rawPath: string;
}

// ── Path normalization ───────────────────────────────────────────────────────────────────
export function normalizePath(p: string): string {
  const joined = ('/' + p).replace(/\/+/g, '/');
  const segs = joined
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(':') || /^\{.*\}$/.test(s) ? '*' : s));
  return '/' + segs.join('/');
}
export function composePath(base: string, methodPath: string): string {
  return normalizePath([base, methodPath].filter((s) => s && s.length > 0).join('/'));
}

// ── AST route extraction ─────────────────────────────────────────────────────────────────
function stringLiteralArg(args: ts.NodeArray<ts.Expression>): { ok: boolean; value: string } {
  const a = args[0];
  if (a === undefined) return { ok: true, value: '' };
  if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))
    return { ok: true, value: a.text };
  return { ok: false, value: '' };
}
function decoratorCall(
  d: ts.Decorator,
): { name: string; args: ts.NodeArray<ts.Expression> } | null {
  if (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression)) {
    return { name: d.expression.expression.text, args: d.expression.arguments };
  }
  return null;
}

export function extractRoutesFromSource(
  text: string,
  fileLabel: string,
): { routes: LiveRoute[]; unresolved: UnresolvedRoute[] } {
  const src = ts.createSourceFile(fileLabel, text, ts.ScriptTarget.Latest, true);
  const routes: LiveRoute[] = [];
  const unresolved: UnresolvedRoute[] = [];
  const lineOf = (node: ts.Node): number =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && ts.canHaveDecorators(node)) {
      let base: string | null = null;
      let baseUnresolved = false;
      for (const d of ts.getDecorators(node) ?? []) {
        const c = decoratorCall(d);
        if (c && c.name === 'Controller') {
          const s = stringLiteralArg(c.args);
          if (s.ok) base = s.value;
          else baseUnresolved = true;
        }
      }
      if (base !== null || baseUnresolved) {
        for (const m of node.members) {
          if (!ts.isMethodDeclaration(m) || !ts.canHaveDecorators(m)) continue;
          for (const d of ts.getDecorators(m) ?? []) {
            const c = decoratorCall(d);
            if (!c) continue;
            const verb = VERB_DECORATORS[c.name];
            if (!verb) continue;
            const s = stringLiteralArg(c.args);
            if (baseUnresolved || !s.ok) {
              unresolved.push({
                controller: fileLabel,
                line: lineOf(m),
                reason: baseUnresolved
                  ? '@Controller() base path is not a string literal'
                  : `@${c.name}() path arg is not a string literal`,
              });
              continue;
            }
            const rawPath = ['/' + (base ?? ''), s.value].join('/').replace(/\/+/g, '/');
            routes.push({
              method: verb,
              path: composePath(base ?? '', s.value),
              rawPath,
              controller: fileLabel,
              line: lineOf(m),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return { routes, unresolved };
}

/** Enumerate git-tracked controller source files under apps/ and libs/ (deterministic). */
export function controllerFiles(root: string = ROOT): string[] {
  const tracked = execFileSync('git', ['ls-files', 'apps', 'libs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !/\.spec\.ts$|\.test\.ts$/.test(f));
  return tracked.filter((f) => readFileSync(resolve(root, f), 'utf8').includes('@Controller('));
}

export function extractLiveRoutes(root: string = ROOT): {
  routes: LiveRoute[];
  unresolved: UnresolvedRoute[];
} {
  const routes: LiveRoute[] = [];
  const unresolved: UnresolvedRoute[] = [];
  for (const f of controllerFiles(root)) {
    const r = extractRoutesFromSource(readFileSync(resolve(root, f), 'utf8'), f);
    routes.push(...r.routes);
    unresolved.push(...r.unresolved);
  }
  return { routes, unresolved };
}

// ── OpenAPI extraction ───────────────────────────────────────────────────────────────────
function serversBasePath(servers: unknown): string {
  if (!Array.isArray(servers) || servers.length === 0) return '';
  const url = (servers[0] as { url?: string })?.url ?? '';
  try {
    const pathname = new URL(url).pathname;
    return pathname === '/' ? '' : pathname;
  } catch {
    // relative server url: treat the whole thing as a path if it starts with '/'
    return url.startsWith('/') ? url : '';
  }
}
export function extractOpenApiOps(dir: string = OPENAPI_DIR): OpenApiOp[] {
  const ops: OpenApiOp[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()) {
    const doc = parse(readFileSync(resolve(dir, file), 'utf8')) as {
      servers?: unknown;
      paths?: Record<string, Record<string, unknown>>;
    };
    const base = serversBasePath(doc.servers);
    for (const [pathKey, item] of Object.entries(doc.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (item && item[method]) {
          const pathForms = new Set<string>([normalizePath(pathKey)]);
          if (base) pathForms.add(normalizePath(base + '/' + pathKey));
          ops.push({
            method: method.toUpperCase(),
            pathForms: [...pathForms],
            spec: `openapi/${file}`,
            rawPath: pathKey,
          });
        }
      }
    }
  }
  return ops;
}

// ── Manifest + classification ────────────────────────────────────────────────────────────
export interface Manifest {
  governed: string[];
  exempt: string[];
  controllers: Record<string, string>;
  routeOverrides: Array<{ method: string; path: string; class: string }>;
  transitionalUndocumented: Array<{ method: string; path: string }>;
}
export function loadManifest(path: string = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}
export function classify(route: LiveRoute, manifest: Manifest): string | null {
  const override = manifest.routeOverrides.find(
    (o) => o.method === route.method && normalizePath(o.path) === route.path,
  );
  if (override) return override.class;
  return manifest.controllers[route.controller] ?? null;
}

export interface Violation {
  kind:
    | 'unresolved-route'
    | 'unclassified-route'
    | 'governed-route-undocumented'
    | 'openapi-orphan'
    | 'unknown-class';
  detail: string;
}

export function validate(
  routes: LiveRoute[],
  unresolved: UnresolvedRoute[],
  ops: OpenApiOp[],
  manifest: Manifest,
): Violation[] {
  const violations: Violation[] = [];
  const governed = new Set(manifest.governed);
  const known = new Set([...manifest.governed, ...manifest.exempt]);
  const transitional = new Set(
    manifest.transitionalUndocumented.map((t) => `${t.method} ${normalizePath(t.path)}`),
  );

  // Fail-closed: any route we could not statically resolve.
  for (const u of unresolved) {
    violations.push({
      kind: 'unresolved-route',
      detail: `${u.controller}:${u.line} — ${u.reason} (fail-closed; cannot classify)`,
    });
  }

  // Index OpenAPI ops by "METHOD pathForm".
  const opIndex = new Set<string>();
  for (const o of ops) for (const c of o.pathForms) opIndex.add(`${o.method} ${c}`);

  // D3 classification (default-deny) + D1 coverage.
  for (const r of routes) {
    const cls = classify(r, manifest);
    if (cls === null) {
      violations.push({
        kind: 'unclassified-route',
        detail: `${r.method} ${r.path} (${r.controller}:${r.line}) has no manifest classification`,
      });
      continue;
    }
    if (!known.has(cls)) {
      violations.push({
        kind: 'unknown-class',
        detail: `${r.method} ${r.path} classified as unknown class "${cls}"`,
      });
      continue;
    }
    if (!governed.has(cls)) continue; // exempt (IZ)
    const documented = opIndex.has(`${r.method} ${r.path}`);
    const inDebt = transitional.has(`${r.method} ${r.path}`);
    if (!documented && !inDebt) {
      violations.push({
        kind: 'governed-route-undocumented',
        detail: `${r.method} ${r.path} (${cls}, ${r.controller}:${r.line}) is governed but has no OpenAPI operation and is not in transitionalUndocumented`,
      });
    }
  }

  // D2 orphans — every OpenAPI op must resolve to a live handler.
  const liveIndex = new Set(routes.map((r) => `${r.method} ${r.path}`));
  for (const o of ops) {
    const matched = o.pathForms.some((c) => liveIndex.has(`${o.method} ${c}`));
    if (!matched) {
      violations.push({
        kind: 'openapi-orphan',
        detail: `${o.method} ${o.rawPath} (${o.spec}) documents no live handler`,
      });
    }
  }

  return violations;
}

// ── Embedded selftest (isolated fixtures) ────────────────────────────────────────────────
function selftest(): void {
  const mani: Manifest = {
    governed: ['XP', 'AP', 'SS', 'AD', 'PZ'],
    exempt: ['IZ'],
    controllers: {
      'x/foo.controller.ts': 'AP',
      'x/health.controller.ts': 'IZ',
      'x/web.controller.ts': 'XP',
    },
    routeOverrides: [],
    transitionalUndocumented: [{ method: 'GET', path: '/v1/foo/debt' }],
  };
  const route = (method: string, path: string, controller: string, line = 1): LiveRoute => ({
    method,
    path: normalizePath(path),
    rawPath: path,
    controller,
    line,
  });
  const op = (method: string, pathKey: string, base = ''): OpenApiOp => ({
    method,
    pathForms: base
      ? [normalizePath(pathKey), normalizePath(base + '/' + pathKey)]
      : [normalizePath(pathKey)],
    spec: 'openapi/x.yaml',
    rawPath: pathKey,
  });
  const has = (vs: Violation[], kind: Violation['kind']): boolean =>
    vs.some((v) => v.kind === kind);

  // A. governed route missing OpenAPI and not in debt → D1 fail.
  const a = validate([route('GET', '/v1/foo/new', 'x/foo.controller.ts')], [], [], mani);
  // B. OpenAPI orphan.
  const b = validate([], [], [op('GET', '/v1/nope')], mani);
  // C. unclassified live route.
  const c = validate([route('GET', '/v1/bar', 'x/unknown.controller.ts')], [], [], mani);
  // D. transitional debt accepted (no violation).
  const d = validate([route('GET', '/v1/foo/debt', 'x/foo.controller.ts')], [], [], mani);
  // E. new route cannot silently enter debt (a governed route NOT in the debt set fails).
  const e = validate([route('POST', '/v1/foo/fresh', 'x/foo.controller.ts')], [], [], mani);
  // F. param-name normalization: live :id matches documented {id}.
  const f = validate(
    [route('GET', '/v1/foo/:id', 'x/foo.controller.ts')],
    [],
    [op('GET', '/v1/foo/{id}')],
    mani,
  );
  // G. method mismatch fails (live GET, only POST documented).
  const g = validate(
    [route('GET', '/v1/foo/x', 'x/foo.controller.ts')],
    [],
    [op('POST', '/v1/foo/x')],
    mani,
  );
  // H. IZ route is exempt (no D1 obligation).
  const h = validate([route('GET', '/healthz', 'x/health.controller.ts')], [], [], mani);
  // servers-base composition: documented under /v1 servers base, live carries /v1.
  const s = validate(
    [route('POST', '/v1/consent/grant', 'x/foo.controller.ts')],
    [],
    [op('POST', '/consent/grant', '/v1')],
    mani,
  );
  // fail-closed on unresolved.
  const u = validate(
    [],
    [{ controller: 'x/foo.controller.ts', line: 9, reason: 'non-literal' }],
    [],
    mani,
  );

  const checks: Array<[string, boolean]> = [
    ['A governed-undocumented detected', has(a, 'governed-route-undocumented')],
    ['B orphan detected', has(b, 'openapi-orphan')],
    ['C unclassified detected', has(c, 'unclassified-route')],
    ['D debt accepted (no violation)', d.length === 0],
    ['E new route not silently in debt', has(e, 'governed-route-undocumented')],
    ['F :id ↔ {id} normalized match (green)', f.length === 0],
    [
      'G method mismatch fails both directions',
      has(g, 'governed-route-undocumented') && has(g, 'openapi-orphan'),
    ],
    ['H IZ exempt (green)', h.length === 0],
    ['servers-base /v1 composition matches (green)', s.length === 0],
    ['fail-closed on unresolved', has(u, 'unresolved-route')],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (failed.length > 0) {
    console.error('SELFTEST FAILED — checker vacuous for: ' + failed.join('; '));
    process.exit(2);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
function main(): void {
  const args = process.argv.slice(2);
  const { routes, unresolved } = extractLiveRoutes();
  const ops = extractOpenApiOps();

  if (args.includes('--dump')) {
    const manifestExists = (() => {
      try {
        loadManifest();
        return true;
      } catch {
        return false;
      }
    })();
    const byController: Record<string, string[]> = {};
    for (const r of routes) (byController[r.controller] ??= []).push(`${r.method} ${r.path}`);
    console.log(
      JSON.stringify(
        {
          liveRouteCount: routes.length,
          openApiOpCount: ops.length,
          unresolvedCount: unresolved.length,
          manifestExists,
          controllers: Object.keys(byController).sort(),
          routes: routes.map((r) => `${r.method} ${r.path}`).sort(),
          ops: [...new Set(ops.flatMap((o) => o.pathForms.map((c) => `${o.method} ${c}`)))].sort(),
          byController,
        },
        null,
        2,
      ),
    );
    return;
  }

  selftest();
  const manifest = loadManifest();
  const violations = validate(routes, unresolved, ops, manifest);
  const governedCount = routes.filter((r) =>
    manifest.governed.includes(classify(r, manifest) ?? ''),
  ).length;
  if (violations.length > 0) {
    const byKind = violations.reduce<Record<string, number>>(
      (a, v) => ((a[v.kind] = (a[v.kind] ?? 0) + 1), a),
      {},
    );
    console.error('✗ api-contract-parity violations:');
    for (const v of violations) console.error(`  - [${v.kind}] ${v.detail}`);
    console.error(
      `\nSummary: ${JSON.stringify(byKind)} · ${routes.length} live routes · ${ops.length} OpenAPI ops.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ api-contract-parity: ${routes.length} live routes (${governedCount} governed) · ${ops.length} OpenAPI ops · ` +
      `${manifest.transitionalUndocumented.length} transitional-debt · 0 orphan · 0 unclassified.`,
  );
}

main();
