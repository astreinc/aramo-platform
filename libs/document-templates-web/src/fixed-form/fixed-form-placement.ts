// FIELD-PARITY-1 P1-5 — the console form Studio's adapter onto the shared placement editor
// (@aramo/field-placement-web): its wire fields (FixedFormField, PDF-native) ↔ PlacedField, the
// palette order / labels and the Studio's copy. Byte-compatible: a field read from the server
// goes back with the same keys in the same order, changed only where the editor changed it; a
// new field has exactly the shape the Studio sent before P1-5.

import { DEFAULT_SETTINGS, DEFAULT_PLACEMENT_COPY, type PlacedField, type PlacementCopy } from '@aramo/field-placement-web';
import { DEFAULT_CHECKBOX_GROUP_RULE, DEFAULT_SIGNER_NAME_MODE, type FieldTypeKey } from '@aramo/sign-fields';

import { FIXED_FORM_FIELD_TYPES, type FixedFormField } from './fixed-form-model';

/** The one document a fixed form has. */
export const FIXED_FORM_DOC_ID = 'form';

export const FIXED_FORM_PALETTE: { readonly labels: Partial<Record<FieldTypeKey, string>>; readonly order: readonly FieldTypeKey[] } = {
  labels: Object.fromEntries(FIXED_FORM_FIELD_TYPES.map((t) => [t.type, t.label])),
  order: FIXED_FORM_FIELD_TYPES.map((t) => t.type),
};

export const FIXED_FORM_EDITOR_COPY: PlacementCopy = {
  ...DEFAULT_PLACEMENT_COPY,
  leftLabel: 'Form setup',
  rightLabel: 'Field and checks',
  centerLabel: 'Form pages',
  assigneesTitle: 'For',
  paletteTitle: 'Place a field',
  assigneeLabel: 'Filled by',
  inspectorTitle: 'Field',
  noSelection: 'Select a field on the form.',
  unassigned: 'No role',
};

/** Wire → editor. A field without a position is kept (hidden) so it round-trips unchanged. */
export function fixedFormFieldsToPlaced(fields: readonly FixedFormField[]): PlacedField[] {
  return fields.map((f) => {
    const placed = f.page_number !== null && f.x !== null && f.y !== null && f.width !== null && f.height !== null;
    return {
      id: f.field_key,
      type: f.field_type,
      docId: FIXED_FORM_DOC_ID,
      page: f.page_number ?? 0,
      x: f.x ?? 0,
      y: f.y ?? 0,
      width: f.width ?? 0,
      height: f.height ?? 0,
      required: f.required,
      assignee: f.signer_role,
      binding: f.binding_key,
      settings: settingsFromWire(f),
      ...(placed ? {} : { hidden: true }),
    };
  });
}

/** P1-3 — the stored settings → the editor's settings (unset → the editor defaults). */
function settingsFromWire(f: FixedFormField): PlacedField['settings'] {
  return {
    ...DEFAULT_SETTINGS,
    nameMode: (f.name_mode ?? DEFAULT_SIGNER_NAME_MODE) as PlacedField['settings']['nameMode'],
    label: f.label ?? '',
    groupKey: f.group_key ?? '',
    groupRule: (f.group_rule ?? DEFAULT_CHECKBOX_GROUP_RULE) as PlacedField['settings']['groupRule'],
    minSelected: f.min_selected ?? null,
  };
}

/**
 * P1-3 — the editor's settings → wire members, only for the types that take them (the server's
 * rule, @aramo/sign-fields parseTemplateFieldSettings). An unset setting is sent as null so a
 * cleared value clears; SIGNER_NAME's default (SIGNER_PROFILE) is stored as NULL.
 */
function settingsToWire(p: PlacedField): Partial<FixedFormField> {
  if (p.type === 'CHECKBOX') {
    const grouped = p.settings.groupKey.trim() !== '';
    return {
      label: p.settings.label.trim() === '' ? null : p.settings.label.trim(),
      group_key: grouped ? p.settings.groupKey.trim() : null,
      group_rule: grouped ? p.settings.groupRule : null,
      min_selected: grouped ? p.settings.minSelected : null,
    };
  }
  if (p.type === 'SIGNER_NAME') {
    return { name_mode: p.settings.nameMode === DEFAULT_SIGNER_NAME_MODE ? null : p.settings.nameMode };
  }
  return {};
}

/** Has the editor changed any setting from what was stored? Unchanged fields round-trip byte-equal. */
function settingsChanged(p: PlacedField, orig: FixedFormField): boolean {
  const before = settingsFromWire(orig);
  const s = p.settings;
  return s.nameMode !== before.nameMode || s.label !== before.label || s.groupKey !== before.groupKey || s.groupRule !== before.groupRule || s.minSelected !== before.minSelected;
}

/** Editor → wire, in editor order, `ordinal` = position (as before P1-5), with P1-3 settings. */
export function fixedFormFieldsToWire(placed: readonly PlacedField[], stored: ReadonlyMap<string, FixedFormField>): FixedFormField[] {
  return placed.map((p, i) => {
    const orig = stored.get(p.id);
    if (p.hidden === true && orig !== undefined) return { ...orig, ordinal: i };
    const base: FixedFormField = orig ?? {
      field_key: p.id,
      field_type: p.type,
      binding_key: null,
      signer_role: null,
      required: p.required,
      page_number: p.page,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      ordinal: i,
    };
    const settings = orig === undefined || settingsChanged(p, orig) ? settingsToWire(p) : {};
    return { ...base, field_type: p.type, binding_key: p.binding, signer_role: p.assignee, required: p.required, page_number: p.page, x: p.x, y: p.y, width: p.width, height: p.height, ordinal: i, ...settings };
  });
}
