import { describe, expect, it } from 'vitest';

import {
  FIXED_FORM_FIELD_TYPES,
  FIXED_FORM_SCHEMA_V1,
  emptyFixedFormContent,
  fixedFormIssues,
  fixedFormPdfOf,
  type FixedFormField,
  type FixedFormPdfRef,
  type FixedFormRole,
} from '../index.js';
import { templateContentFingerprint, templateFieldSettingColumns } from '../lib/templates.repository.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.2 — the fixed-form field rules
// (pure; the persistence is proven by the TP-6 integration spec).

const PDF: FixedFormPdfRef = {
  asset_id: '00000000-0000-7000-8000-0000000006a1',
  sha256: 'a'.repeat(64),
  byte_size: 2048,
  page_count: 2,
  pages: [
    { width: 612, height: 792 },
    { width: 612, height: 792 },
  ],
};
const ROLES: FixedFormRole[] = [
  { role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 },
  { role_key: 'employer', label: 'Employer', kind: 'SIGNER', order: 2 },
  { role_key: 'hr', label: 'HR copy', kind: 'CC', order: 3 },
];
const field = (over: Partial<FixedFormField>): FixedFormField => ({
  field_key: 'signature_1',
  field_type: 'SIGNATURE',
  binding_key: null,
  signer_role: 'employee',
  required: true,
  page_number: 0,
  x: 72,
  y: 100,
  width: 160,
  height: 32,
  ordinal: 0,
  ...over,
});
const READY: FixedFormField[] = [field({}), field({ field_key: 'signature_2', signer_role: 'employer', page_number: 1 })];
const ALLOWED = new Set(['organization.name']);

