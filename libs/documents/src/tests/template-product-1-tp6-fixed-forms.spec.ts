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
    expect([...FIXED_FORM_FIELD_TYPES]).toEqual(['TEXT', 'SIGN_DATE', 'CHECKBOX', 'SIGNER_NAME', 'SIGNATURE', 'INITIALS']);
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
