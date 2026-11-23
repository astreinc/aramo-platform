// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — the fixed-form model the
// Platform Studio's fixed-form mode and the Org Home read-only preview share. The server
// (apps/api FixedFormService) is authoritative; these are the wire shapes plus the small pure
// helpers the editor needs.
//
// Field geometry is PDF-native — exactly what Aramo Sign places: page_number 0-based, points,
// origin bottom-left, (x, y) the box's lower-left corner.

import { FIELD_DEFAULTS, fieldTypesFor, type FieldTypeOn } from '@aramo/sign-fields';

export const FIXED_FORM_SCHEMA_V1 = 'fixed-form-pdf-v1';
export const FIXED_FORM_MAX_BYTES = 10 * 1024 * 1024;

/**
 * §7.2 — the field types Aramo Sign executes on a fixed form: the catalog's
 * `template_fixed_form` surface (FIELD-PARITY-1 P1-2, @aramo/sign-fields).
 */
export type FixedFormFieldType = FieldTypeOn<'template_fixed_form'>;

export interface FixedFormFieldTypeSpec {
  readonly type: FixedFormFieldType;
  readonly label: string;
  /** Default size in PDF points (FIELD-PARITY-1 P1-0: the catalog's one table). */
  readonly width: number;
  readonly height: number;
  /** Whether a newly placed field starts required (P1-0: the catalog's one rule). */
  readonly required: boolean;
}

// The Studio's own palette label and order. Keyed by the projection's type, so a type the
// catalog adds to (or removes from) the fixed-form surface fails to compile until it is listed.
const PALETTE: Readonly<Record<FixedFormFieldType, { readonly label: string; readonly order: number }>> = {
  SIGNATURE: { label: 'Signature', order: 0 },
  INITIALS: { label: 'Initials', order: 1 },
  SIGNER_NAME: { label: 'Name', order: 2 },
  SIGN_DATE: { label: 'Date', order: 3 },
  TEXT: { label: 'Text', order: 4 },
  CHECKBOX: { label: 'Checkbox', order: 5 },
  // FIELD-PARITY-1 P3 (ruling R-1) — the profile types, ACKNOWLEDGEMENT and the new types. DATE
  // is the chosen date ("Date" above is the signing date, SIGN_DATE).
  FIRST_NAME: { label: 'First name', order: 6 },
  LAST_NAME: { label: 'Last name', order: 7 },
  EMAIL: { label: 'Email', order: 8 },
  COMPANY: { label: 'Company', order: 9 },
  TITLE: { label: 'Title', order: 10 },
  ACKNOWLEDGEMENT: { label: 'Acknowledgement', order: 11 },
  DATE: { label: 'Chosen date', order: 12 },
  DROPDOWN: { label: 'Dropdown', order: 13 },
  RADIO: { label: 'Radio button', order: 14 },
  NUMBER: { label: 'Number', order: 15 },
  MULTILINE_TEXT: { label: 'Multi-line text', order: 16 },
};

/**
 * §7.2 — the field types, in palette order, with their labels, default sizes and required
 * defaults. FIELD-PARITY-1 P1-0 — the size and required default are the catalog's (the same
 * table Sign's Prepare and the Aramo Sign app use), no longer a console-only table.
 */
export const FIXED_FORM_FIELD_TYPES: readonly FixedFormFieldTypeSpec[] = fieldTypesFor('template_fixed_form')
  .map((type) => ({ type, label: PALETTE[type].label, width: FIELD_DEFAULTS[type].width, height: FIELD_DEFAULTS[type].height, required: FIELD_DEFAULTS[type].required }))
  .sort((a, b) => PALETTE[a.type].order - PALETTE[b.type].order);

export function fixedFormFieldLabel(type: string): string {
  return FIXED_FORM_FIELD_TYPES.find((t) => t.type === type)?.label ?? type;
}

export interface FixedFormPage {
  readonly width: number;
  readonly height: number;
}

