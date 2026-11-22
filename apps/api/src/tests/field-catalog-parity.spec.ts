import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES } from '@aramo/documents-contracts';
import { fieldTypesFor, type FieldSurface, type SurfaceGate } from '@aramo/sign-fields';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-2,
// §8 test 1 — the catalog-parity test. The TypeScript lists are projections of the one field
// catalog (@aramo/sign-fields fieldTypesFor). What cannot import it stays literal — the two
// database CHECKs, the OpenAPI enums, and two TypeScript literals — and is held here equal to
// its catalog projection. A field type added in only one place (the catalog, a migration's
// CHECK, or an OpenAPI enum) fails this spec.
//
// Lives in apps/api: untagged (it reads Sign, documents and platform contracts alike) and its
// unit suite runs on every full gate. The test target's inputs name openapi/ and both
// migration folders (apps/api/project.json), so a change to any of them re-runs it.

const REPO = resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

// The field-type list of the LATEST definition of a CHECK constraint across a migration folder
// (migrations apply in folder-name order; a later DROP + ADD replaces an earlier one).
function latestCheck(migrationsDir: string, constraint: string): { readonly migration: string; readonly types: string[] } {
  const re = new RegExp(`CONSTRAINT\\s+"${constraint}"\\s+CHECK\\s*\\(\\s*"field_type"\\s+IN\\s*\\(([^)]*)\\)`, 'g');
  let found: { migration: string; types: string[] } | null = null;
  for (const dir of readdirSync(resolve(REPO, migrationsDir)).sort()) {
    let sql: string;
    try {
      sql = read(`${migrationsDir}/${dir}/migration.sql`);
    } catch {
      continue;
    }
    for (const m of sql.matchAll(re)) found = { migration: dir, types: [...(m[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] as string) };
  }
  if (found === null) throw new Error(`no ${constraint} in ${migrationsDir}`);
  return found;
}

type Schemas = Record<string, unknown>;
const schemasOf = (rel: string): Schemas => (parseYaml(read(rel)) as { components: { schemas: Schemas } }).components.schemas;
const SIGN = schemasOf('openapi/sign.yaml');
const DOCUMENTS = schemasOf('openapi/documents.yaml');
const PLATFORM = schemasOf('openapi/platform.yaml');

// The enum at a property path inside one schema (e.g. ['fields', '[]', 'field_type']).
function enumAt(schemas: Schemas, schema: string, path: readonly string[]): string[] {
  let node = schemas[schema] as Record<string, unknown> | undefined;
  for (const step of path) {
    if (node === undefined) break;
    node = step === '[]' ? (node['items'] as Record<string, unknown> | undefined) : ((node['properties'] as Record<string, unknown> | undefined)?.[step] as Record<string, unknown> | undefined);
  }
  const e = node?.['enum'];
  if (!Array.isArray(e)) throw new Error(`no enum at ${schema}.${path.join('.')}`);
  return e.map(String);
}

const projection = (s: FieldSurface, gate?: SurfaceGate): string[] => sorted(gate === undefined ? fieldTypesFor(s) : fieldTypesFor(s, gate));
const PAYMENTS_ON: SurfaceGate = { payments_available: true };

describe('FIELD-PARITY-1 P1-2 — catalog parity: database CHECKs', () => {
  it('the Sign SignatureField field-type CHECK (latest migration) = sign_store', () => {
    const c = latestCheck('libs/sign/prisma/migrations', 'SignatureField_type_check');
    expect(sorted(c.types), c.migration).toEqual(projection('sign_store'));
  });

  it('documents."TemplateFieldDefinition" field-type CHECK (latest migration) = template_documents_store', () => {
    const c = latestCheck('libs/documents/prisma/migrations', 'TemplateFieldDefinition_type_check');
    expect(sorted(c.types), c.migration).toEqual(projection('template_documents_store'));
  });
});

describe('FIELD-PARITY-1 P1-2 — catalog parity: OpenAPI enums', () => {
  const CASES: readonly { readonly where: string; readonly schemas: Schemas; readonly schema: string; readonly path: readonly string[]; readonly surface: FieldSurface; readonly gate?: SurfaceGate }[] = [
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderEnvelopeField', path: ['field_type'], surface: 'sign_store' },
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderFieldPassthrough', path: ['field_type'], surface: 'engine_passthrough' },
    // PUT …/fields accepts PAYMENT while payments are available (P1-6), so the enum is the gated set.
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderFieldInput', path: ['field_type'], surface: 'send_web', gate: PAYMENTS_ON },
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderFieldInput', path: ['field_type'], surface: 'send_mobile', gate: PAYMENTS_ON },
    { where: 'sign.yaml', schemas: SIGN, schema: 'CreateEnvelopeRequest', path: ['fields', '[]', 'field_type'], surface: 'sign_api_s2s' },
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderTemplateSignatureField', path: ['field_type'], surface: 'signature_block' },
    { where: 'sign.yaml', schemas: SIGN, schema: 'DocumentFieldSuggestions', path: ['suggestions', '[]', 'type'], surface: 'suggestion' },
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'TemplateFieldDefinition', path: ['field_type'], surface: 'template_documents_store' },
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'AddFieldRequest', path: ['field_type'], surface: 'template_documents_store' },
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'SignTemplateSignatureField', path: ['field_type'], surface: 'signature_block' },
    { where: 'platform.yaml', schemas: PLATFORM, schema: 'FixedFormField', path: ['field_type'], surface: 'template_fixed_form' },
  ];

  it.each(CASES.map((c) => [`${c.where} ${c.schema}.${c.path.join('.')}`, c] as const))('%s = its catalog projection', (_name, c) => {
    expect(sorted(enumAt(c.schemas, c.schema, c.path))).toEqual(projection(c.surface, c.gate));
  });
});

describe('FIELD-PARITY-1 P1-2 — catalog parity: TypeScript literals kept outside the catalog', () => {
  it('documents-contracts SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES = signature_block', () => {
    expect(sorted(SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES)).toEqual(projection('signature_block'));
  });

  it("the fixed-form field_type refusal message (apps/api fixed-form.service.ts) names exactly template_fixed_form", () => {
    const src = read('apps/api/src/documents/fixed-form.service.ts');
    const m = /'field_type must be ([A-Z_, ]+) or ([A-Z_]+)'/.exec(src);
    expect(m).not.toBeNull();
    const named = [...(m?.[1] ?? '').split(',').map((x) => x.trim()), m?.[2] ?? ''];
    expect(sorted(named)).toEqual(projection('template_fixed_form'));
  });
});

describe('FIELD-PARITY-1 P1-6 — PAYMENT is send-only on every contract', () => {
  it('no template contract (CHECK or enum) carries PAYMENT; the sender input carries it', () => {
    expect(latestCheck('libs/documents/prisma/migrations', 'TemplateFieldDefinition_type_check').types).not.toContain('PAYMENT');
    expect(enumAt(PLATFORM, 'FixedFormField', ['field_type'])).not.toContain('PAYMENT');
    expect(enumAt(DOCUMENTS, 'AddFieldRequest', ['field_type'])).not.toContain('PAYMENT');
    expect(enumAt(SIGN, 'SenderFieldInput', ['field_type'])).toContain('PAYMENT');
  });
});
