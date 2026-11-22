// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6.2 —
// the editor's settings ↔ the wire setting members, shared by every host of the editor (sign-web
// Prepare: the Sign sender API; the console Studio: the platform fixed-form API). Both APIs run
// the ONE settings rule (@aramo/sign-fields parseFieldSettings), so the editor checks a field's
// settings with that same rule (settingsIssue) and shows the refusal before the host saves.
//
// Pure: no React, no host type.

import {
  DEFAULT_SIGNER_NAME_MODE,
  VALIDATIONS_BY_TYPE,
  fieldSettingsOf,
  isFieldTypeKey,
  parseFieldSettings,
  type DropdownChoice,
  type FieldOptions,
  type FieldSetting,
  type FieldSettingRefusal,
  type FieldValidation,
} from '@aramo/sign-fields';

import { DEFAULT_SETTINGS, isGroupedType, type GroupRule, type NameMode, type PlacedField, type PlacementSettings } from './model';

/** The setting members of one wire field (NULL / absent / false = not set). */
export interface WireSettings {
  readonly name_mode?: string | null;
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly group_rule?: string | null;
  readonly min_selected?: number | null;
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly read_only?: boolean | null;
  readonly sender_filled?: boolean | null;
  readonly validation?: string | null;
  readonly font_size?: number | null;
  readonly data_name?: string | null;
  readonly options?: unknown;
  /** S-5 — the sender's value of a sender-filled field (the Sign sender API only). */
  readonly value?: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored field's settings → the editor's (unset → the editor defaults). */
export function settingsFromWire(w: WireSettings): PlacementSettings {
  const validation = typeof w.validation === 'string' ? (w.validation as FieldValidation) : '';
  return {
    ...DEFAULT_SETTINGS,
    nameMode: (w.name_mode === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : DEFAULT_SIGNER_NAME_MODE) as NameMode,
    label: w.label ?? '',
    groupKey: w.group_key ?? '',
    groupRule: (w.group_rule === 'SELECT_ONE' ? 'SELECT_ONE' : 'SELECT_ANY') as GroupRule,
    minSelected: w.min_selected ?? null,
    tooltip: w.tooltip ?? '',
    placeholder: w.placeholder ?? '',
    readOnly: w.read_only === true,
    senderFilled: w.sender_filled === true,
    senderValue: w.sender_filled === true && typeof w.value === 'string' ? w.value : '',
    validation,
    fontSize: typeof w.font_size === 'number' ? w.font_size : null,
    dataName: w.data_name ?? '',
    options: isObject(w.options) ? (w.options as FieldOptions) : null,
  };
}

/** The settings a type takes (the catalog), as a set. */
function takes(type: string): ReadonlySet<FieldSetting> {
  return new Set(isFieldTypeKey(type) ? fieldSettingsOf(type) : []);
}

/** A DROPDOWN's choices as the editor sends them: trimmed, blank rows dropped, a blank value = its label. */
export function cleanChoices(choices: readonly DropdownChoice[] | undefined): DropdownChoice[] {
  return (choices ?? []).flatMap((c) => {
    const label = (c.label ?? '').trim();
    const value = (c.value ?? '').trim() || label;
    return value.length === 0 ? [] : [{ value, label: label || value }];
  });
}

/**
 * The options a type sends with its validation preset: only the keys the type takes, and a
 * validation parameter only while its preset is chosen (the server refuses a stray one).
 */
export function optionsToWire(type: string, validation: FieldValidation | '', o: FieldOptions | null): FieldOptions | null {
  const out: { -readonly [K in keyof FieldOptions]: FieldOptions[K] } = {};
  const src = o ?? {};
  if (type === 'DROPDOWN') out.choices = cleanChoices(src.choices);
  if (type === 'NUMBER') {
    if (src.format === 'money') {
      out.format = 'money';
      if (src.currency !== undefined && src.currency !== '') out.currency = src.currency;
    }
    if (typeof src.decimals === 'number') out.decimals = src.decimals;
  }
  if (validation === 'number_range' && type === 'NUMBER') {
    if (typeof src.min === 'number') out.min = src.min;
    if (typeof src.max === 'number') out.max = src.max;
  }
  if (validation === 'date_range' && type === 'DATE') {
    if (src.min_date !== undefined && src.min_date !== '') out.min_date = src.min_date;
    if (src.max_date !== undefined && src.max_date !== '') out.max_date = src.max_date;
  }
  if (validation === 'max_length' && (type === 'TEXT' || type === 'MULTILINE_TEXT') && typeof src.max_length === 'number') out.max_length = src.max_length;
  return Object.keys(out).length > 0 ? out : null;
}

export interface SettingsToWireOptions {
  /**
   * 'set' (a new field; sign-web): only the members that are set. 'all' (an edited stored
   * template field; console): every member the type takes, NULL when unset, so a cleared
   * setting clears.
   */
  readonly members?: 'set' | 'all';
  /** S-5 — send the sender's value of a sender-filled field (sign-web). */
  readonly senderValues?: boolean;
  /** SIGNER_NAME's default (SIGNER_PROFILE) as NULL (the template store's convention). */
  readonly nameModeDefaultNull?: boolean;
}

/**
 * The editor's settings → the wire setting members a type takes (the catalog's list), trimmed.
 * Members come in the M-A6 order (name_mode, label, group_key, group_rule, min_selected), then the
 * P3 settings, then `value`.
 */
export function settingsToWire(type: string, s: PlacementSettings, opts: SettingsToWireOptions = {}): Record<string, unknown> {
  const all = opts.members === 'all';
  const t = takes(type);
  const out: Record<string, unknown> = {};
  const put = (k: FieldSetting | 'value', v: unknown, isSet: boolean): void => {
    if (k !== 'value' && !t.has(k)) return;
    if (isSet) out[k] = v;
    else if (all) out[k] = k === 'read_only' || k === 'sender_filled' ? false : null;
  };
  const text = (v: string): string => v.trim();
  if (t.has('name_mode')) {
    const defaultNull = opts.nameModeDefaultNull === true && s.nameMode === DEFAULT_SIGNER_NAME_MODE;
    put('name_mode', s.nameMode, !defaultNull);
  }
  put('label', text(s.label), text(s.label).length > 0);
  const grouped = isGroupedType(type) && text(s.groupKey).length > 0;
  put('group_key', text(s.groupKey), grouped);
  const rule: GroupRule = type === 'RADIO' ? 'SELECT_ONE' : s.groupRule;
  // A RADIO's rule is always SELECT_ONE (the server's default): a new one does not send it.
  put('group_rule', rule, grouped && (type !== 'RADIO' || all));
  // A select-one group's minimum is 1 or none (the server's rule); a stored 1 is kept.
  put('min_selected', s.minSelected, grouped && type !== 'RADIO' && s.minSelected !== null && (rule === 'SELECT_ANY' || s.minSelected === 1));
  put('tooltip', text(s.tooltip), text(s.tooltip).length > 0);
  put('placeholder', text(s.placeholder), text(s.placeholder).length > 0);
  put('read_only', true, s.senderFilled && s.readOnly);
  put('sender_filled', true, s.senderFilled);
  const validation = s.validation !== '' && (VALIDATIONS_BY_TYPE[type] ?? []).includes(s.validation) ? s.validation : '';
  put('validation', validation, validation !== '');
  put('font_size', s.fontSize, s.fontSize !== null);
  put('data_name', text(s.dataName), text(s.dataName).length > 0);
  const options = t.has('options') ? optionsToWire(type, validation, s.options) : null;
  put('options', options, options !== null);
  if (opts.senderValues === true && s.senderFilled && s.senderValue !== '') out['value'] = s.senderValue;
  return out;
}

/**
 * The refusal the server would give this field's settings (the ONE rule, parseFieldSettings), or
 * null. `senderFilledEnabled`: whether the host offers sender-filled fields (the server flag).
 */
export function settingsIssue(type: string, s: PlacementSettings, opts: { readonly senderFilledEnabled?: boolean } = {}): FieldSettingRefusal | null {
  if (!isFieldTypeKey(type)) return null;
  const parsed = parseFieldSettings(settingsToWire(type, s), type, { sender_filled_enabled: opts.senderFilledEnabled === true });
  return parsed.ok ? null : parsed.refusal;
}

/** A RADIO's next option text: "Option N", N one more than the options in its group. */
export function nextRadioLabel(fields: readonly Pick<PlacedField, 'type' | 'assignee' | 'settings'>[], f: Pick<PlacedField, 'assignee' | 'settings'>): string {
  const g = f.settings.groupKey.trim();
  const n = fields.filter((o) => o.type === 'RADIO' && o.assignee === f.assignee && o.settings.groupKey.trim() === g).length;
  return `Option ${n + 1}`;
}

/** The gap (points) between a radio option and the next one "Add option" places below it. */
export const RADIO_OPTION_GAP = 8;

/**
 * FIELD-PARITY-1 P3 T-5 — "Add option": a sibling RADIO in the same group, the same size, just
 * below `f` (PDF-native: a smaller y), with the next option text; its value is never copied.
 * The caller clamps the box to the page.
 */
export function radioOptionBelow(fields: readonly PlacedField[], f: PlacedField, id: string): PlacedField {
  return {
    ...f,
    id,
    y: f.y - f.height - RADIO_OPTION_GAP,
    settings: { ...f.settings, label: nextRadioLabel(fields, f), senderValue: f.settings.senderValue === '' ? '' : 'false' },
  };
}