export interface FixedFormPdfRef {
  readonly asset_id: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly page_count: number;
  readonly pages: readonly FixedFormPage[];
}

export interface FixedFormRole {
  readonly role_key: string;
  readonly label: string;
  readonly kind: 'SIGNER' | 'CC';
  readonly order: number;
}

export interface FixedFormSigning {
  readonly roles: readonly FixedFormRole[];
  readonly routing_mode: 'PARALLEL' | 'SEQUENTIAL';
}

export interface FixedFormContent {
  readonly render_schema_version: string;
  readonly title: string;
  readonly pdf: FixedFormPdfRef | null;
  readonly signing: FixedFormSigning;
}

export interface FixedFormField {
  readonly field_key: string;
  readonly field_type: string;
  readonly binding_key: string | null;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly page_number: number | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly ordinal: number;
  // FIELD-PARITY-1 P1-3 — per-field settings (NULL / absent = unset; SIGNER_NAME NULL = SIGNER_PROFILE).
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly group_rule?: string | null;
  readonly min_selected?: number | null;
  readonly name_mode?: string | null;
  // FIELD-PARITY-1 P3 §6.2 — the other settings (same rule; absent / NULL / false = not set).
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly read_only?: boolean;
  readonly sender_filled?: boolean;
  readonly validation?: string | null;
  readonly font_size?: number | null;
  readonly data_name?: string | null;
  readonly options?: unknown;
}

export interface FixedFormVariable {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly data_type: string;
  readonly sample_value: string | null;
}

export interface FixedFormIssue {
  readonly code: string;
  readonly message: string;
  readonly field_key?: string;
  readonly role_key?: string;
}

/** GET /platform/document-templates/versions/:versionId/fixed-form — the Studio view. */
export interface FixedFormVersionView {
  readonly template_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  readonly content: FixedFormContent;
  readonly fields: readonly FixedFormField[];
  readonly variables: readonly FixedFormVariable[];
  readonly issues: readonly FixedFormIssue[];
  readonly previewed: boolean;
  /** FIELD-PARITY-2 A-4 — sender-filled fields are switched on (server flag; they ship dark). */
  readonly sender_filled_fields_enabled: boolean;
  /** FIELD-PARITY-1 P2-5 / P2-6 — present only on an upload sent with import_fields / apply_text_tags. */
  readonly field_import?: FixedFormFieldImport;
}

/** FIELD-PARITY-1 P2-5 / P2-6 — what an opted-in upload added, warned about and removed. */
export interface FixedFormFieldImport {
  readonly fields: ReadonlyArray<FixedFormField & { readonly source: 'pdf_form' | 'text_tag'; readonly source_name: string }>;
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string; readonly name?: string; readonly page_number?: number }>;
  readonly stripped: readonly string[];
}

/** FIELD-PARITY-1 P2-4 — GET …/fixed-form/field-suggestions (the field frame: page_number 0-based, points, bottom-left). */
export interface FixedFormFieldSuggestions {
  readonly suggestions: ReadonlyArray<{
    readonly type: string;
    readonly page: number;
    readonly page_number: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly reason: string;
    readonly confidence: number;
  }>;
  readonly skipped_pages: ReadonlyArray<{ readonly page: number; readonly reason: string }>;
}

/** A role key from a label: lower_snake, unique among `taken`. */
export function roleKeyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 32) || 'role';
  let key = base;
  for (let i = 2; taken.has(key); i += 1) key = `${base}_${i}`;
  return key;
}

/** The next free field key for a type ("signature_2"). */
export function nextFieldKey(type: string, fields: readonly Pick<FixedFormField, 'field_key'>[]): string {
  const base = type.toLowerCase();
  const taken = new Set(fields.map((f) => f.field_key));
  let i = 1;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** base64 (no data: prefix) → bytes. */
export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** bytes → base64 (no data: prefix), chunked so a 10 MB PDF does not overflow the stack. */
export function bytesToBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
