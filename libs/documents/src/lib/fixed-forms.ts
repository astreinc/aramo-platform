// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — fixed legal forms. The
// content contract of a FIXED_FORM document type's template version, and the field rules
// that do not depend on apps/api (the signing roles are parsed with the shared rtr-html-v1
// signing parser in apps/api, so the role rules are the same everywhere).
//
// A fixed form is the official PDF (PlatformTemplateAsset, uploaded by Platform Admin) with
// fields placed over it by signer role (TemplateFieldDefinition). It is never adopted and
// never edited by a tenant (§7.3). Field geometry is PDF-native, exactly what Sign places:
// page_number 0-based, points, origin bottom-left, (x, y) the box's lower-left corner.

/** field_schema.render_schema_version of a fixed-form version. */
export const FIXED_FORM_SCHEMA_V1 = 'fixed-form-pdf-v1';

/** §7.1 — the official PDF: PDF only, at most 10 MB. */
export const FIXED_FORM_MAX_BYTES = 10 * 1024 * 1024;
export const FIXED_FORM_MIME = 'application/pdf';

/** §7.1 — the platform prefix of the documents bucket (DB CHECK: documents/platform/%). */
export const PLATFORM_TEMPLATE_ASSET_PREFIX = 'documents/platform/template-assets';

/**
 * §7.2 — the field types a fixed form may place: the intersection Aramo Sign executes
 * (text, date, checkbox, name, signature, initials). "date" is the signing date and
 * "name" the signer's printed name — the only date and name Sign fills.
 */
export const FIXED_FORM_FIELD_TYPES = ['TEXT', 'SIGN_DATE', 'CHECKBOX', 'SIGNER_NAME', 'SIGNATURE', 'INITIALS'] as const;
export type FixedFormFieldType = (typeof FIXED_FORM_FIELD_TYPES)[number];

export const FIXED_FORM_MAX_FIELDS = 200;
export const FIXED_FORM_MIN_FIELD_SIZE = 8;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isFixedFormFieldType(v: unknown): v is FixedFormFieldType {
  return typeof v === 'string' && (FIXED_FORM_FIELD_TYPES as readonly string[]).includes(v);
}

export interface FixedFormPage {
  readonly width: number;
  readonly height: number;
}

/** The uploaded PDF a version uses (part of the content, so it joins the preview fingerprint). */
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

/** field_schema of a fixed-form version. */
export interface FixedFormContent {
  readonly render_schema_version: typeof FIXED_FORM_SCHEMA_V1;
  readonly title: string;
  readonly pdf: FixedFormPdfRef | null;
  readonly signing: FixedFormSigning;
}

