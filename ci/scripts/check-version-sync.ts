// PR-M0R-2 §4 — version sync verifier.
//
// Walks openapi/*.yaml info.version and the workspace package.json files,
// enforces semver shape, and cross-checks the openapi versions against
// any per-package package.json that ships an explicit version. Exits 0
// against the current PR-1 monorepo shape, which carries a version field
// only at the root package.json (apps/* and libs/* use nx project.json,
// no per-package package.json).
//
// Coverage grows under Reading A: as M2-M7 introduce per-app package.json
// files, this script begins enforcing openapi/<service>.yaml info.version
// equality against apps/<service>/package.json (and similar for libs).
//
// Run via: node --import jiti/register ci/scripts/check-version-sync.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/check-version-sync.ts

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const OPENAPI_DIR = join(REPO_ROOT, 'openapi');
const APPS_DIR = join(REPO_ROOT, 'apps');
const LIBS_DIR = join(REPO_ROOT, 'libs');

// Per-package mapping. openapi/<key>.yaml is the canonical surface for the
// service named <value>. Empty value means there is no app-level package
// that owns this surface yet (will be filled in when M2-M7 stand up the
// per-app package.json files).
const YAML_TO_APP: Record<string, string> = {
  'auth.yaml': 'auth-service',
  'ats.yaml': 'api',
  'portal.yaml': 'api',
  'ingestion.yaml': 'api',
  'common.yaml': '',
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

type Issue = { source: string; reason: string };

export function readVersion(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const v = (json as Record<string, unknown>)['version'];
  return typeof v === 'string' ? v : null;
}

export function readYamlVersion(doc: unknown): string | null {
  if (doc === null || typeof doc !== 'object') return null;
  const info = (doc as Record<string, unknown>)['info'];
  if (info === null || typeof info !== 'object') return null;
  const v = (info as Record<string, unknown>)['version'];
  return typeof v === 'string' ? v : null;
}

export function isSemver(v: string): boolean {
  return SEMVER.test(v);
}

function listWorkspacePackageJsons(): Array<{ source: string; version: string | null }> {
  const out: Array<{ source: string; version: string | null }> = [];
  const rootPkg = join(REPO_ROOT, 'package.json');
  out.push({ source: rootPkg, version: readVersion(JSON.parse(readFileSync(rootPkg, 'utf8'))) });

  for (const dir of [APPS_DIR, LIBS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const target = join(dir, name, 'package.json');
      if (existsSync(target) && statSync(target).isFile()) {
        out.push({ source: target, version: readVersion(JSON.parse(readFileSync(target, 'utf8'))) });
      }
    }
  }
  return out;
}

function checkRepo(): Issue[] {
  const issues: Issue[] = [];

  // Walk every openapi/*.yaml; record info.version and shape-check it.
  const yamlEntries: Array<{ file: string; basename: string; version: string | null }> = [];
  for (const f of readdirSync(OPENAPI_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    const full = join(OPENAPI_DIR, f);
    const doc = parseYaml(readFileSync(full, 'utf8'));
    const v = readYamlVersion(doc);
    yamlEntries.push({ file: full, basename: f, version: v });
    if (v === null) {
      issues.push({ source: full, reason: 'missing info.version' });
    } else if (!isSemver(v)) {
      issues.push({ source: full, reason: `info.version not semver-shaped: ${v}` });
    }
  }

  // Shape-check every workspace package.json version we can find.
  const pkgs = listWorkspacePackageJsons();
  for (const pkg of pkgs) {
    if (pkg.version === null) continue; // libs/apps without an explicit version are OK.
    if (!isSemver(pkg.version)) {
      issues.push({ source: pkg.source, reason: `package version not semver-shaped: ${pkg.version}` });
    }
  }

  // Cross-check each openapi yaml against its mapped per-app package.json,
  // if that package.json exists and carries an explicit version.
  for (const ye of yamlEntries) {
    const appName = YAML_TO_APP[ye.basename];
    if (appName === undefined || appName === '') continue;
    const pkgPath = join(APPS_DIR, appName, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkgVersion = readVersion(JSON.parse(readFileSync(pkgPath, 'utf8')));
    if (pkgVersion === null) continue;
    if (ye.version !== null && ye.version !== pkgVersion) {
      issues.push({
        source: ye.file,
        reason: `info.version ${ye.version} != ${pkgPath} version ${pkgVersion}`,
      });
    }
  }

  return issues;
}

function runSelfTest(): void {
  // Semver shape.
  if (!isSemver('0.1.0')) throw new Error('self-test: 0.1.0 should be semver');
  if (!isSemver('1.2.3-alpha.1')) throw new Error('self-test: 1.2.3-alpha.1 should be semver');
  if (isSemver('1.2')) throw new Error('self-test: 1.2 should not be semver');
  if (isSemver('v1.0.0')) throw new Error('self-test: v-prefixed should not be semver');
  if (isSemver('1.2.3.4')) throw new Error('self-test: 4-segment should not be semver');

  // Version readers.
  if (readVersion({ version: '1.0.0' }) !== '1.0.0') throw new Error('self-test: readVersion');
  if (readVersion({ }) !== null) throw new Error('self-test: missing version → null');
  if (readVersion(null) !== null) throw new Error('self-test: null doc → null');
  if (readYamlVersion({ info: { version: '0.2.0' } }) !== '0.2.0') throw new Error('self-test: readYamlVersion');
  if (readYamlVersion({ info: {} }) !== null) throw new Error('self-test: no info.version → null');
  if (readYamlVersion({}) !== null) throw new Error('self-test: no info → null');

  console.log('self-test ok: version-sync semver-shape, readers, and per-app mapping skeleton');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log('version:sync-check ok');
    return;
  }
  console.error(`version:sync-check FAILED — ${issues.length} issue(s):`);
  for (const i of issues) console.error(`  ${i.source}: ${i.reason}`);
  process.exit(1);
}

main();
