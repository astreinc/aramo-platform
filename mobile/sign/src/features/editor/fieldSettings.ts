// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6.2 —
// the field settings in the app's sender editor: which settings a field shows (the catalog's
// fieldSettingsOf, the same rule the web editor uses, from @aramo/sign-client), the editor field
// ↔ the wire members, and the ONE settings rule (parseFieldSettings) run on the editor's field so
// the settings sheet shows the server's refusal before the draft syncs. Pure: unit-tested.
import {
  VALIDATIONS_BY_TYPE,
  editableFieldSettings,
  fieldSettingsOf,
  senderEditorSettings,
  fieldValueRefusal,
  isFieldTypeKey,
  parseFieldSettings,
  type DropdownChoice,
  type FieldOptions,
  type FieldSetting,
  type FieldSettingRefusalReason,
  type FieldValidation,
  type FieldValueRefusalReason,
} from '@aramo/sign-client';

/** The P3 settings an editor field may carry (absent = not set). */
export interface EditorFieldSettings {
  /** S-1 — the hint shown to the signer. */
  readonly tooltip?: string | null;
  /** S-2 — placeholder text. */
  readonly placeholder?: string | null;
  /** S-4 — not editable by the signer (only with senderFilled). */
  readonly readOnly?: boolean;
  /** S-5 (dark) — the sender fills the value before sending. */
  readonly senderFilled?: boolean;
  /** S-5 — the sender's value of a sender-filled field. */
  readonly senderValue?: string | null;
  /** S-6 — the validation preset. */
  readonly validation?: FieldValidation | null;
  /** S-7 — null / absent = auto; a number = fixed points. */
  readonly fontSize?: number | null;
  /** S-9 — the stable data key. */
  readonly dataName?: string | null;
  /** The per-type options (DROPDOWN choices, NUMBER format, validation parameters), wire shape. */
  readonly options?: FieldOptions | null;
}

/** The fields of an editor field the settings rules read. */
export interface SettingsField extends EditorFieldSettings {
  readonly type: string;
  readonly nameMode?: string | null;
  readonly label?: string | null;
  readonly groupKey?: string | null;
  readonly groupRule?: string | null;
  readonly minSelected?: number | null;
}

/** The choices a new DROPDOWN starts with (the server refuses a dropdown without choices). */
export const NEW_DROPDOWN_CHOICES: readonly DropdownChoice[] = [
  { value: 'Option 1', label: 'Option 1' },
  { value: 'Option 2', label: 'Option 2' },
];

/** The types whose fields form groups (a check-box group; a radio group, T-5). */
export function isGroupedType(type: string): boolean {
  return type === 'CHECKBOX' || type === 'RADIO';
}

/**
 * The settings a field's sheet shows. FIELD-PARITY-2 A-7 — the shared projection the web editor
 * uses too (@aramo/sign-client editableFieldSettings): the catalog's list for its type ∩ what an
 * envelope sender's editor authors (senderEditorSettings: never the PAYMENT amount; sender-filled
 * and read-only only while the server says they are on, sender_filled_fields_enabled).
 */
export function editableSettings(type: string, senderFilledEnabled: boolean): readonly FieldSetting[] {
  return editableFieldSettings(type, senderEditorSettings(senderFilledEnabled));
}

/** Whether a type has anything for the settings sheet. */
export function hasSettings(type: string, senderFilledEnabled: boolean): boolean {
  return editableSettings(type, senderFilledEnabled).length > 0;
}

const text = (v: string | null | undefined): string => (v ?? '').trim();

/** A DROPDOWN's choices as sent: trimmed, blank rows dropped, a blank value = its label. */
export function cleanChoices(choices: readonly DropdownChoice[] | undefined): DropdownChoice[] {
  return (choices ?? []).flatMap((c) => {
    const label = text(c.label);
    const value = text(c.value) || label;
    return value.length === 0 ? [] : [{ value, label: label || value }];
  });
}

