// PR-M0R-2 §4 — Portal refusal enforcement.
//
// Walks every schema reachable from openapi/portal.yaml (components.schemas
// and inline path schemas) and enforces:
//
//   1. additionalProperties: false on every object schema (closed envelope —
//      no silent leakage of fields not in the locked contract).
//   2. No property name matches the Portal forbidden-field list, derived
//      from Charter v1.0 refusals and the PR-M0R-2 directive §4:
//        - exact:  internal_reasoning, entrustability_tier_raw
//                  (Charter R10 — no internal-reasoning/eval-output exposure)
//        - prefix: override_*  (Charter R8 — no recruiter-judgment overrides
//                               of system classification, surfaced to talent)
//                  recruiter_* (recruiter-only fields must not bleed into
//                               candidate-facing endpoints — PR-M0R-2 §4)
//
// Exits 0 against the current paths: {} components.schemas: {} stub.
// Enforces as M2-M6 populate Portal schemas. Out of scope for this script:
// LinkedIn ingestion refusals (enforced via API absence, not schema —
// directive §7).
//
// Run via: node --import jiti/register ci/scripts/verify-portal-refusal.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/verify-portal-refusal.ts

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const PORTAL_YAML = join(REPO_ROOT, 'openapi', 'portal.yaml');

export const FORBIDDEN_EXACT: ReadonlyArray<string> = [
  'internal_reasoning',
  'entrustability_tier_raw',
];

export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
  'override_',
  'recruiter_',
];

type Issue = { path: string; reason: string };

export function isObjectSchema(node: unknown): node is Record<string, unknown> {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

export function isForbiddenPropertyName(name: string): { hit: boolean; reason?: string } {
  if (FORBIDDEN_EXACT.includes(name)) {
    return { hit: true, reason: `exact-match forbidden field: ${name}` };
  }
  for (const p of FORBIDDEN_PREFIXES) {
    if (name.startsWith(p)) return { hit: true, reason: `forbidden prefix ${p}*: ${name}` };
  }
  return { hit: false };
}

export function checkSchema(schema: unknown, path: string, issues: Issue[]): void {
  if (!isObjectSchema(schema)) return;

  // Object schemas must explicitly close the envelope.
  const type = schema['type'];
  const properties = schema['properties'];
  const isObjectShaped = type === 'object' || isObjectSchema(properties);
  if (isObjectShaped) {
    const addl = schema['additionalProperties'];
    if (addl !== false) {
      issues.push({ path, reason: `object schema must set additionalProperties: false (got ${JSON.stringify(addl)})` });
    }
  }

  // Property names: forbidden-field check.
  if (isObjectSchema(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      const hit = isForbiddenPropertyName(name);
      if (hit.hit) issues.push({ path: `${path}.properties.${name}`, reason: hit.reason! });
      checkSchema(sub, `${path}.properties.${name}`, issues);
    }
  }

  // Recurse into common schema composition keys.
  for (const key of ['items', 'additionalProperties'] as const) {
    if (isObjectSchema(schema[key])) checkSchema(schema[key], `${path}.${key}`, issues);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      arr.forEach((s, i) => checkSchema(s, `${path}.${key}[${i}]`, issues));
    }
  }
}

function walkResponses(doc: Record<string, unknown>, issues: Issue[]): void {
  const paths = doc['paths'];
  if (!isObjectSchema(paths)) return;
  for (const [p, pathItem] of Object.entries(paths)) {
    if (!isObjectSchema(pathItem)) continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!isObjectSchema(op)) continue;
      const responses = op['responses'];
      if (!isObjectSchema(responses)) continue;
      for (const [status, resp] of Object.entries(responses)) {
        if (!isObjectSchema(resp)) continue;
        const content = resp['content'];
        if (!isObjectSchema(content)) continue;
        for (const [mt, mtObj] of Object.entries(content)) {
          if (!isObjectSchema(mtObj)) continue;
          const schema = mtObj['schema'];
          checkSchema(schema, `paths.${p}.${method}.responses.${status}.content.${mt}.schema`, issues);
        }
      }
    }
  }
}

function walkComponents(doc: Record<string, unknown>, issues: Issue[]): void {
  const components = doc['components'];
  if (!isObjectSchema(components)) return;
  const schemas = components['schemas'];
  if (!isObjectSchema(schemas)) return;
  for (const [name, schema] of Object.entries(schemas)) {
    checkSchema(schema, `components.schemas.${name}`, issues);
  }
}

function checkRepo(): Issue[] {
  const doc = parseYaml(readFileSync(PORTAL_YAML, 'utf8'));
  if (!isObjectSchema(doc)) return [{ path: PORTAL_YAML, reason: 'document is not an object' }];
  const issues: Issue[] = [];
  walkComponents(doc, issues);
  walkResponses(doc, issues);
  return issues;
}

function runSelfTest(): void {
  // 1. Closed envelope honored; no forbidden fields → no issues.
  const good = {
    components: {
      schemas: {
        Foo: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
      },
    },
  };
  const goodIssues: Issue[] = [];
  walkComponents(good, goodIssues);
  if (goodIssues.length !== 0) throw new Error(`self-test: clean schema reported issues: ${JSON.stringify(goodIssues)}`);

  // 2. Missing additionalProperties: false → issue.
  const open = {
    components: { schemas: { Foo: { type: 'object', properties: { id: { type: 'string' } } } } },
  };
  const openIssues: Issue[] = [];
  walkComponents(open, openIssues);
  if (openIssues.length === 0) throw new Error('self-test: open envelope not flagged');

  // 3. Forbidden exact field → issue.
  const reasoning = {
    components: {
      schemas: {
        Foo: { type: 'object', additionalProperties: false, properties: { internal_reasoning: { type: 'string' } } },
      },
    },
  };
  const reasoningIssues: Issue[] = [];
  walkComponents(reasoning, reasoningIssues);
  if (!reasoningIssues.some((i) => i.reason.includes('internal_reasoning'))) {
    throw new Error('self-test: internal_reasoning not flagged');
  }

  // 4. Forbidden prefix → issue.
  for (const name of ['override_classification', 'recruiter_notes']) {
    const doc = {
      components: {
        schemas: {
          Foo: { type: 'object', additionalProperties: false, properties: { [name]: { type: 'string' } } },
        },
      },
    };
    const issues: Issue[] = [];
    walkComponents(doc, issues);
    if (!issues.some((i) => i.reason.includes(name))) {
      throw new Error(`self-test: forbidden prefix not flagged: ${name}`);
    }
  }

  // 5. Forbidden field in inline response schema → issue (walkResponses).
  const inline = {
    paths: {
      '/x': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', additionalProperties: false, properties: { entrustability_tier_raw: { type: 'number' } } },
                },
              },
            },
          },
        },
      },
    },
  };
  const inlineIssues: Issue[] = [];
  walkResponses(inline, inlineIssues);
  if (!inlineIssues.some((i) => i.reason.includes('entrustability_tier_raw'))) {
    throw new Error('self-test: inline response forbidden field not flagged');
  }

  console.log('self-test ok: portal-refusal-check catches forbidden fields and open envelopes');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`portal:refusal-check ok (${PORTAL_YAML})`);
    return;
  }
  console.error(`portal:refusal-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.path}: ${i.reason}`);
  process.exit(1);
}

main();