describe('TEMPLATE-PRODUCT-1 TP-6 — fixed-form rules (§7.2)', () => {
  it('the field types are exactly the six Aramo Sign executes', () => {
    // FIELD-PARITY-1 P1-2 — a catalog projection (catalog order); the same six types.
    expect([...FIXED_FORM_FIELD_TYPES].sort()).toEqual(['TEXT', 'SIGN_DATE', 'CHECKBOX', 'SIGNER_NAME', 'SIGNATURE', 'INITIALS'].sort());
  });

  it('a complete form has no issue', () => {
    expect(fixedFormIssues({ pdf: PDF, roles: ROLES, fields: READY, allowedBindingKeys: ALLOWED })).toEqual([]);
  });

  it('needs a PDF and at least one field', () => {
    const codes = fixedFormIssues({ pdf: null, roles: ROLES, fields: [], allowedBindingKeys: ALLOWED }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['pdf_required', 'fields_required', 'role_without_signature']));
  });

  it('every SIGNER role needs a signature field (a copy role does not)', () => {
    const issues = fixedFormIssues({ pdf: PDF, roles: ROLES, fields: [READY[0]!], allowedBindingKeys: ALLOWED });
    expect(issues).toEqual([expect.objectContaining({ code: 'role_without_signature', role_key: 'employer' })]);
  });

  it('refuses a type Sign cannot execute, a missing / copy role and a duplicate key', () => {
    const codes = fixedFormIssues({
      pdf: PDF,
      roles: ROLES,
      fields: [
        ...READY,
        field({ field_key: 'img_1', field_type: 'IMAGE' }),
        field({ field_key: 'date_1', field_type: 'SIGN_DATE', signer_role: null }),
        field({ field_key: 'date_2', field_type: 'SIGN_DATE', signer_role: 'hr' }),
        field({ field_key: 'signature_1' }),
      ],
      allowedBindingKeys: ALLOWED,
    }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['field_type_invalid', 'field_role_invalid', 'field_key_duplicate']));
    expect(codes.filter((c) => c === 'field_role_invalid')).toHaveLength(2);
  });

  it('a prefilled field is TEXT, belongs to no signer and uses a variable of the type', () => {
    const ok = field({ field_key: 'employer_name', field_type: 'TEXT', binding_key: 'organization.name', signer_role: null });
    expect(fixedFormIssues({ pdf: PDF, roles: ROLES, fields: [...READY, ok], allowedBindingKeys: ALLOWED })).toEqual([]);
    const codes = fixedFormIssues({
      pdf: PDF,
      roles: ROLES,
      fields: [
        ...READY,
        field({ field_key: 'a', field_type: 'CHECKBOX', binding_key: 'organization.name', signer_role: null }),
        field({ field_key: 'b', field_type: 'TEXT', binding_key: 'organization.name', signer_role: 'employee' }),
        field({ field_key: 'c', field_type: 'TEXT', binding_key: 'talent.ssn', signer_role: null }),
      ],
      allowedBindingKeys: ALLOWED,
    }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['binding_not_text', 'binding_with_role', 'binding_unknown']));
  });

  it('each box lies on an existing page, inside it, at least 8 points each way', () => {
    const codes = fixedFormIssues({
      pdf: PDF,
      roles: ROLES,
      fields: [
        ...READY,
        field({ field_key: 'p3', page_number: 2 }),
        field({ field_key: 'off', x: 500, width: 160 }),
        field({ field_key: 'tiny', width: 4 }),
        field({ field_key: 'nopos', x: null }),
      ],
      allowedBindingKeys: ALLOWED,
    }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['field_page_invalid', 'field_off_page', 'field_too_small', 'field_position_required']));
  });

  it('fixedFormPdfOf reads the stored reference of fixed-form content only', () => {
    expect(fixedFormPdfOf({ render_schema_version: FIXED_FORM_SCHEMA_V1, title: 'I-9', pdf: PDF, signing: {} })).toEqual(PDF);
    expect(fixedFormPdfOf({ render_schema_version: 'rtr-html-v1', pdf: PDF })).toBeNull();
    expect(fixedFormPdfOf(emptyFixedFormContent('I-9'))).toBeNull();
    expect(fixedFormPdfOf(null)).toBeNull();
  });

  it('a new form starts with no PDF and one signer role', () => {
    const c = emptyFixedFormContent('W-4');
    expect(c).toEqual({
      render_schema_version: FIXED_FORM_SCHEMA_V1,
      title: 'W-4',
      pdf: null,
      signing: { roles: [{ role_key: 'signer', label: 'Signer', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
    });
  });
});

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-3 —
// a fixed form's check-box groups hold Sign's group rule before it can be published, and the
// settings are content (they join the preview fingerprint only when set).
describe('FIELD-PARITY-1 P1-3 — fixed-form field settings', () => {
  const box = (field_key: string, over: Partial<FixedFormField> = {}): FixedFormField =>
    field({ field_key, field_type: 'CHECKBOX', required: false, width: 18, height: 18, group_key: 'answer', group_rule: 'SELECT_ONE', min_selected: 1, ...over });

  it('a consistent check-box group publishes', () => {
    expect(fixedFormIssues({ pdf: PDF, roles: ROLES, fields: [...READY, box('yes', { label: 'Yes' }), box('no', { label: 'No' })], allowedBindingKeys: ALLOWED })).toEqual([]);
  });

  it('a group split across roles or rules, or with a minimum above its size, is an issue naming a box', () => {
    const issues = (boxes: FixedFormField[]) => fixedFormIssues({ pdf: PDF, roles: ROLES, fields: [...READY, ...boxes], allowedBindingKeys: ALLOWED });
    expect(issues([box('yes'), box('no', { signer_role: 'employer' })])).toEqual([expect.objectContaining({ code: 'checkbox_group_inconsistent', field_key: 'yes' })]);
    expect(issues([box('yes'), box('no', { group_rule: 'SELECT_ANY' })])).toEqual([expect.objectContaining({ code: 'checkbox_group_inconsistent' })]);
    const any = { group_rule: 'SELECT_ANY', min_selected: 3 };
    expect(issues([box('a', any), box('b', any)])).toEqual([expect.objectContaining({ code: 'checkbox_group_min_exceeds_size', field_key: 'a' })]);
  });

  it('the fingerprint is unchanged for fields without settings and changes when a setting is set', () => {
    const plain = { ...field({}), format_rule: null };
    const nulls = { ...plain, label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null };
    expect(templateContentFingerprint({ a: 1 }, [nulls])).toBe(templateContentFingerprint({ a: 1 }, [plain]));
    const named = { ...plain, field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' };
    expect(templateContentFingerprint({ a: 1 }, [named])).not.toBe(templateContentFingerprint({ a: 1 }, [{ ...named, name_mode: null }]));
  });

  it('templateFieldSettingColumns maps absent settings to NULL for every write and copy', () => {
    expect(templateFieldSettingColumns({})).toEqual({ label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null });
    expect(templateFieldSettingColumns({ label: 'Yes', group_key: 'g', group_rule: 'SELECT_ANY', min_selected: 2 })).toEqual({
      label: 'Yes',
      group_key: 'g',
      group_rule: 'SELECT_ANY',
      min_selected: 2,
      name_mode: null,
    });
  });
});
