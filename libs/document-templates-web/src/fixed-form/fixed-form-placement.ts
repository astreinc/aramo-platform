// FIELD-PARITY-1 P1-5 — the console form Studio's adapter onto the shared placement editor
// (@aramo/field-placement-web): its wire fields (FixedFormField, PDF-native) ↔ PlacedField, the
// palette order / labels and the Studio's copy. Byte-compatible: a field read from the server
// goes back with the same keys in the same order, changed only where the editor changed it; a
// new field has exactly the shape the Studio sent before P1-5.

import { DEFAULT_PLACEMENT_COPY, settingsFromWire, settingsToWire, type PlacedField, type PlacementCopy } from '@aramo/field-placement-web';
import { TEMPLATE_FIELD_SETTINGS, type FieldSetting, type FieldTypeKey } from '@aramo/sign-fields';

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
      settings: settingsFromStored(f),
      ...(placed ? {} : { hidden: true }),
    };
  });
}

/** P1-3 / P3 — the stored settings → the editor's settings (unset → the editor defaults). */
function settingsFromStored(f: FixedFormField): PlacedField['settings'] {
  return settingsFromWire(f);
}

/**
 * FIELD-PARITY-1 P3 §6.2 — the settings the Studio edits: every template setting except
 * sender-filled and read-only. The fixed-form view does not say whether sender-filled fields are
 * switched on (the server flag SIGN_SENDER_FILLED_FIELDS_ENABLED; they ship dark), so the Studio
 * does not offer them; a stored one is kept (round-trips) and still shown on the field.
 */
export const FIXED_FORM_SETTINGS: readonly FieldSetting[] = TEMPLATE_FIELD_SETTINGS.filter((k) => k !== 'sender_filled' && k !== 'read_only');

/**
 * P1-3 / P3 — the editor's settings → wire members, only the settings the type takes (the
 * catalog; the server's rule, @aramo/sign-fields parseTemplateFieldSettings). A new field sends
 * only what is set; an edited stored field sends every setting its type takes, NULL when unset,
 * so a cleared value clears. SIGNER_NAME's default (SIGNER_PROFILE) is stored as NULL.
 */
function settingsToStored(p: PlacedField, isNew: boolean): Partial<FixedFormField> {
  return settingsToWire(p.type, p.settings, { members: isNew ? 'set' : 'all', nameModeDefaultNull: true }) as Partial<FixedFormField>;
}

/** Has the editor changed any setting from what was stored? Unchanged fields round-trip byte-equal. */
function settingsChanged(p: PlacedField, orig: FixedFormField): boolean {
  return JSON.stringify(p.settings) !== JSON.stringify(settingsFromStored(orig));
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
    const settings = orig === undefined ? settingsToStored(p, true) : settingsChanged(p, orig) ? settingsToStored(p, false) : {};
    return { ...base, field_type: p.type, binding_key: p.binding, signer_role: p.assignee, required: p.required, page_number: p.page, x: p.x, y: p.y, width: p.width, height: p.height, ordinal: i, ...settings };
  });
}
