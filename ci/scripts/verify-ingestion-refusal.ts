// PR-14 §4.1 — Ingestion refusal enforcement.
//
// Walks every schema reachable from openapi/ingestion.yaml (components.schemas
// and inline path schemas) and enforces:
//
//   1. additionalProperties: false on every object schema (closed envelope —
//      no silent leakage of fields not in the locked contract).
//   2. No property name matches the Ingestion forbidden-field list:
//        - exact:  score, internal_reasoning, entrustability_tier_raw
//                  (Charter R10 — no evaluation outputs / no internal reasoning
//                   exposure on ingestion schemas)
//        - prefix: override_*  (Charter R8 — no recruiter-judgment override
//                               of system classification through ingestion)
//                  evaluation_, rank_  (R10 evaluation-class extensions)
//   3. CONST_FALSE_INVARIANTS — where a schema declares a
//      `linkedin_automation_allowed` property, its value MUST be
//      const false (API Contracts v1.0 Phase 4 — Layer 4 of the four-layer
//      LinkedIn refusal: SourcePolicyResponse.linkedin_automation_allowed
//      const: false. The directive §4.1 establishes this as the CI tripwire
//      enforcing R7 Layer 4: if a future change flips the property away from
//      const:false, the refusal-check fails).
//
// Mirrors the verify-portal-refusal.ts / verify-ats-refusal.ts pattern
// (audit C4). verify-ats-refusal.ts's CONST_FALSE_INVARIANTS mechanism on
// examination_mutated is the direct precedent for the
// linkedin_automation_allowed invariant here.
//
// Run via: node --import jiti/register ci/scripts/verify-ingestion-refusal.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/verify-ingestion-refusal.ts

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const INGESTION_YAML = join(REPO_ROOT, 'openapi', 'ingestion.yaml');

export const FORBIDDEN_EXACT: ReadonlyArray<string> = [
  'score',
  'internal_reasoning',
  'entrustability_tier_raw',
];

export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
  'override_',
  'evaluation_',
  'rank_',
];

export const CONST_FALSE_INVARIANTS: ReadonlyArray<string> = [
  'linkedin_automation_allowed',
];

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
        // Phase 4 R7 Layer 4 invariant: when this name appears, its schema
        // must pin const: false (any other shape weakens the refusal).
        const constVal = sub['const'];
        const enumVal = sub['enum'];
        const isPinnedFalse =
          constVal === false ||
          (Array.isArray(enumVal) && enumVal.length === 1 && enumVal[0] === false);
        if (!isPinnedFalse) {
          issues.push({
            path: `${path}.properties.${name}`,
            reason: `${name} must be pinned const: false (Phase 4 R7 Layer 4 — no LinkedIn automation path)`,
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

function walkRequestsAndResponses(doc: Record<string, unknown>, issues: Issue[]): void {
  const paths = doc['paths'];
  if (!isObjectSchema(paths)) return;
  for (const [p, pathItem] of Object.entries(paths)) {
    if (!isObjectSchema(pathItem)) continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!isObjectSchema(op)) continue;
      const requestBody = op['requestBody'];
      if (isObjectSchema(requestBody)) {
        const content = requestBody['content'];
        if (isObjectSchema(content)) {
          for (const [mt, mtObj] of Object.entries(content)) {
            if (!isObjectSchema(mtObj)) continue;
            checkSchema(
              mtObj['schema'],
              `paths.${p}.${method}.requestBody.content.${mt}.schema`,
              issues,
            );
          }
        }
      }
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
  const doc = parseYaml(readFileSync(INGESTION_YAML, 'utf8'));
  if (!isObjectSchema(doc)) return [{ path: INGESTION_YAML, reason: 'document is not an object' }];
  const issues: Issue[] = [];
  walkComponents(doc, issues);
  walkRequestsAndResponses(doc, issues);
  return issues;
}

function runSelfTest(): void {
  // 1. Clean closed schema → no issues.
  const clean = {
    components: {
      schemas: {
        Payload: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } },
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

  // 4. evaluation_ prefix forbidden.
  const evalPrefix = {
    components: {
      schemas: {
        Payload: { type: 'object', additionalProperties: false, properties: { evaluation_tier: { type: 'string' } } },
      },
    },
  };
  const evalIssues: Issue[] = [];
  walkComponents(evalPrefix, evalIssues);
  if (!evalIssues.some((i) => i.reason.includes('evaluation_tier'))) throw new Error('self-test: evaluation_ prefix not flagged');

  // 5. override_ prefix forbidden.
  const override = {
    components: {
      schemas: {
        Payload: { type: 'object', additionalProperties: false, properties: { override_source: { type: 'string' } } },
      },
    },
  };
  const overrideIssues: Issue[] = [];
  walkComponents(override, overrideIssues);
  if (!overrideIssues.some((i) => i.reason.includes('override_source'))) throw new Error('self-test: override_ prefix not flagged');

  // 6. linkedin_automation_allowed without const:false → issue.
  const unpinned = {
    components: {
      schemas: {
        Policy: { type: 'object', additionalProperties: false, properties: { linkedin_automation_allowed: { type: 'boolean' } } },
      },
    },
  };
  const unpinnedIssues: Issue[] = [];
  walkComponents(unpinned, unpinnedIssues);
  if (!unpinnedIssues.some((i) => i.reason.includes('const: false'))) {
    throw new Error('self-test: linkedin_automation_allowed without const:false not flagged');
  }

  // 7. linkedin_automation_allowed pinned to const false accepted.
  const pinned = {
    components: {
      schemas: {
        Policy: { type: 'object', additionalProperties: false, properties: { linkedin_automation_allowed: { type: 'boolean', const: false } } },
      },
    },
  };
  const pinnedIssues: Issue[] = [];
  walkComponents(pinned, pinnedIssues);
  if (pinnedIssues.length !== 0) {
    throw new Error(`self-test: linkedin_automation_allowed:const:false rejected: ${JSON.stringify(pinnedIssues)}`);
  }

  // 8. Forbidden field in inline request body → issue (walkRequestsAndResponses).
  const inlineReq = {
    paths: {
      '/x': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: false, properties: { score: { type: 'number' } } },
              },
            },
          },
          responses: {},
        },
      },
    },
  };
  const inlineReqIssues: Issue[] = [];
  walkRequestsAndResponses(inlineReq, inlineReqIssues);
  if (!inlineReqIssues.some((i) => i.reason.includes('score'))) {
    throw new Error('self-test: inline request body forbidden field not flagged');
  }

  console.log('self-test ok: ingestion-refusal-check catches score/override_/evaluation_/open envelope; enforces linkedin_automation_allowed const:false invariant');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log(`ingestion:refusal-check ok (${INGESTION_YAML})`);
    return;
  }
  console.error(`ingestion:refusal-check FAILED — ${issues.length} violation(s):`);
  for (const i of issues) console.error(`  ${i.path}: ${i.reason}`);
  process.exit(1);
}

main();
