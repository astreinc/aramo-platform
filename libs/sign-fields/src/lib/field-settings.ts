// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-3,
// §6.2 — the field settings, ONE rule for every API that writes a field: the Sign sender API
// (PUT …/fields, sign-service), the console fixed-form routes and the documents template field
// route (apps/api), and the template → envelope mapping in sign-service, so a template field
// becomes an envelope field with the same settings. Which setting applies to which type is the
// catalog's (fieldSettingsOf); the value rules below are mirrored by the database CHECKs on both
// tables (sign SignatureField, documents TemplateFieldDefinition).
//
// P1-3 settings (M-A6 §2): label, group_key, group_rule, min_selected, name_mode.
// P3 settings (§6.2): tooltip (S-1), placeholder (S-2), read_only (S-4), sender_filled (S-5,
// dark: refused unless the caller says the server flag is on), validation (S-6, its parameters
// in options), font_size (S-7), data_name (S-9) and options (the per-type options). label (S-1)
// now applies to every type. required (S-3) is a column of every field, not a setting here.
//
// The one difference from the sender path: an absent name_mode stays NULL in a template (it
// is not written as SIGNER_PROFILE); NULL means the default, SIGNER_PROFILE, when the field
// is carried onto an envelope (templateNameModeOf).
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { fieldSettingsOf, isFieldTypeKey, type FieldSetting } from './catalog.js';

/** The settings a template field may carry (P1-6: never the PAYMENT settings). */
export const TEMPLATE_FIELD_SETTINGS = [
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
] as const satisfies readonly FieldSetting[];
export type TemplateFieldSetting = (typeof TEMPLATE_FIELD_SETTINGS)[number];

export const SIGNER_NAME_MODES = ['SIGNER_PROFILE', 'SIGNER_ENTERED'] as const;
export type SignerNameModeSetting = (typeof SIGNER_NAME_MODES)[number];
/** The name mode of a SIGNER_NAME field that has none (M-A6 §2.2, the sender default). */
export const DEFAULT_SIGNER_NAME_MODE: SignerNameModeSetting = 'SIGNER_PROFILE';

export const CHECKBOX_GROUP_RULES = ['SELECT_ONE', 'SELECT_ANY'] as const;
export type CheckboxGroupRuleSetting = (typeof CHECKBOX_GROUP_RULES)[number];
/** The rule of a group that names none (the sender default). */
export const DEFAULT_CHECKBOX_GROUP_RULE: CheckboxGroupRuleSetting = 'SELECT_ANY';
/** P3 T-5 — a RADIO group's rule, always (exactly one chosen when required, at most one otherwise). */
export const RADIO_GROUP_RULE: CheckboxGroupRuleSetting = 'SELECT_ONE';

/** S-6 — the validation presets, and the type each applies to. */
export const FIELD_VALIDATIONS = ['email', 'phone', 'us_zip', 'number_range', 'date_range', 'max_length'] as const;
export type FieldValidation = (typeof FIELD_VALIDATIONS)[number];
export const VALIDATIONS_BY_TYPE: Readonly<Record<string, readonly FieldValidation[]>> = {
  TEXT: ['email', 'phone', 'us_zip', 'max_length'],
  MULTILINE_TEXT: ['max_length'],
  NUMBER: ['number_range'],
  DATE: ['date_range'],
};

/** The option keys each type takes (options is a JSON object; NULL = none). */
export const OPTION_KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  DROPDOWN: ['choices'],
  NUMBER: ['format', 'currency', 'decimals', 'min', 'max'],
  DATE: ['min_date', 'max_date'],
  TEXT: ['max_length'],
  MULTILINE_TEXT: ['max_length'],
};

export const NUMBER_FORMATS = ['plain', 'money'] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number];
/** The currency a money NUMBER uses when it names none. */
export const DEFAULT_MONEY_CURRENCY = 'USD';
/** The decimals a money NUMBER uses when it names none. */
export const DEFAULT_MONEY_DECIMALS = 2;

