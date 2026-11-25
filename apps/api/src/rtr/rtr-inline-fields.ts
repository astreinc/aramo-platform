// TEMPLATE-FIELDS-1 (Aramo-Template-Fields-1-Directive-v1_0-LOCKED) — the rules that hold the
// inline field markers of editable content and the version's TemplateFieldDefinition rows
// together (ruling R-1: the content holds only an empty marker; the rows hold type, role and
// settings; the server keeps them consistent).
//
//   F-3  each marker key has exactly one row and each row one marker (field_marker_mismatch,
//        details.missing / .orphans; a repeated key: field_marker_duplicate);
//   F-6  every field names a SIGNER role of `signing`, or is sender-filled; a template with inline
//        fields needs signing roles (signing_roles_required);
//   F-9  a box wider than its space is refused at save (field_too_wide, the field and the place);
//   F-17 an `ats` template cannot have inline fields (inline_fields_not_supported_for_ats).
//
// Box sizes are the field catalog's defaults for the field's type (F-8: supplied by the domain,
// so documents-rendering never imports the catalog).

import { FIELD_CATALOG, fieldConditionIssues, isFieldTypeKey, type FieldCondition } from '@aramo/sign-fields';
import { inlineFieldMaxWidth, type InlineFieldPlace } from '@aramo/documents-rendering';
import { type InlineFieldRowInput } from '@aramo/documents';

import { collectInlineFieldMarkers, type HtmlNode, type InlineFieldMarker, type InlineFieldBox, type RtrSigningConfig } from './rtr-html-content.js';

export interface InlineFieldIssue {
  reason:
    | 'field_marker_mismatch'
    | 'field_marker_duplicate'
    | 'signing_roles_required'
    | 'field_too_wide'
    | 'inline_fields_not_supported_for_ats'
    | 'fields_platform_only'
    // A condition's own reason (FIELD-PARITY-2 B-3), as POST …/fields refuses it.
    | (string & {});
  message: string;
  details: Record<string, unknown>;
}

/** The catalog default size of a field type (null for a type the catalog does not know). */
export function inlineFieldSize(field_type: string): { width: number; height: number } | null {
  if (!isFieldTypeKey(field_type)) return null;
  const e = FIELD_CATALOG[field_type];
  return { width: e.width, height: e.height };
}

/** F-8 — the box sizes of a version's inline rows, by key. */
export function inlineFieldBoxes(rows: readonly Pick<InlineFieldRowInput, 'field_key' | 'field_type'>[]): InlineFieldBox {
  const byKey = new Map(rows.map((r) => [r.field_key, inlineFieldSize(r.field_type)]));
  return (key) => byKey.get(key) ?? null;
}

function placeName(place: InlineFieldPlace): string {
  return place.in === 'paragraph' ? 'paragraph' : place.in === 'list' ? 'list_item' : 'table_cell';
}

/**
 * F-3 / F-6 / F-9 — the first issue of content markers against the rows, or null. Markers are
 * already known to sit in allowed places with valid, unique keys (sanitizeRtrHtml, F-2).
 */
export function inlineFieldIssue(input: {
  nodes: readonly HtmlNode[];
  rows: readonly InlineFieldRowInput[];
  signing: RtrSigningConfig | undefined;
}): InlineFieldIssue | null {
  const markers: InlineFieldMarker[] = collectInlineFieldMarkers(input.nodes);
  const { rows } = input;
  if (markers.length === 0 && rows.length === 0) return null;

  // F-3 — a key repeated among the rows.
  const rowKeys = new Set<string>();
  const dupRows = new Set<string>();
  for (const r of rows) (rowKeys.has(r.field_key) ? dupRows : rowKeys).add(r.field_key);
  if (dupRows.size > 0) {
    return { reason: 'field_marker_duplicate', message: 'A field key is used twice', details: { keys: [...dupRows] } };
  }
  // F-3 — every marker has its row and every row its marker.
  const markerKeys = new Set(markers.map((m) => m.key));
  const missing = [...markerKeys].filter((k) => !rowKeys.has(k));
  const orphans = rows.map((r) => r.field_key).filter((k) => !markerKeys.has(k));
  if (missing.length > 0 || orphans.length > 0) {
    return {
      reason: 'field_marker_mismatch',
      message: 'The fields in the text and the field list do not match',
      details: { missing, orphans },
    };
  }

  // F-6 — signing roles: every field names a SIGNER role, or is sender-filled.
  const signerKeys = new Set((input.signing?.roles ?? []).filter((r) => r.kind === 'SIGNER').map((r) => r.role_key));
  if (signerKeys.size === 0) {
    return { reason: 'signing_roles_required', message: 'A template with fields in its text needs signing roles', details: { keys: rows.map((r) => r.field_key) } };
  }
  const roleless = rows
    .filter((r) => (r.signer_role === null ? r.settings.sender_filled !== true : !signerKeys.has(r.signer_role)))
    .map((r) => r.field_key);
  if (roleless.length > 0) {
    return {
      reason: 'signing_roles_required',
      message: 'Every field needs a signing role (or is filled by the sender)',
      details: { keys: roleless },
    };
  }

  // F-9 — every box fits where it sits.
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  for (const m of markers) {
    const row = byKey.get(m.key);
    const size = row === undefined ? null : inlineFieldSize(row.field_type);
    if (m.place === null || size === null) continue;
    const max = inlineFieldMaxWidth(m.place);
    if (size.width > max) {
      return {
        reason: 'field_too_wide',
        message: `The ${row?.field_type ?? 'field'} field ${m.key} is too wide for its ${placeName(m.place).replace('_', ' ')}`,
        details: { field_key: m.key, field_type: row?.field_type, place: placeName(m.place), width: size.width, max_width: max },
      };
    }
  }

  // FIELD-PARITY-2 B-3 — the one cross-field rule (conditions) over the inline rows.
  const [cond] = fieldConditionIssues(
    rows.map((r) => ({
      field_key: r.field_key,
      field_type: r.field_type,
      signer: r.signer_role,
      condition: (r.settings.condition ?? null) as FieldCondition | null,
      options: (r.settings.options ?? null) as { choices?: { value: string }[] } | null,
      sender_filled: r.settings.sender_filled,
    })),
    { requireUnconditionalSignature: false },
  );
  if (cond !== undefined) return { reason: cond.reason, message: cond.message, details: { field_key: cond.field_key } };
  return null;
}

/** Whether canonical content holds any inline field marker. */
export function hasInlineFields(nodes: readonly HtmlNode[]): boolean {
  return collectInlineFieldMarkers(nodes).length > 0;
}

/** F-13 — "Signature · Employee" / "Text · Sender fills it" for the preview box. */
export function inlineFieldLabeller(rows: readonly InlineFieldRowInput[], signing: RtrSigningConfig | undefined): (key: string) => string | null {
  const roleLabel = new Map((signing?.roles ?? []).map((r) => [r.role_key, r.label]));
  const byKey = new Map(rows.map((r) => [r.field_key, r]));
  return (key) => {
    const r = byKey.get(key);
    if (r === undefined) return null;
    const type = isFieldTypeKey(r.field_type) ? FIELD_CATALOG[r.field_type].label : r.field_type;
    const who = r.signer_role !== null ? (roleLabel.get(r.signer_role) ?? r.signer_role) : 'Sender fills it';
    return `${r.settings.label ?? type} · ${who}`;
  };
}
