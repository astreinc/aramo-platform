// PR-M0R-2 §4 — error code registry verifier.
//
// Walks the error code registry at libs/common/src/lib/errors/error-codes.ts
// (the TS tuple — source of truth) and enforces:
//
//   1. Shape: each code matches UPPER_SNAKE_CASE (^[A-Z][A-Z0-9_]*$).
//   2. Uniqueness: no duplicate codes in the tuple.
//   3. Parity with openapi/common.yaml#components.schemas.ErrorCode.enum
//      (same values, same order — mirrors the libs/common parity test).
//
// Out of scope (per directive §5): 36-of-36 completeness enforcement.
// That is Phase 5 work; this script verifies the codes that exist.
//
// Run via: node --import jiti/register ci/scripts/verify-error-codes.ts
// Self-test via: SELF_TEST=1 node --import jiti/register ci/scripts/verify-error-codes.ts

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const REGISTRY_TS = join(REPO_ROOT, 'libs', 'common', 'src', 'lib', 'errors', 'error-codes.ts');
const COMMON_YAML = join(REPO_ROOT, 'openapi', 'common.yaml');

const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/;

export function extractTsRegistry(source: string): string[] {
  // Match the ERROR_CODES tuple literal. We accept any export form
  // ("export const ERROR_CODES = [ ... ] as const;") and collect the
  // single-quoted entries inside.
  const m = source.match(/export\s+const\s+ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/);
  if (m === null || m[1] === undefined) {
    throw new Error(`could not locate ERROR_CODES tuple in ${REGISTRY_TS}`);
  }
  const body = m[1];
  return [...body.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((mm) => mm[1]!);
}

export function extractYamlEnum(doc: unknown): string[] {
  if (doc === null || typeof doc !== 'object') return [];
  const components = (doc as Record<string, unknown>)['components'];
  if (components === null || typeof components !== 'object') return [];
  const schemas = (components as Record<string, unknown>)['schemas'];
  if (schemas === null || typeof schemas !== 'object') return [];
  const errorCode = (schemas as Record<string, unknown>)['ErrorCode'];
  if (errorCode === null || typeof errorCode !== 'object') return [];
  const enumVal = (errorCode as Record<string, unknown>)['enum'];
  if (!Array.isArray(enumVal)) return [];
  return enumVal.filter((v): v is string => typeof v === 'string');
}

type Issue = { reason: string };

export function verifyRegistry(tsCodes: string[], yamlCodes: string[]): Issue[] {
  const issues: Issue[] = [];

  for (const c of tsCodes) {
    if (!CODE_SHAPE.test(c)) issues.push({ reason: `bad shape (not UPPER_SNAKE_CASE): ${c}` });
  }
  const seen = new Set<string>();
  for (const c of tsCodes) {
    if (seen.has(c)) issues.push({ reason: `duplicate code: ${c}` });
    seen.add(c);
  }

  // Parity: same values, same order.
  if (tsCodes.length !== yamlCodes.length) {
    issues.push({
      reason: `TS tuple length ${tsCodes.length} != YAML enum length ${yamlCodes.length}`,
    });
  } else {
    for (let i = 0; i < tsCodes.length; i++) {
      if (tsCodes[i] !== yamlCodes[i]) {
        issues.push({ reason: `position ${i}: TS '${tsCodes[i]}' != YAML '${yamlCodes[i]}'` });
      }
    }
  }

  return issues;
}

function checkRepo(): Issue[] {
  const tsCodes = extractTsRegistry(readFileSync(REGISTRY_TS, 'utf8'));
  const yamlDoc = parseYaml(readFileSync(COMMON_YAML, 'utf8'));
  const yamlCodes = extractYamlEnum(yamlDoc);
  return verifyRegistry(tsCodes, yamlCodes);
}

function runSelfTest(): void {
  // Good parity.
  const ok = verifyRegistry(['AUTH_REQUIRED', 'INVALID_TOKEN'], ['AUTH_REQUIRED', 'INVALID_TOKEN']);
  if (ok.length !== 0) throw new Error(`self-test: clean tuple flagged: ${JSON.stringify(ok)}`);

  // Bad shape.
  const badShape = verifyRegistry(['auth_required'], ['auth_required']);
  if (!badShape.some((i) => i.reason.includes('bad shape'))) {
    throw new Error('self-test: bad-shape code not flagged');
  }

  // Duplicate.
  const dup = verifyRegistry(['AUTH_REQUIRED', 'AUTH_REQUIRED'], ['AUTH_REQUIRED', 'AUTH_REQUIRED']);
  if (!dup.some((i) => i.reason.includes('duplicate'))) {
    throw new Error('self-test: duplicate not flagged');
  }

  // Parity mismatch — different length.
  const lenMismatch = verifyRegistry(['AUTH_REQUIRED'], ['AUTH_REQUIRED', 'INVALID_TOKEN']);
  if (!lenMismatch.some((i) => i.reason.includes('length'))) {
    throw new Error('self-test: length mismatch not flagged');
  }

  // Parity mismatch — order differs.
  const orderMismatch = verifyRegistry(['INVALID_TOKEN', 'AUTH_REQUIRED'], ['AUTH_REQUIRED', 'INVALID_TOKEN']);
  if (!orderMismatch.some((i) => i.reason.includes('position'))) {
    throw new Error('self-test: order mismatch not flagged');
  }

  // Extraction.
  const source = "export const ERROR_CODES = [\n  'A',\n  'B_C',\n] as const;\n";
  const got = extractTsRegistry(source);
  if (got.length !== 2 || got[0] !== 'A' || got[1] !== 'B_C') {
    throw new Error(`self-test: tuple extraction wrong: ${JSON.stringify(got)}`);
  }

  console.log('self-test ok: error-codes verifies shape, uniqueness, and TS↔YAML parity');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log('error-codes:check ok');
    return;
  }
  console.error(`error-codes:check FAILED — ${issues.length} issue(s):`);
  for (const i of issues) console.error(`  ${i.reason}`);
  process.exit(1);
}

main();