/** The database CHECK limits (both tables). */
export const FIELD_LABEL_MAX = 200;
export const FIELD_GROUP_KEY_MAX = 64;
export const FIELD_TOOLTIP_MAX = 500;
export const FIELD_PLACEHOLDER_MAX = 200;
export const FIELD_FONT_SIZE_MIN = 6;
export const FIELD_FONT_SIZE_MAX = 36;
export const FIELD_DATA_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Option limits (validated here; the column is JSON). */
export const DROPDOWN_CHOICES_MAX = 50;
export const DROPDOWN_CHOICE_VALUE_MAX = 100;
export const DROPDOWN_CHOICE_LABEL_MAX = 200;
export const NUMBER_DECIMALS_MAX = 6;
/** The longest value a MULTILINE_TEXT field holds (and the largest max_length). */
export const MULTILINE_TEXT_MAX = 4000;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface DropdownChoice {
  readonly value: string;
  readonly label: string;
}

/** The per-type options (each key only on the types OPTION_KEYS_BY_TYPE names). */
export interface FieldOptions {
  readonly choices?: readonly DropdownChoice[];
  readonly format?: NumberFormat;
  readonly currency?: string;
  readonly decimals?: number;
  readonly min?: number;
  readonly max?: number;
  readonly min_date?: string;
  readonly max_date?: string;
  readonly max_length?: number;
}

export interface TemplateFieldSettings {
  readonly label: string | null;
  readonly group_key: string | null;
  readonly group_rule: CheckboxGroupRuleSetting | null;
  readonly min_selected: number | null;
  readonly name_mode: SignerNameModeSetting | null;
  readonly tooltip: string | null;
  readonly placeholder: string | null;
  readonly read_only: boolean;
  readonly sender_filled: boolean;
  readonly validation: FieldValidation | null;
  /** NULL = auto (the P0-2 stamper fits the text); a number = a fixed size in points. */
  readonly font_size: number | null;
  readonly data_name: string | null;
  readonly options: FieldOptions | null;
}

/** The settings any field has, shared by both names. */
export type FieldSettings = TemplateFieldSettings;

export const NO_TEMPLATE_FIELD_SETTINGS: TemplateFieldSettings = Object.freeze({
  label: null,
  group_key: null,
  group_rule: null,
  min_selected: null,
  name_mode: null,
  tooltip: null,
  placeholder: null,
  read_only: false,
  sender_filled: false,
  validation: null,
  font_size: null,
  data_name: null,
  options: null,
});

/** Every reason a setting is refused (stable; the same reasons on every API). */
export const FIELD_SETTING_REFUSAL_REASONS = [
  'field_config_not_applicable',
  'name_mode_invalid',
  'checkbox_label_invalid',
  'label_invalid',
  'checkbox_group_invalid',
  'checkbox_group_required',
  'radio_group_required',
  'radio_group_invalid',
  'tooltip_invalid',
  'placeholder_invalid',
  'field_flag_invalid',
  'read_only_requires_sender_filled',
  'sender_filled_not_available',
  'validation_invalid',
  'validation_params_invalid',
  'font_size_invalid',
  'data_name_invalid',
  'options_invalid',
  'dropdown_choices_invalid',
  'number_format_invalid',
] as const;
export type FieldSettingRefusalReason = (typeof FIELD_SETTING_REFUSAL_REASONS)[number];

/** A refused setting: the setting and a stable reason (the same reasons Sign's sender API uses). */
export interface FieldSettingRefusal {
  readonly setting: TemplateFieldSetting;
  readonly reason: FieldSettingRefusalReason;
  readonly message: string;
}

export type TemplateFieldSettingsParse =
  | { readonly ok: true; readonly settings: TemplateFieldSettings }
  | { readonly ok: false; readonly refusal: FieldSettingRefusal };

export interface FieldSettingsParseOptions {
  /**
   * S-5 (ruling R-3) — whether sender-filled fields are switched on (the server flag
   * SIGN_SENDER_FILLED_FIELDS_ENABLED, senderFilledFieldsEnabled). Absent / false: a field
   * with sender_filled true is refused (sender_filled_not_available).
   */
  readonly sender_filled_enabled?: boolean;
}

/** The template settings a field type accepts (the catalog's settings, template subset). */
export function templateSettingsOf(field_type: string): readonly TemplateFieldSetting[] {
  if (!isFieldTypeKey(field_type)) return [];
  const accepted = fieldSettingsOf(field_type);
  return TEMPLATE_FIELD_SETTINGS.filter((s) => accepted.includes(s));
}

