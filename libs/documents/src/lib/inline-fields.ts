// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) — the rows of the fields an
// editable template places INSIDE its text (rtr-html-v3 markers; ruling R-1). Each marker's type,
// role and settings live in the version's TemplateFieldDefinition rows, with NULL geometry (F-3):
// positions are computed per render (R-3), never stored on the version.
//
// This module owns the row side (the request shape, its parse, the comparison a tenant save is
// held to); the content side (markers, places, fit) is the document type's capability
// (apps/api rtr-inline-fields.ts).

import { fieldTypesFor, parseTemplateFieldSettings, type TemplateFieldSettings } from '@aramo/sign-fields';
import { isInlineFieldKey } from '@aramo/template-content';

/** The types a field placed in the text may have (F-5: the template_inline catalog surface). */
export const INLINE_FIELD_TYPES: ReadonlySet<string> = new Set(fieldTypesFor('template_inline'));

/** One inline field row as a draft save writes it (no geometry). */
export interface InlineFieldRowInput {
  readonly field_key: string;
  readonly field_type: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly ordinal: number;
  readonly settings: TemplateFieldSettings;
}

export type InlineFieldRowsParse =
  | { readonly ok: true; readonly rows: InlineFieldRowInput[] }
  | { readonly ok: false; readonly reason: string; readonly message: string; readonly index?: number; readonly field?: string };

const ROW_MEMBERS = new Set([
  'field_key',
  'field_type',
  'signer_role',
  'required',
  'ordinal',
  'label',
  'group_key',
  'group_rule',
  'min_selected',
  'name_mode',
  'tooltip',
  'placeholder',
  'read_only',
  'sender_filled',
  'validation',
  'font_size',
  'data_name',
  'options',
  'condition',
]);

/**
 * Parse a draft save's `fields` member: an array (≤ 200) of rows. Geometry is never accepted
 * (inline rows keep NULL geometry, F-3). The settings follow the catalog (parseTemplateFieldSettings,
 * the same rule as POST …/fields; a sender-filled field only while the switch is on).
 */
export function parseInlineFieldRows(raw: unknown, opts: { sender_filled_enabled: boolean }): InlineFieldRowsParse {
  if (!Array.isArray(raw)) return { ok: false, reason: 'fields_invalid', message: 'fields must be an array' };
  if (raw.length > 200) return { ok: false, reason: 'fields_invalid', message: 'a template holds at most 200 fields' };
  const rows: InlineFieldRowInput[] = [];
  for (const [index, r] of raw.entries()) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, reason: 'fields_invalid', message: `field ${index + 1} must be an object`, index };
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!ROW_MEMBERS.has(k)) {
        return { ok: false, reason: 'fields_invalid', message: `field ${index + 1}: ${k} is not accepted (a field in the text has no page position)`, index, field: k };
      }
    }
    if (!isInlineFieldKey(o['field_key'])) {
      return { ok: false, reason: 'field_marker_mismatch', message: `field ${index + 1}: field_key must be lower snake case (at most 64)`, index, field: 'field_key' };
    }
    const field_type = o['field_type'];
    if (typeof field_type !== 'string' || !INLINE_FIELD_TYPES.has(field_type)) {
      return { ok: false, reason: 'field_type_invalid', message: `field ${index + 1}: this type cannot be placed in the text`, index, field: 'field_type' };
    }
    const role = o['signer_role'];
    if (role !== undefined && role !== null && (typeof role !== 'string' || role.length === 0 || role.length > 40)) {
      return { ok: false, reason: 'signing_roles_required', message: `field ${index + 1}: signer_role must name a signing role`, index, field: 'signer_role' };
    }
    const required = o['required'];
    if (required !== undefined && typeof required !== 'boolean') return { ok: false, reason: 'fields_invalid', message: `field ${index + 1}: required must be true or false`, index, field: 'required' };
    const ordinal = o['ordinal'] ?? index;
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 10000) {
      return { ok: false, reason: 'fields_invalid', message: `field ${index + 1}: ordinal must be a whole number`, index, field: 'ordinal' };
    }
    const parsed = parseTemplateFieldSettings(o, field_type, { sender_filled_enabled: opts.sender_filled_enabled });
    if (!parsed.ok) return { ok: false, reason: parsed.refusal.reason, message: `field ${index + 1}: ${parsed.refusal.message}`, index, field: parsed.refusal.setting };
    rows.push({
      field_key: o['field_key'] as string,
      field_type,
      signer_role: typeof role === 'string' ? role : null,
      required: required === true,
      ordinal,
      settings: parsed.settings,
    });
  }
  return { ok: true, rows };
}

