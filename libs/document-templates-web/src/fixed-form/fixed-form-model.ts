// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — the fixed-form model the
// Platform Studio's fixed-form mode and the Org Home read-only preview share. The server
// (apps/api FixedFormService) is authoritative; these are the wire shapes plus the small pure
// helpers the editor needs.
//
// Field geometry is PDF-native — exactly what Aramo Sign places: page_number 0-based, points,
// origin bottom-left, (x, y) the box's lower-left corner.

export const FIXED_FORM_SCHEMA_V1 = 'fixed-form-pdf-v1';
export const FIXED_FORM_MAX_BYTES = 10 * 1024 * 1024;

/** §7.2 — the field types Aramo Sign executes, in palette order, with their labels and sizes. */
export const FIXED_FORM_FIELD_TYPES = [
  { type: 'SIGNATURE', label: 'Signature', width: 160, height: 32 },
  { type: 'INITIALS', label: 'Initials', width: 56, height: 28 },
  { type: 'SIGNER_NAME', label: 'Name', width: 160, height: 18 },
  { type: 'SIGN_DATE', label: 'Date', width: 96, height: 18 },
  { type: 'TEXT', label: 'Text', width: 160, height: 18 },
  { type: 'CHECKBOX', label: 'Checkbox', width: 14, height: 14 },
] as const;
export type FixedFormFieldType = (typeof FIXED_FORM_FIELD_TYPES)[number]['type'];

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
