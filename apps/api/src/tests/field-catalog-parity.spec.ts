import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES } from '@aramo/documents-contracts';
import {
  CONDITION_VALUES_MAX,
  FIELD_CONDITION_WHENS,
  FIELD_IMPORT_WARNING_CODES,
  FIELD_KEY_MAX,
  FIELD_TYPE_KEYS,
  FIELD_VALIDATIONS,
  OPTION_KEYS_BY_TYPE,
  VALIDATIONS_BY_TYPE,
  fieldSettingsOf,
  fieldTypesFor,
  type FieldSurface,
  type SurfaceGate,
} from '@aramo/sign-fields';
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
    // FIELD-PARITY-1 P3 (R-9) — the documents template API accepts the store minus IMAGE.
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'AddFieldRequest', path: ['field_type'], surface: 'template_documents_authoring' },
    // TEMPLATE-FIELDS-1 F-5 — the fields placed in the text of editable content.
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'InlineTemplateFieldInput', path: ['field_type'], surface: 'template_inline' },
    { where: 'documents.yaml', schemas: DOCUMENTS, schema: 'SignTemplateSignatureField', path: ['field_type'], surface: 'signature_block' },
    { where: 'platform.yaml', schemas: PLATFORM, schema: 'FixedFormField', path: ['field_type'], surface: 'template_fixed_form' },
    // FIELD-PARITY-1 P2-5 / P2-6 — the fields an opted-in upload imports (never PAYMENT: imports are not gated).
    { where: 'platform.yaml', schemas: PLATFORM, schema: 'FixedFormImportedField', path: ['field_type'], surface: 'template_fixed_form' },
    { where: 'sign.yaml', schemas: SIGN, schema: 'SenderImportedField', path: ['field_type'], surface: 'send_web' },
  ];

  it.each(CASES.map((c) => [`${c.where} ${c.schema}.${c.path.join('.')}`, c] as const))('%s = its catalog projection', (_name, c) => {
    expect(sorted(enumAt(c.schemas, c.schema, c.path))).toEqual(projection(c.surface, c.gate));
  });
});

describe('FIELD-PARITY-1 P2-5 / P2-6 — the import warning codes', () => {
  it('both OpenAPI FieldImportWarning enums = FIELD_IMPORT_WARNING_CODES', () => {
    expect(sorted(enumAt(PLATFORM, 'FieldImportWarning', ['code']))).toEqual(sorted(FIELD_IMPORT_WARNING_CODES));
    expect(sorted(enumAt(SIGN, 'FieldImportWarning', ['code']))).toEqual(sorted(FIELD_IMPORT_WARNING_CODES));
  });
});

