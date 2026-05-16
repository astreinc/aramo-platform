// PR-M0R-2 §4 — drift-check.
//
// Walks openapi/*.yaml, resolves every $ref, and verifies the referenced
// schema (or path operation) exists in the target document. Exits non-zero
// on broken refs. Exits zero against the current PR-1 scaffolding (the
// only refs present today are intra-common and auth→common ErrorResponse).
//
// Run via: node --import jiti/register ci/scripts/compare-spec-to-openapi.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/compare-spec-to-openapi.ts

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const OPENAPI_DIR = join(REPO_ROOT, 'openapi');

type RefIssue = { file: string; ref: string; reason: string };

export function findRefs(node: unknown, refs: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return refs;
  if (Array.isArray(node)) {
    for (const item of node) findRefs(item, refs);
    return refs;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') refs.push(value);
    else findRefs(value, refs);
  }
  return refs;
}

function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  // RFC 6901 — leading '/', segments separated by '/', ~1 → '/', ~0 → '~'.
  if (pointer === '' || pointer === '/') return doc;
  const segments = pointer.replace(/^\//, '').split('/').map((s) =>
    s.replace(/~1/g, '/').replace(/~0/g, '~'),
  );
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function verifyRef(
  ref: string,
  fromFile: string,
  loadedDocs: Map<string, unknown>,
): RefIssue | null {
  const hashIdx = ref.indexOf('#');
  if (hashIdx < 0) {
    return { file: fromFile, ref, reason: 'ref missing fragment (#)' };
  }
  const filePart = ref.slice(0, hashIdx);
  const fragment = ref.slice(hashIdx + 1);
  const targetFile = filePart === '' ? fromFile : join(OPENAPI_DIR, filePart);
  const targetDoc = loadedDocs.get(targetFile);
  if (targetDoc === undefined) {
    return { file: fromFile, ref, reason: `target file not loaded: ${filePart || '(self)'}` };
  }
  const resolved = resolveJsonPointer(targetDoc, fragment);
  if (resolved === undefined) {
    return { file: fromFile, ref, reason: `pointer does not resolve: ${fragment}` };
  }
  return null;
}

function checkRepo(): RefIssue[] {
  const yamlFiles = readdirSync(OPENAPI_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => join(OPENAPI_DIR, f));

  const loaded = new Map<string, unknown>();
  for (const f of yamlFiles) loaded.set(f, parseYaml(readFileSync(f, 'utf8')));

  const issues: RefIssue[] = [];
  for (const f of yamlFiles) {
    const refs = findRefs(loaded.get(f));
    for (const ref of refs) {
      const issue = verifyRef(ref, f, loaded);
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function runSelfTest(): void {
  // Forbidden-field-list-logic equivalent for drift-check: verify the
  // resolver detects a broken ref. Synthetic schema; current repo state
  // not touched.
  const broken = {
    paths: { '/x': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } } } } } } },
    components: { schemas: { Present: { type: 'string' } } },
  };
  const refs = findRefs(broken);
  if (refs.length !== 1) throw new Error(`self-test: expected 1 ref, got ${refs.length}`);
  const loaded = new Map<string, unknown>([['/synthetic.yaml', broken]]);
  const issue = verifyRef('#/components/schemas/Missing', '/synthetic.yaml', loaded);
  if (issue === null) throw new Error('self-test: expected broken ref, got none');
  const issue2 = verifyRef('#/components/schemas/Present', '/synthetic.yaml', loaded);
  if (issue2 !== null) throw new Error(`self-test: present ref reported broken: ${issue2.reason}`);
  console.log('self-test ok: drift-check detects broken refs and accepts valid refs');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`openapi:drift-check ok (${readdirSync(OPENAPI_DIR).filter((f) => f.endsWith('.yaml')).length} files)`);
    return;
  }
  console.error(`openapi:drift-check FAILED — ${issues.length} broken ref(s):`);
  for (const i of issues) console.error(`  ${i.file}: ${i.ref} — ${i.reason}`);
  process.exit(1);
}

main();