/** A stored TemplateFieldDefinition row, as far as the inline rules read it. */
export interface StoredFieldRow {
  readonly field_key: string;
  readonly field_type: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly ordinal: number;
  readonly page_number?: number | null;
  readonly x?: number | null;
  readonly y?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly group_rule?: string | null;
  readonly min_selected?: number | null;
  readonly name_mode?: string | null;
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly read_only?: boolean;
  readonly sender_filled?: boolean;
  readonly validation?: string | null;
  readonly font_size?: number | null;
  readonly data_name?: string | null;
  readonly options?: unknown;
  readonly condition?: unknown;
}

/** A stored row as an inline row input (its settings as stored). */
export function inlineRowOf(r: StoredFieldRow): InlineFieldRowInput {
  return {
    field_key: r.field_key,
    field_type: r.field_type,
    signer_role: r.signer_role,
    required: r.required,
    ordinal: r.ordinal,
    settings: {
      label: r.label ?? null,
      group_key: r.group_key ?? null,
      group_rule: (r.group_rule ?? null) as TemplateFieldSettings['group_rule'],
      min_selected: r.min_selected ?? null,
      name_mode: (r.name_mode ?? null) as TemplateFieldSettings['name_mode'],
      tooltip: r.tooltip ?? null,
      placeholder: r.placeholder ?? null,
      read_only: r.read_only === true,
      sender_filled: r.sender_filled === true,
      validation: (r.validation ?? null) as TemplateFieldSettings['validation'],
      font_size: r.font_size ?? null,
      data_name: r.data_name ?? null,
      options: (r.options ?? null) as TemplateFieldSettings['options'],
      condition: (r.condition ?? null) as TemplateFieldSettings['condition'],
    },
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/** The comparable form of a row: key, type, role, required and every setting (not the ordinal). */
function signature(r: InlineFieldRowInput): string {
  return stable({ field_key: r.field_key, field_type: r.field_type, signer_role: r.signer_role, required: r.required, settings: r.settings });
}

/**
 * F-15 (ruling R-5) — whether `next` keeps exactly the field set of `current`: the same keys, and
 * for each key the same type, role, required flag and settings (the order may differ). A tenant
 * save that does not is refused (fields_platform_only).
 */
export function sameInlineFieldSet(current: readonly InlineFieldRowInput[], next: readonly InlineFieldRowInput[]): boolean {
  if (current.length !== next.length) return false;
  const a = current.map(signature).sort();
  const b = next.map(signature).sort();
  return a.every((s, i) => s === b[i]);
}

/** The setting columns of an inline row, for a create (absent JSON settings stay NULL). */
export function inlineRowColumns(r: InlineFieldRowInput): Record<string, unknown> {
  const s = r.settings;
  return {
    field_key: r.field_key,
    field_type: r.field_type,
    binding_key: null,
    required: r.required,
    page_number: null,
    x: null,
    y: null,
    width: null,
    height: null,
    format_rule: null,
    signer_role: r.signer_role,
    ordinal: r.ordinal,
    label: s.label,
    group_key: s.group_key,
    group_rule: s.group_rule,
    min_selected: s.min_selected,
    name_mode: s.name_mode,
    tooltip: s.tooltip,
    placeholder: s.placeholder,
    read_only: s.read_only,
    sender_filled: s.sender_filled,
    validation: s.validation,
    font_size: s.font_size,
    data_name: s.data_name,
    ...(s.options !== null ? { options: s.options } : {}),
    ...(s.condition !== null ? { condition: s.condition } : {}),
  };
}
