// FIELD-PARITY-1 P1-5 — the console form Studio's adapter onto the shared placement editor
// (@aramo/field-placement-web): its wire fields (FixedFormField, PDF-native) ↔ PlacedField, the
// palette order / labels and the Studio's copy. Byte-compatible: a field read from the server
// goes back with the same keys in the same order, changed only where the editor changed it; a
// new field has exactly the shape the Studio sent before P1-5.

import { DEFAULT_SETTINGS, DEFAULT_PLACEMENT_COPY, type PlacedField, type PlacementCopy } from '@aramo/field-placement-web';
import { type FieldTypeKey } from '@aramo/sign-fields';

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
      settings: DEFAULT_SETTINGS,
      ...(placed ? {} : { hidden: true }),
    };
  });
}

/**
 * Editor → wire, in editor order, `ordinal` = position (as before P1-5). Settings are not sent:
 * the template API stores none until P1-3 (the Studio passes capabilities.settings = []).
 */
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
    return { ...base, field_type: p.type, binding_key: p.binding, signer_role: p.assignee, required: p.required, page_number: p.page, x: p.x, y: p.y, width: p.width, height: p.height, ordinal: i };
  });
}