describe('FIELD-PARITY-1 P1-2 — catalog parity: TypeScript literals kept outside the catalog', () => {
  it('documents-contracts SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES = signature_block', () => {
    expect(sorted(SIGN_TEMPLATE_SIGNATURE_FIELD_TYPES)).toEqual(projection('signature_block'));
  });

  it('the fixed-form field_type refusal message (apps/api fixed-form.service.ts) is the catalog projection, never a literal list', () => {
    // FIELD-PARITY-1 P3 — the message is built from fieldTypesFor('template_fixed_form').
    const src = read('apps/api/src/documents/fixed-form.service.ts');
    expect(src).toContain("fieldTypesFor('template_fixed_form').join(', ')");
    expect(src).not.toMatch(/'field_type must be [A-Z_, ]+ or [A-Z_]+'/);
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

// FIELD-PARITY-1 P3 §6.2 — the setting CHECKs of both field tables and the OpenAPI settings
// schemas are held equal to the shared settings rule (@aramo/sign-fields).
describe('FIELD-PARITY-1 P3 — settings parity: CHECKs and OpenAPI', () => {
  const SIGN_P3 = read('libs/sign/prisma/migrations/20261122200000_field_parity_1_p3_field_types_settings/migration.sql');
  const DOCS_P3 = read('libs/documents/prisma/migrations/20261122200000_field_parity_1_p3_template_field_types_settings/migration.sql');
  const quoted = (sql: string): string[] => [...sql.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1] as string);
  const checkBody = (sql: string, constraint: string): string => {
    const i = sql.indexOf(`ADD CONSTRAINT "${constraint}"`);
    if (i < 0) throw new Error(`no ${constraint}`);
    const end = sql.indexOf(';', i);
    return sql.slice(i, end);
  };

  it.each([
    ['Sign', SIGN_P3, 'SignatureField'],
    ['documents', DOCS_P3, 'TemplateFieldDefinition'],
  ] as const)('%s: the sender_filled CHECK names exactly the types that take sender_filled', (_n, sql, table) => {
    const types = quoted(checkBody(sql, `${table}_sender_filled_check`));
    expect(sorted(types)).toEqual(sorted(FIELD_TYPE_KEYS.filter((t) => fieldSettingsOf(t).includes('sender_filled'))));
  });

  it.each([
    ['Sign', SIGN_P3, 'SignatureField'],
    ['documents', DOCS_P3, 'TemplateFieldDefinition'],
  ] as const)('%s: the validation CHECK pairs each type with exactly its presets', (_n, sql, table) => {
    const body = checkBody(sql, `${table}_validation_check`);
    const pairs: Record<string, string[]> = {};
    for (const m of body.matchAll(/"field_type" = '([A-Z_]+)' AND "validation" (?:IN \(([^)]*)\)|= '([a-z_]+)')/g)) {
      pairs[m[1] as string] = m[2] !== undefined ? quoted(m[2]) : [m[3] as string];
    }
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(VALIDATIONS_BY_TYPE).sort());
    for (const [t, presets] of Object.entries(VALIDATIONS_BY_TYPE)) expect(sorted(pairs[t] ?? [])).toEqual(sorted(presets));
  });

  it('the two P3 migrations add the same setting columns with the same CHECKs', () => {
    const normalize = (sql: string, table: string): string[] =>
      sql
        .split('\n')
        .filter((l) => !l.startsWith('--') && !/_type_check/.test(l))
        .join('\n')
        // The schema-qualified table names (either schema) read as T.
        .replace(/"(?:sign|documents)"\."[A-Za-z]+"/g, 'T')
        .replaceAll(`${table}_`, 'T_')
        .split(';')
        .map((x) => x.replace(/\s+/g, ' ').trim())
        .filter((x) => x.length > 0 && !x.includes('"field_type" IN (\'SIGNATURE\''));
    expect(normalize(DOCS_P3, 'TemplateFieldDefinition')).toEqual(normalize(SIGN_P3, 'SignatureField'));
  });

  it.each([
    ['sign.yaml', SIGN, 'SenderFieldInput'],
    ['sign.yaml', SIGN, 'SenderEnvelopeField'],
    ['documents.yaml', DOCUMENTS, 'TemplateFieldDefinition'],
    ['documents.yaml', DOCUMENTS, 'AddFieldRequest'],
    ['platform.yaml', PLATFORM, 'FixedFormField'],
  ] as const)('%s %s: validation enum = FIELD_VALIDATIONS', (_w, schemas, schema) => {
    expect(sorted(enumAt(schemas, schema, ['validation']).filter((v) => v !== 'null'))).toEqual(sorted(FIELD_VALIDATIONS));
  });

  it.each([
    ['sign.yaml', SIGN],
    ['documents.yaml', DOCUMENTS],
    ['platform.yaml', PLATFORM],
  ] as const)('%s FieldOptions: its keys = every option key of OPTION_KEYS_BY_TYPE', (_w, schemas) => {
    const props = Object.keys(((schemas['FieldOptions'] as { properties: Record<string, unknown> }).properties));
    expect(sorted(props)).toEqual(sorted(new Set(Object.values(OPTION_KEYS_BY_TYPE).flat())));
  });
});

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-1 / B-2,
// §5 test 2 — the field key and the condition: both condition migrations stay normalized-identical,
// their CHECK names exactly the shared rules, and every contract that carries settings carries the
// condition (one FieldCondition schema per OpenAPI file, equal to the shared shape).
describe('FIELD-PARITY-2 B-1 / B-2 — field key and condition parity', () => {
  const SIGN_KEY = read('libs/sign/prisma/migrations/20261123100000_field_parity_2_field_key/migration.sql');
  const SIGN_COND = read('libs/sign/prisma/migrations/20261123100100_field_parity_2_field_condition/migration.sql');
  const DOCS_COND = read('libs/documents/prisma/migrations/20261123100100_field_parity_2_template_field_condition/migration.sql');
  const normalize = (sql: string, table: string): string[] =>
    sql
      .split('\n')
      .filter((l) => !l.startsWith('--'))
      .join('\n')
      .replace(/"(?:sign|documents)"\."[A-Za-z]+"/g, 'T')
      .replaceAll(`${table}_`, 'T_')
      .split(';')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter((x) => x.length > 0);

  it('the two condition migrations add the same column with the same CHECK', () => {
    expect(normalize(DOCS_COND, 'TemplateFieldDefinition')).toEqual(normalize(SIGN_COND, 'SignatureField'));
    expect(normalize(SIGN_COND, 'SignatureField').length).toBeGreaterThan(0);
  });

  it.each([
    ['Sign', SIGN_COND],
    ['documents', DOCS_COND],
  ] as const)('%s: the condition CHECK names exactly the shared rules, the values limit and the key limit', (_n, sql) => {
    const whens = /COALESCE\("condition" ->> 'when', ''\) IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(sorted([...whens.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string))).toEqual(sorted(FIELD_CONDITION_WHENS));
    expect(sql).toContain(`BETWEEN 1 AND ${CONDITION_VALUES_MAX}`);
    expect(sql).toContain(`char_length("condition" ->> 'trigger_key') BETWEEN 1 AND ${FIELD_KEY_MAX}`);
  });

  it('the Sign field_key CHECK is the shared key limit, and a partial unique index guards a document', () => {
    expect(SIGN_KEY).toContain(`char_length("field_key") BETWEEN 1 AND ${FIELD_KEY_MAX}`);
    expect(SIGN_KEY).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "SignatureField_document_field_key"\s+ON "sign"\."SignatureField" \("envelope_document_id", "field_key"\)\s+WHERE "field_key" IS NOT NULL/);
  });

  it.each([
    ['sign.yaml', SIGN],
    ['documents.yaml', DOCUMENTS],
    ['platform.yaml', PLATFORM],
  ] as const)('%s FieldCondition: when = FIELD_CONDITION_WHENS, values ≤ CONDITION_VALUES_MAX, trigger_key ≤ FIELD_KEY_MAX', (_w, schemas) => {
    const c = schemas['FieldCondition'] as { properties: Record<string, { enum?: string[]; maxItems?: number; maxLength?: number }> };
    expect(sorted(Object.keys(c.properties))).toEqual(['trigger_key', 'values', 'when']);
    expect(sorted(c.properties['when']?.enum ?? [])).toEqual(sorted(FIELD_CONDITION_WHENS));
    expect(c.properties['values']?.maxItems).toBe(CONDITION_VALUES_MAX);
    expect(c.properties['trigger_key']?.maxLength).toBe(FIELD_KEY_MAX);
  });

  const propertyAt = (schemas: Schemas, schema: string, path: readonly string[], member: string): unknown => {
    let node = schemas[schema] as Record<string, unknown> | undefined;
    for (const step of path) {
      if (node === undefined) break;
      node = step === '[]' ? (node['items'] as Record<string, unknown> | undefined) : ((node['properties'] as Record<string, unknown> | undefined)?.[step] as Record<string, unknown> | undefined);
    }
    return (node?.['properties'] as Record<string, unknown> | undefined)?.[member];
  };

  // Every settings-carrying contract (the same list the validation enum is held on, plus the
  // read views) has condition; the Sign sender contracts also have field_key.
  it.each([
    ['sign.yaml', SIGN, 'SenderFieldInput', [] as string[]],
    ['sign.yaml', SIGN, 'SenderEnvelopeField', []],
    ['documents.yaml', DOCUMENTS, 'TemplateFieldDefinition', []],
    ['documents.yaml', DOCUMENTS, 'AddFieldRequest', []],
    ['documents.yaml', DOCUMENTS, 'SignTemplateRenderResponse', ['field_definitions', '[]']],
    ['platform.yaml', PLATFORM, 'FixedFormField', []],
  ] as const)('%s %s carries condition', (_w, schemas, schema, path) => {
    expect(propertyAt(schemas, schema, path, 'condition')).toBeDefined();
  });

  it.each([
    ['SenderFieldInput'],
    ['SenderEnvelopeField'],
  ] as const)('sign.yaml %s carries field_key', (schema) => {
    expect(propertyAt(SIGN, schema, [], 'field_key')).toBeDefined();
  });
});
