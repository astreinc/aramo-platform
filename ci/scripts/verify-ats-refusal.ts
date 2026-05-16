// PR-M0R-2 §4 — ATS refusal enforcement.
//
// Walks every schema reachable from openapi/ats.yaml (components.schemas and
// inline path schemas) and enforces:
//
//   1. additionalProperties: false on every object schema.
//   2. No property name matches the ATS forbidden-field list:
//        - prefix: override_*  (Charter R8 — no recruiter-judgment override
//                               of system classification, per PR-M0R-2 §7
//                               which maps R8 to BOTH portal and ATS scripts)
//        - exact:  score       (API Contracts v1.0 Phase 6 — "ATS: no raw
//                               scores exposed; score field absent from any
//                               response schema")
//   3. Where a schema declares an `examination_mutated` property, its value
//      must be const false (API Contracts v1.0 Phase 6 — "ATS: no tier
//      mutation via override; examination_mutated const false verified by
//      ats refusal check").
//
// Exits 0 against the current paths: {} components.schemas: {} stub.
// Enforces as M2-M6 populate ATS schemas. Charter R7 ingestion refusals
// against third-party professional-network sources are enforced via API
// absence, not schema (directive §7).
//
// Run via: node --import jiti/register ci/scripts/verify-ats-refusal.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/verify-ats-refusal.ts

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const ATS_YAML = join(REPO_ROOT, 'openapi', 'ats.yaml');

export const FORBIDDEN_EXACT: ReadonlyArray<string> = ['score'];
export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = ['override_'];
export const CONST_FALSE_INVARIANTS: ReadonlyArray<string> = ['examination_mutated'];

type Issue = { path: string; reason: string };

export function isObjectSchema(node: unknown): node is Record<string, unknown> {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}

export function isForbiddenPropertyName(name: string): { hit: boolean; reason?: string } {
  if (FORBIDDEN_EXACT.includes(name)) return { hit: true, reason: `exact-match forbidden field: ${name}` };
  for (const p of FORBIDDEN_PREFIXES) {
    if (name.startsWith(p)) return { hit: true, reason: `forbidden prefix ${p}*: ${name}` };
  }
  return { hit: false };
}

export function checkSchema(schema: unknown, path: string, issues: Issue[]): void {
  if (!isObjectSchema(schema)) return;

  const type = schema['type'];
  const properties = schema['properties'];
  const isObjectShaped = type === 'object' || isObjectSchema(properties);
  if (isObjectShaped) {
    const addl = schema['additionalProperties'];
    if (addl !== false) {
      issues.push({ path, reason: `object schema must set additionalProperties: false (got ${JSON.stringify(addl)})` });
    }
  }

  if (isObjectSchema(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      const hit = isForbiddenPropertyName(name);
      if (hit.hit) issues.push({ path: `${path}.properties.${name}`, reason: hit.reason! });

      if (CONST_FALSE_INVARIANTS.includes(name) && isObjectSchema(sub)) {
        // Phase 6 invariant: when this name appears, its schema must pin
        // const: false (any other shape is a tier-mutation surface).
        const constVal = sub['const'];
        const enumVal = sub['enum'];
        const isPinnedFalse =
          constVal === false ||
          (Array.isArray(enumVal) && enumVal.length === 1 && enumVal[0] === false);
        if (!isPinnedFalse) {
          issues.push({
            path: `${path}.properties.${name}`,
            reason: `${name} must be pinned const: false (Phase 6 — no tier mutation via override)`,
          });
        }
      }

      checkSchema(sub, `${path}.properties.${name}`, issues);
    }
  }

  for (const key of ['items', 'additionalProperties'] as const) {
    if (isObjectSchema(schema[key])) checkSchema(schema[key], `${path}.${key}`, issues);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) arr.forEach((s, i) => checkSchema(s, `${path}.${key}[${i}]`, issues));
  }
}

function walkComponents(doc: Record<string, unknown>, issues: Issue[]): void {
  const components = doc['components'];
  if (!isObjectSchema(components)) return;
  const schemas = components['schemas'];
  if (!isObjectSchema(schemas)) return;
  for (const [name, schema] of Object.entries(schemas)) checkSchema(schema, `components.schemas.${name}`, issues);
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
          checkSchema(
            mtObj['schema'],
            `paths.${p}.${method}.responses.${status}.content.${mt}.schema`,
            issues,
          );
        }
      }
    }
  }
}

function checkRepo(): Issue[] {
  const doc = parseYaml(readFileSync(ATS_YAML, 'utf8'));
  if (!isObjectSchema(doc)) return [{ path: ATS_YAML, reason: 'document is not an object' }];
  const issues: Issue[] = [];
  walkComponents(doc, issues);
  walkResponses(doc, issues);
  return issues;
}

function runSelfTest(): void {
  // 1. Clean closed schema → no issues.
  const clean = {
    components: {
      schemas: {
        Submission: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
      },
    },
  };
  const cleanIssues: Issue[] = [];
  walkComponents(clean, cleanIssues);
  if (cleanIssues.length !== 0) throw new Error(`self-test: clean schema flagged: ${JSON.stringify(cleanIssues)}`);

  // 2. Open envelope → issue.
  const open = { components: { schemas: { Foo: { type: 'object', properties: {} } } } };
  const openIssues: Issue[] = [];
  walkComponents(open, openIssues);
  if (openIssues.length === 0) throw new Error('self-test: open envelope not flagged');

  // 3. score field forbidden.
  const scored = {
    components: {
      schemas: {
        Match: { type: 'object', additionalProperties: false, properties: { score: { type: 'number' } } },
      },
    },
  };
  const scoredIssues: Issue[] = [];
  walkComponents(scored, scoredIssues);
  if (!scoredIssues.some((i) => i.reason.includes('score'))) throw new Error('self-test: score not flagged');

  // 4. override_* prefix forbidden.
  const override = {
    components: {
      schemas: {
        Submission: { type: 'object', additionalProperties: false, properties: { override_tier: { type: 'string' } } },
      },
    },
  };
  const overrideIssues: Issue[] = [];
  walkComponents(override, overrideIssues);
  if (!overrideIssues.some((i) => i.reason.includes('override_tier'))) throw new Error('self-test: override_ prefix not flagged');

  // 5. examination_mutated must be const false.
  const unpinned = {
    components: {
      schemas: {
        Examination: { type: 'object', additionalProperties: false, properties: { examination_mutated: { type: 'boolean' } } },
      },
    },
  };
  const unpinnedIssues: Issue[] = [];
  walkComponents(unpinned, unpinnedIssues);
  if (!unpinnedIssues.some((i) => i.reason.includes('const: false'))) {
    throw new Error('self-test: examination_mutated without const:false not flagged');
  }

  // 6. examination_mutated pinned to const false accepted.
  const pinned = {
    components: {
      schemas: {
        Examination: { type: 'object', additionalProperties: false, properties: { examination_mutated: { const: false } } },
      },
    },
  };
  const pinnedIssues: Issue[] = [];
  walkComponents(pinned, pinnedIssues);
  if (pinnedIssues.length !== 0) {
    throw new Error(`self-test: examination_mutated:const:false rejected: ${JSON.stringify(pinnedIssues)}`);
  }

  console.log('self-test ok: ats-refusal-check catches score/override_/open envelope; enforces examination_mutated invariant');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`ats:refusal-check ok (${ATS_YAML})`);
    return;
  }
  console.error(`ats:refusal-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.path}: ${i.reason}`);
  process.exit(1);
}

main();
