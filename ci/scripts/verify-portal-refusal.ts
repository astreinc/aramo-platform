// PR-M0R-2 §4 — Portal refusal enforcement.
//
// Walks every schema reachable from openapi/portal.yaml (components.schemas
// and inline path schemas) and enforces:
//
//   1. additionalProperties: false on every object schema (closed envelope —
//      no silent leakage of fields not in the locked contract).
//   2. No property name matches the Portal forbidden-field list, derived
//      from Charter v1.0 refusals and PR-A0 directive §2 Ruling 1
//      (R10 portal hardening — the 13 names of record in doc/03-refusal-layer.md):
//        - exact:  internal_reasoning, entrustability_tier_raw,
//                  tier, rank, rank_ordinal, score, examination_id,
//                  why_matched_sentence, strengths, gaps, risk_flags,
//                  recruiter_notes, override_id, action_queue_item_id,
//                  internal_engagement_state
//                  (Charter R10 — no internal-reasoning/eval-output/ranking
//                   exposure on talent-facing surfaces)
//        - prefix: override_*  (Charter R8 — no recruiter-judgment overrides
//                               of system classification, surfaced to talent)
//                  recruiter_* (recruiter-only fields must not bleed into
//                               talent-facing endpoints — PR-M0R-2 §4)
//
//   3. Portal P1 PR-2b — the D3 TRUST-CLASS rule (Portal DDR P-R4 / P-R5).
//      Schemas named in the declared TRUST_CLASS_SCHEMAS allowlist (verification,
//      attestation, trust-statement, dispute-subject shapes) must NOT carry a
//      tenant-identifying or verifier-identifying field: tenant_name, tenant_id,
//      verifier, verified_by, or a verifying_* / origin_* prefix. This encodes
//      P-R5's origin-secrecy ruling — no candidate-facing surface ever renders a
//      verification joined to its producing tenant ("verified on Aramo", never
//      "verified by <tenant>"). The forbidden JOIN is made structurally
//      impossible because trust shapes carry no tenant field.
//
//      Scope is by SCHEMA NAME, deliberately: tenant_id is base-LEGAL on an
//      ENGAGEMENT surface (P-R5 — a candidate MAY see the counterparty they
//      knowingly engaged; PortalProfile.tenant_id is such a field) but FORBIDDEN
//      on a trust surface. The two regimes coexist; membership is the switch.
//
//      P1 ships NO trust surface, so TRUST_CLASS_SCHEMAS is EMPTY here — the
//      mechanism precedes the first surface per P-R4 ("becomes code the same day
//      the first trust surface exists"). P2+ adds members alongside their schemas.
//
// The exact-match list is a backstop, not the definition of safe: Portal
// response schemas are allowlist-shaped — every exposed field must be
// affirmatively justified against R10 as candidate-facing-safe (PR-A0 §2
// Ruling 2; see doc/06-lead-review-checklist.md).
//
// Exits 0 against the current paths: {} components.schemas: {} stub.
// Enforces as M2-M6 populate Portal schemas. Out of scope for this script:
// Charter R7 ingestion refusals against third-party professional-network
// sources (enforced via API absence, not schema — directive §7).
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
  'tier',
  'rank',
  'rank_ordinal',
  'score',
  'examination_id',
  'why_matched_sentence',
  'strengths',
  'gaps',
  'risk_flags',
  'recruiter_notes',
  'override_id',
  'action_queue_item_id',
  'internal_engagement_state',
];

export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
  'override_',
  'recruiter_',
];

// Portal P1 PR-2b — the D3 trust-class allowlist (Portal DDR P-R4 / P-R5).
// Schema NAMES of trust-surface shapes (verification, attestation,
// trust-statement, dispute-subject). EMPTY in P1: no trust surface exists yet;
// the origin-secrecy wall is code before the first surface it will ever guard.
// P2+ adds a member in the SAME commit as the schema it names — e.g.
// 'VerificationState', 'AttestationRecord', 'TrustStatement', 'DisputeSubject'.
export const TRUST_CLASS_SCHEMAS: ReadonlySet<string> = new Set<string>([
  // (intentionally empty in P1 — see the header note)
]);

// The tenant-/verifier-identifying fields forbidden ONLY within a trust-class
// schema (they are base-legal on engagement surfaces per P-R5).
export const TRUST_CLASS_FORBIDDEN_EXACT: ReadonlyArray<string> = [
  'tenant_name',
  'tenant_id',
  'verifier',
  'verified_by',
];

export const TRUST_CLASS_FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
  'verifying_',
  'origin_',
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