/** S-5 — SIGN_SENDER_FILLED_FIELDS_ENABLED=1 turns sender-filled fields on (off by default: dark). */
export function senderFilledFieldsEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['SIGN_SENDER_FILLED_FIELDS_ENABLED'] === '1';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether `v` is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_PATTERN.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d <= days;
}

type OptionsParse = { readonly ok: true; readonly options: FieldOptions | null } | { readonly ok: false; readonly reason: FieldSettingRefusalReason; readonly message: string };

// The options of one field, checked against its type and its validation preset.
function parseOptions(raw: unknown, field_type: string, validation: FieldValidation | null): OptionsParse {
  const fail = (reason: FieldSettingRefusalReason, message: string): OptionsParse => ({ ok: false, reason, message });
  const allowedKeys = OPTION_KEYS_BY_TYPE[field_type] ?? [];
  let o: Record<string, unknown> = {};
  if (raw !== undefined && raw !== null) {
    if (!isObject(raw)) return fail('options_invalid', 'options must be an object');
    o = raw;
  }
  for (const k of Object.keys(o)) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!allowedKeys.includes(k)) return fail('options_invalid', `options.${k} does not apply to a ${field_type} field`);
  }
  const has = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  const out: { -readonly [K in keyof FieldOptions]: FieldOptions[K] } = {};

  if (field_type === 'DROPDOWN') {
    const c = o['choices'];
    if (!Array.isArray(c) || c.length === 0 || c.length > DROPDOWN_CHOICES_MAX) {
      return fail('dropdown_choices_invalid', `a dropdown needs 1 to ${DROPDOWN_CHOICES_MAX} choices`);
    }
    const seen = new Set<string>();
    const choices: DropdownChoice[] = [];
    for (const item of c) {
      const ch = typeof item === 'string' ? { value: item } : item;
      if (!isObject(ch) || typeof ch['value'] !== 'string') return fail('dropdown_choices_invalid', 'each choice needs a value');
      const value = ch['value'].trim();
      if (value.length === 0 || value.length > DROPDOWN_CHOICE_VALUE_MAX) return fail('dropdown_choices_invalid', `a choice value is 1 to ${DROPDOWN_CHOICE_VALUE_MAX} characters`);
      if (seen.has(value)) return fail('dropdown_choices_invalid', `the choice ${value} appears twice`);
      seen.add(value);
      let label = value;
      if (ch['label'] !== undefined && ch['label'] !== null) {
        if (typeof ch['label'] !== 'string') return fail('dropdown_choices_invalid', 'a choice label must be text');
        const t = ch['label'].trim();
        if (t.length > DROPDOWN_CHOICE_LABEL_MAX) return fail('dropdown_choices_invalid', `a choice label is at most ${DROPDOWN_CHOICE_LABEL_MAX} characters`);
        if (t.length > 0) label = t;
      }
      choices.push({ value, label });
    }
    out.choices = choices;
  }

  if (field_type === 'NUMBER') {
    let format: NumberFormat = 'plain';
    if (has('format')) {
      const f = o['format'];
      if (typeof f !== 'string' || !(NUMBER_FORMATS as readonly string[]).includes(f)) return fail('number_format_invalid', 'format must be plain or money');
      format = f as NumberFormat;
      out.format = format;
    }
    if (has('currency')) {
      if (format !== 'money') return fail('number_format_invalid', 'currency applies to the money format');
      const cur = o['currency'];
      if (typeof cur !== 'string' || !/^[A-Z]{3}$/.test(cur)) return fail('number_format_invalid', 'currency is a three-letter ISO 4217 code');
      out.currency = cur;
    } else if (format === 'money') {
      out.currency = DEFAULT_MONEY_CURRENCY;
    }
    if (has('decimals')) {
      const d = o['decimals'];
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > NUMBER_DECIMALS_MAX) return fail('number_format_invalid', `decimals is a whole number from 0 to ${NUMBER_DECIMALS_MAX}`);
      out.decimals = d;
    } else if (format === 'money') {
      out.decimals = DEFAULT_MONEY_DECIMALS;
    }
  }

  // The validation parameters: present exactly when their preset is.
  const params: Record<string, readonly string[]> = { number_range: ['min', 'max'], date_range: ['min_date', 'max_date'], max_length: ['max_length'] };
  for (const [preset, keys] of Object.entries(params)) {
    const given = keys.filter(has);
    if (validation === preset) {
      if (given.length === 0) return fail('validation_params_invalid', `${preset} needs ${keys.join(' or ')} in options`);
    } else if (given.length > 0) {
      return fail('validation_params_invalid', `options.${given[0]} needs validation ${preset}`);
    }
  }
  if (validation === 'number_range') {
    for (const k of ['min', 'max'] as const) {
      if (!has(k)) continue;
      if (!isFiniteNumber(o[k])) return fail('validation_params_invalid', `options.${k} must be a number`);
      out[k] = o[k] as number;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) return fail('validation_params_invalid', 'options.min is more than options.max');
  }
  if (validation === 'date_range') {
    for (const k of ['min_date', 'max_date'] as const) {
      if (!has(k)) continue;
      if (!isIsoDate(o[k])) return fail('validation_params_invalid', `options.${k} must be a date written YYYY-MM-DD`);
      out[k] = o[k] as string;
    }
    if (out.min_date !== undefined && out.max_date !== undefined && out.min_date > out.max_date) return fail('validation_params_invalid', 'options.min_date is after options.max_date');
  }
  if (validation === 'max_length') {
    const m = o['max_length'];
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > MULTILINE_TEXT_MAX) return fail('validation_params_invalid', `options.max_length is a whole number from 1 to ${MULTILINE_TEXT_MAX}`);
    out.max_length = m;
  }
  return { ok: true, options: Object.keys(out).length > 0 ? out : null };
}