/** The options a type sends: only its keys, and a validation parameter only with its preset. */
export function optionsWire(type: string, validation: FieldValidation | null, o: FieldOptions | null | undefined): FieldOptions | null {
  const src = o ?? {};
  const out: { -readonly [K in keyof FieldOptions]: FieldOptions[K] } = {};
  if (type === 'DROPDOWN') out.choices = cleanChoices(src.choices);
  if (type === 'NUMBER') {
    if (src.format === 'money') {
      out.format = 'money';
      if (src.currency) out.currency = src.currency;
    }
    if (typeof src.decimals === 'number') out.decimals = src.decimals;
    if (validation === 'number_range') {
      if (typeof src.min === 'number') out.min = src.min;
      if (typeof src.max === 'number') out.max = src.max;
    }
  }
  if (type === 'DATE' && validation === 'date_range') {
    if (src.min_date) out.min_date = src.min_date;
    if (src.max_date) out.max_date = src.max_date;
  }
  if ((type === 'TEXT' || type === 'MULTILINE_TEXT') && validation === 'max_length' && typeof src.max_length === 'number') {
    out.max_length = src.max_length;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The P3 setting members a field sends (FIELD-PARITY-1 §6.2): only the settings its type takes
 * (the catalog) and that are set, trimmed; the sender's value only on a sender-filled field
 * (S-5 — every other value is refused: sender_value_refused). The M-A6 members (name mode,
 * label and group of a check box) are syncDraft's configWire.
 */
export function p3SettingsWire(f: SettingsField): Record<string, unknown> {
  if (!isFieldTypeKey(f.type)) return {};
  const takes = new Set<FieldSetting>(fieldSettingsOf(f.type));
  const out: Record<string, unknown> = {};
  const put = (k: FieldSetting, v: unknown, isSet: boolean) => {
    if (takes.has(k) && isSet) out[k] = v;
  };
  put('tooltip', text(f.tooltip), text(f.tooltip).length > 0);
  put('placeholder', text(f.placeholder), text(f.placeholder).length > 0);
  const senderFilled = f.senderFilled === true;
  put('read_only', true, senderFilled && f.readOnly === true);
  put('sender_filled', true, senderFilled);
  const validation = f.validation && (VALIDATIONS_BY_TYPE[f.type] ?? []).includes(f.validation) ? f.validation : null;
  put('validation', validation, validation !== null);
  put('font_size', f.fontSize, typeof f.fontSize === 'number');
  put('data_name', text(f.dataName), text(f.dataName).length > 0);
  const options = takes.has('options') ? optionsWire(f.type, validation, f.options) : null;
  put('options', options, options !== null);
  if (senderFilled && takes.has('sender_filled') && f.senderValue != null && f.senderValue !== '') out['value'] = f.senderValue;
  return out;
}

/** Every setting member of the field (M-A6 + P3), as the settings rule reads a request body. */
function wireForRule(f: SettingsField): Record<string, unknown> {
  const takes = isFieldTypeKey(f.type) ? new Set<FieldSetting>(fieldSettingsOf(f.type)) : new Set<FieldSetting>();
  const label = text(f.label);
  const grouped = isGroupedType(f.type) && text(f.groupKey).length > 0;
  return {
    ...(takes.has('name_mode') && f.nameMode ? { name_mode: f.nameMode } : {}),
    ...(takes.has('label') && label.length > 0 ? { label } : {}),
    ...(grouped ? { group_key: text(f.groupKey) } : {}),
    ...(grouped && f.type === 'CHECKBOX' && f.groupRule ? { group_rule: f.groupRule } : {}),
    ...(grouped && f.type === 'CHECKBOX' && f.groupRule !== 'SELECT_ONE' && f.minSelected != null ? { min_selected: f.minSelected } : {}),
    ...p3SettingsWire(f),
  };
}

/** The ONE settings rule's refusal for this field (parseFieldSettings), or null. */
export function settingsIssue(f: SettingsField, senderFilledEnabled: boolean): { readonly reason: FieldSettingRefusalReason; readonly message: string } | null {
  if (!isFieldTypeKey(f.type)) return null;
  const parsed = parseFieldSettings(wireForRule(f), f.type, { sender_filled_enabled: senderFilledEnabled });
  return parsed.ok ? null : { reason: parsed.refusal.reason, message: parsed.refusal.message };
}

/** The value rule's refusal of the sender's value (fieldValueRefusal), or null. */
export function senderValueIssue(f: SettingsField): FieldValueRefusalReason | null {
  if (f.senderFilled !== true || f.senderValue == null || f.senderValue === '') return null;
  const validation = f.validation ?? null;
  return fieldValueRefusal({ field_type: f.type, validation, options: optionsWire(f.type, validation, f.options) }, f.senderValue);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored field's P3 settings → the editor field's (absent where unset). */
export function settingsFromServer(f: {
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly read_only?: boolean;
  readonly sender_filled?: boolean;
  readonly validation?: string | null;
  readonly font_size?: number | null;
  readonly data_name?: string | null;
  readonly options?: unknown;
  readonly value?: string | null;
}): EditorFieldSettings {
  return {
    ...(f.tooltip ? { tooltip: f.tooltip } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.read_only === true ? { readOnly: true } : {}),
    ...(f.sender_filled === true ? { senderFilled: true } : {}),
    ...(f.sender_filled === true && typeof f.value === 'string' ? { senderValue: f.value } : {}),
    ...(f.validation ? { validation: f.validation as FieldValidation } : {}),
    ...(typeof f.font_size === 'number' ? { fontSize: f.font_size } : {}),
    ...(f.data_name ? { dataName: f.data_name } : {}),
    ...(isObject(f.options) ? { options: f.options as FieldOptions } : {}),
  };
}