/** One placed field (a TemplateFieldDefinition row of a fixed-form version). */
export interface FixedFormField {
  readonly field_key: string;
  readonly field_type: string;
  // A variable that prefills a TEXT field (no signer role: the value is printed on the
  // frozen document). Null for a field a signer fills.
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

/** The content a new fixed-form version starts from: no PDF yet, one signer role. */
export function emptyFixedFormContent(title: string): FixedFormContent {
  return {
    render_schema_version: FIXED_FORM_SCHEMA_V1,
    title,
    pdf: null,
    signing: { roles: [{ role_key: 'signer', label: 'Signer', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The stored PDF reference of a fixed-form content, or null (none / not fixed-form content). */
export function fixedFormPdfOf(field_schema: unknown): FixedFormPdfRef | null {
  const fs = field_schema as { render_schema_version?: unknown; pdf?: unknown } | null;
  if (fs === null || typeof fs !== 'object' || fs.render_schema_version !== FIXED_FORM_SCHEMA_V1) return null;
  const p = fs.pdf as Record<string, unknown> | null | undefined;
  if (p === null || p === undefined || typeof p !== 'object') return null;
  if (typeof p['asset_id'] !== 'string' || typeof p['sha256'] !== 'string' || !isNum(p['byte_size']) || !isNum(p['page_count'])) return null;
  const pages = Array.isArray(p['pages'])
    ? (p['pages'] as unknown[]).filter((x): x is FixedFormPage => isNum((x as FixedFormPage)?.width) && isNum((x as FixedFormPage)?.height))
    : [];
  return { asset_id: p['asset_id'], sha256: p['sha256'], byte_size: p['byte_size'], page_count: p['page_count'], pages };
}

export interface FixedFormIssue {
  readonly code: string;
  readonly message: string;
  readonly field_key?: string;
  readonly role_key?: string;
}

/**
 * The field rules of a fixed form (§7.2) against its PDF and parsed roles. Returns every
 * problem (empty = publishable as far as fields go):
 *   - a PDF is uploaded and there is at least one field (at most 200);
 *   - field keys are unique lower_snake; types are the six Sign executes;
 *   - a TEXT field with a variable prefills it (no signer role, the variable must be one the
 *     type allows); every other field belongs to a SIGNER role;
 *   - each box lies on an existing page, inside it, at least 8 points each way;
 *   - every SIGNER role has at least one SIGNATURE field.
 */
export function fixedFormIssues(input: {
  pdf: FixedFormPdfRef | null;
  roles: readonly FixedFormRole[];
  fields: readonly FixedFormField[];
  allowedBindingKeys: ReadonlySet<string>;
}): FixedFormIssue[] {
  const out: FixedFormIssue[] = [];
  if (input.pdf === null) out.push({ code: 'pdf_required', message: 'Upload the official PDF.' });
  if (input.fields.length === 0) out.push({ code: 'fields_required', message: 'Place at least one field.' });
  if (input.fields.length > FIXED_FORM_MAX_FIELDS) out.push({ code: 'too_many_fields', message: `At most ${FIXED_FORM_MAX_FIELDS} fields.` });
  const signerKeys = new Set(input.roles.filter((r) => r.kind === 'SIGNER').map((r) => r.role_key));
  const keys = new Set<string>();
  for (const f of input.fields) {
    const at = { field_key: f.field_key };
    if (!FIELD_KEY_RE.test(f.field_key)) out.push({ code: 'field_key_invalid', message: `Field ${f.field_key} needs a lower_snake key.`, ...at });
    if (keys.has(f.field_key)) out.push({ code: 'field_key_duplicate', message: `Field ${f.field_key} is placed twice.`, ...at });
    keys.add(f.field_key);
    if (!isFixedFormFieldType(f.field_type)) {
      out.push({ code: 'field_type_invalid', message: `Field ${f.field_key} has a type Sign cannot execute.`, ...at });
      continue;
    }
    if (f.binding_key !== null) {
      if (f.field_type !== 'TEXT') out.push({ code: 'binding_not_text', message: `Only a text field can be prefilled (${f.field_key}).`, ...at });
      if (f.signer_role !== null) out.push({ code: 'binding_with_role', message: `A prefilled field belongs to no signer (${f.field_key}).`, ...at });
      if (!input.allowedBindingKeys.has(f.binding_key)) {
        out.push({ code: 'binding_unknown', message: `${f.binding_key} is not a variable of this document type.`, ...at });
      }
    } else if (f.signer_role === null || !signerKeys.has(f.signer_role)) {
      out.push({ code: 'field_role_invalid', message: `Field ${f.field_key} needs a signer role.`, ...at });
    }
    const { page_number: page, x, y, width, height } = f;
    if (page === null || x === null || y === null || width === null || height === null) {
      out.push({ code: 'field_position_required', message: `Field ${f.field_key} has no position.`, ...at });
      continue;
    }
    if (input.pdf === null) continue;
    const size = Number.isInteger(page) && page >= 0 ? input.pdf.pages[page] : undefined;
    if (size === undefined || page >= input.pdf.page_count) {
      out.push({ code: 'field_page_invalid', message: `Field ${f.field_key} is on a page the PDF does not have.`, ...at });
      continue;
    }
    if (width < FIXED_FORM_MIN_FIELD_SIZE || height < FIXED_FORM_MIN_FIELD_SIZE) {
      out.push({ code: 'field_too_small', message: `Field ${f.field_key} is too small.`, ...at });
    }
    const eps = 0.5;
    if (x < -eps || y < -eps || x + width > size.width + eps || y + height > size.height + eps) {
      out.push({ code: 'field_off_page', message: `Field ${f.field_key} goes past the page edge.`, ...at });
    }
  }
  for (const role_key of signerKeys) {
    if (!input.fields.some((f) => f.signer_role === role_key && f.field_type === 'SIGNATURE')) {
      out.push({ code: 'role_without_signature', message: `Signer role ${role_key} has no signature field.`, role_key });
    }
  }
  return out;
}
