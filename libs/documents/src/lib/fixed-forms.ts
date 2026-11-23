// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — fixed legal forms. The
// content contract of a FIXED_FORM document type's template version, and the field rules
// that do not depend on apps/api (the signing roles are parsed with the shared rtr-html-v1
// signing parser in apps/api, so the role rules are the same everywhere).
//
// A fixed form is the official PDF (PlatformTemplateAsset, uploaded by Platform Admin) with
// fields placed over it by signer role (TemplateFieldDefinition). It is never adopted and
// never edited by a tenant (§7.3). Field geometry is PDF-native, exactly what Sign places:
// page_number 0-based, points, origin bottom-left, (x, y) the box's lower-left corner.

import { checkboxGroupIssues, fieldConditionIssues, fieldTypesFor, isFieldTypeOn, type FieldCondition, type FieldTypeOn } from '@aramo/sign-fields';

/** field_schema.render_schema_version of a fixed-form version. */
export const FIXED_FORM_SCHEMA_V1 = 'fixed-form-pdf-v1';

/** §7.1 — the official PDF: PDF only, at most 10 MB. */
export const FIXED_FORM_MAX_BYTES = 10 * 1024 * 1024;
export const FIXED_FORM_MIME = 'application/pdf';

/** §7.1 — the platform prefix of the documents bucket (DB CHECK: documents/platform/%). */
export const PLATFORM_TEMPLATE_ASSET_PREFIX = 'documents/platform/template-assets';

/**
 * §7.2 — the field types a fixed form may place: originally the intersection Aramo Sign
 * executed (text, date, checkbox, name, signature, initials). FIELD-PARITY-1 P1-2 — the
 * catalog's `template_fixed_form` surface (@aramo/sign-fields), in catalog order; P1-6: never
 * PAYMENT. P3 (ruling R-1, superseding TEMPLATE-PRODUCT-1 §7 line 126) — every type the
 * catalog allows on a template surface: + the profile types, ACKNOWLEDGEMENT, DATE (a chosen
 * date), DROPDOWN, RADIO, NUMBER and MULTILINE_TEXT.
 */
export const FIXED_FORM_FIELD_TYPES: readonly FieldTypeOn<'template_fixed_form'>[] = fieldTypesFor('template_fixed_form');
export type FixedFormFieldType = FieldTypeOn<'template_fixed_form'>;

export const FIXED_FORM_MAX_FIELDS = 200;
export const FIXED_FORM_MIN_FIELD_SIZE = 8;
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isFixedFormFieldType(v: unknown): v is FixedFormFieldType {
  return isFieldTypeOn('template_fixed_form', v);
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
  // FIELD-PARITY-1 P1-3 — the Sign field settings (M-A6 §2; @aramo/sign-fields
  // parseTemplateFieldSettings decides which type takes which). Absent / NULL = not set.
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
  // FIELD-PARITY-2 B-2 — "show only when" ({ trigger_key, when, values? }; NULL = always shown).
  readonly condition?: unknown;
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
 *   - every SIGNER role has at least one SIGNATURE field;
 *   - FIELD-PARITY-1 P1-3 — the boxes of a check-box group share one signer role, rule,
 *     minimum and required setting, and the minimum is not more than the boxes (Sign's rule).
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
    // FIELD-PARITY-2 C-6 — a signature field that is always shown (a conditional one may never be).
    if (!input.fields.some((f) => f.signer_role === role_key && f.field_type === 'SIGNATURE' && (f.condition === undefined || f.condition === null))) {
      out.push({ code: 'role_without_signature', message: `Signer role ${role_key} has no signature field.`, role_key });
    }
  }
  const grouped = input.fields.map((f) => ({
    field_key: f.field_key,
    signer_role: f.signer_role,
    required: f.required,
    group_key: f.group_key ?? null,
    group_rule: f.group_rule ?? null,
    min_selected: f.min_selected ?? null,
    // FIELD-PARITY-1 P3 — a group is one type (check boxes or radio buttons) and one
    // read-only / sender-filled setting.
    field_type: f.field_type,
    read_only: f.read_only === true,
    sender_filled: f.sender_filled === true,
  }));
  for (const g of checkboxGroupIssues(grouped)) {
    const first = grouped.find((f) => f.group_key === g.group_key);
    out.push({ code: g.reason, message: g.message, ...(first !== undefined ? { field_key: first.field_key } : {}) });
  }
  // FIELD-PARITY-2 B-3 — the one cross-field condition rule (duplicate keys are reported above;
  // the unconditional-SIGNATURE rule is role_without_signature above).
  for (const c of fixedFormConditionIssues(input.fields, { requireUnconditionalSignature: false })) {
    if (c.reason === 'field_key_duplicate') continue;
    out.push({ code: c.reason, message: `Field ${c.field_key ?? ''}: ${c.message}.`, ...(c.field_key !== null ? { field_key: c.field_key } : {}) });
  }
  return out;
}

/**
 * FIELD-PARITY-2 B-3 — a fixed form's fields through the one cross-field condition rule
 * (@aramo/sign-fields fieldConditionIssues): a field's signer is its signer role (a prefilled
 * field has none). Used by the publish issues above and by the console save routes.
 */
export function fixedFormConditionIssues(fields: readonly FixedFormField[], opts: { readonly requireUnconditionalSignature?: boolean } = {}) {
  return fieldConditionIssues(
    fields.map((f) => ({
      field_key: f.field_key,
      field_type: f.field_type,
      signer: f.signer_role,
      condition: (f.condition ?? null) as FieldCondition | null,
      options: (f.options ?? null) as { choices?: { value: string }[] } | null,
      sender_filled: f.sender_filled === true,
    })),
    opts,
  );
}