/**
 * The settings of one field from a request body (`o` holds the field's members). NULL /
 * absent = not set (read_only / sender_filled: false). A setting the type does not take is
 * refused (field_config_not_applicable), never ignored. The ONE rule for templates and sends
 * (parseFieldSettings is the same function).
 */
export function parseTemplateFieldSettings(o: Readonly<Record<string, unknown>>, field_type: string, opts: FieldSettingsParseOptions = {}): TemplateFieldSettingsParse {
  const refuse = (setting: TemplateFieldSetting, reason: FieldSettingRefusalReason, message: string): TemplateFieldSettingsParse => ({
    ok: false,
    refusal: { setting, reason, message },
  });
  // A boolean flag is "set" only when true (false is the default every field has).
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null && !((k === 'read_only' || k === 'sender_filled') && o[k] === false);
  const applicable = new Set<string>(templateSettingsOf(field_type));
  for (const k of TEMPLATE_FIELD_SETTINGS) {
    if (present(k) && !applicable.has(k)) return refuse(k, 'field_config_not_applicable', `${k} does not apply to a ${field_type} field`);
  }

  let name_mode: SignerNameModeSetting | null = null;
  if (present('name_mode')) {
    const m = o['name_mode'];
    if (typeof m !== 'string' || !(SIGNER_NAME_MODES as readonly string[]).includes(m)) {
      return refuse('name_mode', 'name_mode_invalid', 'name_mode must be SIGNER_PROFILE or SIGNER_ENTERED');
    }
    name_mode = m as SignerNameModeSetting;
  }

  // S-1 — a label on any type (a check box keeps its M-A6 reason).
  const labelReason: FieldSettingRefusalReason = field_type === 'CHECKBOX' ? 'checkbox_label_invalid' : 'label_invalid';
  let label: string | null = null;
  if (present('label')) {
    const v = o['label'];
    if (typeof v !== 'string') return refuse('label', labelReason, 'label must be text');
    const t = v.trim();
    if (t.length > FIELD_LABEL_MAX) return refuse('label', labelReason, `label must be at most ${FIELD_LABEL_MAX} characters`);
    label = t.length > 0 ? t : null;
  }

  const text = (k: 'tooltip' | 'placeholder', max: number, reason: FieldSettingRefusalReason): string | null | TemplateFieldSettingsParse => {
    if (!present(k)) return null;
    const v = o[k];
    if (typeof v !== 'string') return refuse(k, reason, `${k} must be text`);
    const t = v.trim();
    if (t.length > max) return refuse(k, reason, `${k} must be at most ${max} characters`);
    return t.length > 0 ? t : null;
  };
  const tooltip = text('tooltip', FIELD_TOOLTIP_MAX, 'tooltip_invalid');
  if (tooltip !== null && typeof tooltip === 'object') return tooltip;
  const placeholder = text('placeholder', FIELD_PLACEHOLDER_MAX, 'placeholder_invalid');
  if (placeholder !== null && typeof placeholder === 'object') return placeholder;

  for (const k of ['read_only', 'sender_filled'] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'boolean') return refuse(k, 'field_flag_invalid', `${k} must be true or false`);
  }
  const read_only = o['read_only'] === true;
  const sender_filled = o['sender_filled'] === true;
  if (sender_filled && opts.sender_filled_enabled !== true) return refuse('sender_filled', 'sender_filled_not_available', 'sender-filled fields are not available');
  if (read_only && !sender_filled) return refuse('read_only', 'read_only_requires_sender_filled', 'a read-only field needs a value the sender fills (sender_filled)');

  let validation: FieldValidation | null = null;
  if (present('validation')) {
    const v = o['validation'];
    if (typeof v !== 'string' || !(VALIDATIONS_BY_TYPE[field_type] ?? []).includes(v as FieldValidation)) {
      return refuse('validation', 'validation_invalid', `validation must be one of ${(VALIDATIONS_BY_TYPE[field_type] ?? []).join(', ')} for a ${field_type} field`);
    }
    validation = v as FieldValidation;
  }

  let font_size: number | null = null;
  if (present('font_size')) {
    const f = o['font_size'];
    if (typeof f !== 'number' || !Number.isInteger(f) || f < FIELD_FONT_SIZE_MIN || f > FIELD_FONT_SIZE_MAX) {
      return refuse('font_size', 'font_size_invalid', `font_size is a whole number of points from ${FIELD_FONT_SIZE_MIN} to ${FIELD_FONT_SIZE_MAX} (absent: auto)`);
    }
    font_size = f;
  }

  let data_name: string | null = null;
  if (present('data_name')) {
    const d = o['data_name'];
    if (typeof d !== 'string' || !FIELD_DATA_NAME_PATTERN.test(d)) return refuse('data_name', 'data_name_invalid', 'data_name is lower_snake_case: a letter, then letters, digits or _ (at most 64)');
    data_name = d;
  }

  // options: the DROPDOWN choices are required, so it is parsed whenever the type takes it.
  let options: FieldOptions | null = null;
  if (applicable.has('options')) {
    const parsed = parseOptions(o['options'], field_type, validation);
    if (!parsed.ok) return refuse('options', parsed.reason, parsed.message);
    options = parsed.options;
  }

  const rest = { name_mode, tooltip, placeholder, read_only, sender_filled, validation, font_size, data_name, options } as const;

  let group_key: string | null = null;
  if (present('group_key')) {
    const v = o['group_key'];
    if (typeof v !== 'string') return refuse('group_key', 'checkbox_group_invalid', 'group_key must be text');
    const t = v.trim();
    if (t.length > FIELD_GROUP_KEY_MAX) return refuse('group_key', 'checkbox_group_invalid', `group_key must be at most ${FIELD_GROUP_KEY_MAX} characters`);
    group_key = t.length > 0 ? t : null;
  }
  // T-5 — a RADIO is always one option of a group whose rule is SELECT_ONE.
  if (field_type === 'RADIO') {
    if (group_key === null) return refuse('group_key', 'radio_group_required', 'a radio button needs a group_key (its group)');
    const rule = o['group_rule'] ?? RADIO_GROUP_RULE;
    if (rule !== RADIO_GROUP_RULE) return refuse('group_rule', 'radio_group_invalid', 'a radio group is always SELECT_ONE');
    return { ok: true, settings: { ...rest, label, group_key, group_rule: RADIO_GROUP_RULE, min_selected: null } };
  }
  if (group_key === null) {
    if (present('group_rule')) return refuse('group_rule', 'checkbox_group_required', 'group_rule needs a group_key');
    if (present('min_selected')) return refuse('min_selected', 'checkbox_group_required', 'min_selected needs a group_key');
    return { ok: true, settings: { ...rest, label, group_key: null, group_rule: null, min_selected: null } };
  }
  const rule = o['group_rule'] ?? DEFAULT_CHECKBOX_GROUP_RULE;
  if (typeof rule !== 'string' || !(CHECKBOX_GROUP_RULES as readonly string[]).includes(rule)) {
    return refuse('group_rule', 'checkbox_group_invalid', 'group_rule must be SELECT_ONE or SELECT_ANY');
  }
  let min_selected: number | null = null;
  if (present('min_selected')) {
    const m = o['min_selected'];
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1) return refuse('min_selected', 'checkbox_group_invalid', 'min_selected must be a whole number of at least 1');
    if (rule === 'SELECT_ONE' && m !== 1) return refuse('min_selected', 'checkbox_group_invalid', 'a select-one group has min_selected 1');
    min_selected = m;
  }
  return { ok: true, settings: { ...rest, label, group_key, group_rule: rule as CheckboxGroupRuleSetting, min_selected } };
}