// Portal P1 PR-2b — the trust-class (origin-secrecy) predicate. Applied ONLY to
// schemas whose name is in TRUST_CLASS_SCHEMAS.
export function isTrustClassForbidden(name: string): { hit: boolean; reason?: string } {
  if (TRUST_CLASS_FORBIDDEN_EXACT.includes(name)) {
    return { hit: true, reason: `trust-class origin-secrecy forbidden field: ${name}` };
  }
  for (const p of TRUST_CLASS_FORBIDDEN_PREFIXES) {
    if (name.startsWith(p)) return { hit: true, reason: `trust-class forbidden prefix ${p}*: ${name}` };
  }
  return { hit: false };
}

// Recurse a trust-class schema (and its nested sub-schemas) enforcing the
// origin-secrecy field rule. Runs IN ADDITION to checkSchema's base rules — a
// trust-class schema is still a closed envelope with no R10 fields; it ALSO may
// carry no tenant-/verifier-identifying field.
export function checkTrustClassSchema(schema: unknown, path: string, issues: Issue[]): void {
  if (!isObjectSchema(schema)) return;

  const properties = schema['properties'];
  if (isObjectSchema(properties)) {
    for (const [name, sub] of Object.entries(properties)) {
      const hit = isTrustClassForbidden(name);
      if (hit.hit) issues.push({ path: `${path}.properties.${name}`, reason: hit.reason! });
      checkTrustClassSchema(sub, `${path}.properties.${name}`, issues);
    }
  }
  for (const key of ['items', 'additionalProperties'] as const) {
    if (isObjectSchema(schema[key])) checkTrustClassSchema(schema[key], `${path}.${key}`, issues);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      arr.forEach((s, i) => checkTrustClassSchema(s, `${path}.${key}[${i}]`, issues));
    }
  }
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

function walkComponents(
  doc: Record<string, unknown>,
  issues: Issue[],
  trustClass: ReadonlySet<string> = TRUST_CLASS_SCHEMAS,
): void {
  const components = doc['components'];
  if (!isObjectSchema(components)) return;
  const schemas = components['schemas'];
  if (!isObjectSchema(schemas)) return;
  for (const [name, schema] of Object.entries(schemas)) {
    checkSchema(schema, `components.schemas.${name}`, issues);
    // D3 trust-class rule: a named trust-surface schema also gets the
    // origin-secrecy field check. Membership is by schema name (P-R4/P-R5).
    if (trustClass.has(name)) {
      checkTrustClassSchema(schema, `components.schemas.${name}`, issues);
    }
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

  // 6. D3 trust-class — a trust-class member carrying tenant_id is flagged
  //    (the origin-secrecy join is forbidden on trust surfaces).
  const trustSet = new Set<string>(['TrustStatement']);
  const trustLeak = {
    components: {
      schemas: {
        TrustStatement: {
          type: 'object',
          additionalProperties: false,
          properties: { tenant_id: { type: 'string' } },
        },
      },
    },
  };
  const trustLeakIssues: Issue[] = [];
  walkComponents(trustLeak, trustLeakIssues, trustSet);
  if (!trustLeakIssues.some((i) => i.reason.includes('trust-class') && i.reason.includes('tenant_id'))) {
    throw new Error('self-test: trust-class tenant_id not flagged');
  }

  // 7. D3 trust-class — a verifying_* / origin_* prefix on a member is flagged.
  for (const name of ['verifying_tenant', 'origin_workflow_id', 'verified_by']) {
    const doc = {
      components: {
        schemas: {
          TrustStatement: {
            type: 'object',
            additionalProperties: false,
            properties: { [name]: { type: 'string' } },
          },
        },
      },
    };
    const issues: Issue[] = [];
    walkComponents(doc, issues, trustSet);
    if (!issues.some((i) => i.reason.includes('trust-class') && i.reason.includes(name))) {
      throw new Error(`self-test: trust-class field not flagged: ${name}`);
    }
  }

  // 8. D3 SCOPING — the SAME tenant_id on a NON-trust-class (engagement) schema
  //    is NOT flagged. This pins P-R5: PortalProfile.tenant_id stays legal.
  const engagementOk = {
    components: {
      schemas: {
        PortalProfile: {
          type: 'object',
          additionalProperties: false,
          properties: { tenant_id: { type: 'string' } },
        },
      },
    },
  };
  const engagementIssues: Issue[] = [];
  walkComponents(engagementOk, engagementIssues, trustSet); // 'PortalProfile' ∉ trustSet
  if (engagementIssues.length !== 0) {
    throw new Error(`self-test: engagement tenant_id wrongly flagged: ${JSON.stringify(engagementIssues)}`);
  }

  console.log(
    'self-test ok: portal-refusal-check catches forbidden fields, open envelopes, ' +
      'and D3 trust-class origin-secrecy leaks (scoped to declared trust schemas)',
  );
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