/** The ONE settings rule, under its general name (templates and sends alike). */
export const parseFieldSettings = parseTemplateFieldSettings;

/** One field as the group rule sees it. */
export interface GroupedTemplateField {
  readonly field_key: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly group_key: string | null;
  readonly group_rule: string | null;
  readonly min_selected: number | null;
  /** P3 — a group is one type (CHECKBOX or RADIO) and one sender-filled / read-only setting. */
  readonly field_type?: string;
  readonly read_only?: boolean;
  readonly sender_filled?: boolean;
}

export interface CheckboxGroupIssue {
  readonly group_key: string;
  readonly reason: 'checkbox_group_inconsistent' | 'checkbox_group_min_exceeds_size';
  readonly message: string;
}

/**
 * M-A6 §2.3 (Sign's checkboxGroups) — every box of a group belongs to one signer role and
 * shares the group's rule, minimum and required setting; the minimum is not more than the
 * boxes in the group. P3 — and one type (a check-box group or a radio group, never mixed) and
 * one read-only / sender-filled setting. Returns every problem (empty = consistent).
 */
export function checkboxGroupIssues(fields: readonly GroupedTemplateField[]): CheckboxGroupIssue[] {
  const groups = new Map<string, GroupedTemplateField[]>();
  for (const f of fields) {
    if (f.group_key === null) continue;
    const g = groups.get(f.group_key) ?? [];
    g.push(f);
    groups.set(f.group_key, g);
  }
  const out: CheckboxGroupIssue[] = [];
  for (const [group_key, boxes] of groups) {
    const [first] = boxes;
    if (first === undefined) continue;
    const consistent = boxes.every(
      (b) =>
        b.signer_role === first.signer_role &&
        b.group_rule === first.group_rule &&
        b.min_selected === first.min_selected &&
        b.required === first.required &&
        (b.field_type ?? null) === (first.field_type ?? null) &&
        (b.read_only ?? false) === (first.read_only ?? false) &&
        (b.sender_filled ?? false) === (first.sender_filled ?? false),
    );
    if (!consistent) {
      out.push({
        group_key,
        reason: 'checkbox_group_inconsistent',
        message: `Group ${group_key}: every box needs the same type, signer role, rule, minimum, required, read-only and sender-filled setting.`,
      });
    } else if ((first.min_selected ?? 1) > boxes.length) {
      out.push({ group_key, reason: 'checkbox_group_min_exceeds_size', message: `Check-box group ${group_key}: the minimum is more than the boxes in the group.` });
    }
  }
  return out;
}

/** The name mode a template field carries onto an envelope (NULL = the default; SIGNER_NAME only). */
export function templateNameModeOf(field_type: string, name_mode: string | null | undefined): string | null {
  if (field_type !== 'SIGNER_NAME') return null;
  return name_mode ?? DEFAULT_SIGNER_NAME_MODE;
}

/**
 * The setting members of a parsed field that are set (for a request body or a fingerprint):
 * NULL settings and false flags are left out, so a field with no setting has none.
 */
export function setFieldSettings(s: Partial<TemplateFieldSettings>): Partial<Record<TemplateFieldSetting, unknown>> {
  const out: Partial<Record<TemplateFieldSetting, unknown>> = {};
  for (const k of TEMPLATE_FIELD_SETTINGS) {
    const v = s[k];
    if (v === undefined || v === null || v === false) continue;
    out[k] = v;
  }
  return out;
}
