// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-3 —
// the field settings a TEMPLATE field carries: the Sign's SignatureField settings of M-A6 §2
// (label, group_key, group_rule, min_selected, name_mode). One rule for every template API
// (the console fixed-form routes and the documents template field route) and for the
// template → envelope mapping in sign-service, so a template field becomes an envelope field
// with the same settings. Which setting applies to which type is the catalog's
// (fieldSettingsOf); the value rules are Sign's sender rules (sender-envelope.service.ts
// fieldConfig / checkboxGroups) and the database CHECKs on both tables.
//
// The one difference from the sender path: an absent name_mode stays NULL in a template (it
// is not written as SIGNER_PROFILE); NULL means the default, SIGNER_PROFILE, when the field
// is carried onto an envelope (templateNameModeOf).
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { fieldSettingsOf, isFieldTypeKey, type FieldSetting } from './catalog.js';

/** The settings a template field may carry (P1-6: never the PAYMENT settings). */
export const TEMPLATE_FIELD_SETTINGS = ['label', 'group_key', 'group_rule', 'min_selected', 'name_mode'] as const satisfies readonly FieldSetting[];
export type TemplateFieldSetting = (typeof TEMPLATE_FIELD_SETTINGS)[number];

export const SIGNER_NAME_MODES = ['SIGNER_PROFILE', 'SIGNER_ENTERED'] as const;
export type SignerNameModeSetting = (typeof SIGNER_NAME_MODES)[number];
/** The name mode of a SIGNER_NAME field that has none (M-A6 §2.2, the sender default). */
export const DEFAULT_SIGNER_NAME_MODE: SignerNameModeSetting = 'SIGNER_PROFILE';

export const CHECKBOX_GROUP_RULES = ['SELECT_ONE', 'SELECT_ANY'] as const;
export type CheckboxGroupRuleSetting = (typeof CHECKBOX_GROUP_RULES)[number];
/** The rule of a group that names none (the sender default). */
export const DEFAULT_CHECKBOX_GROUP_RULE: CheckboxGroupRuleSetting = 'SELECT_ANY';

/** The database CHECK limits (both tables). */
export const FIELD_LABEL_MAX = 200;
export const FIELD_GROUP_KEY_MAX = 64;

export interface TemplateFieldSettings {
  readonly label: string | null;
  readonly group_key: string | null;
  readonly group_rule: CheckboxGroupRuleSetting | null;
  readonly min_selected: number | null;
  readonly name_mode: SignerNameModeSetting | null;
}

export const NO_TEMPLATE_FIELD_SETTINGS: TemplateFieldSettings = Object.freeze({
  label: null,
  group_key: null,
  group_rule: null,
  min_selected: null,
  name_mode: null,
});

/** A refused setting: the setting and a stable reason (the same reasons Sign's sender API uses). */
export interface FieldSettingRefusal {
  readonly setting: TemplateFieldSetting;
  readonly reason:
    | 'field_config_not_applicable'
    | 'name_mode_invalid'
    | 'checkbox_label_invalid'
    | 'checkbox_group_invalid'
    | 'checkbox_group_required';
  readonly message: string;
}

export type TemplateFieldSettingsParse =
  | { readonly ok: true; readonly settings: TemplateFieldSettings }
  | { readonly ok: false; readonly refusal: FieldSettingRefusal };

/** The template settings a field type accepts (the catalog's settings, template subset). */
export function templateSettingsOf(field_type: string): readonly TemplateFieldSetting[] {
  if (!isFieldTypeKey(field_type)) return [];
  const accepted = fieldSettingsOf(field_type);
  return TEMPLATE_FIELD_SETTINGS.filter((s) => accepted.includes(s));
}

/**
 * The settings of one template field from a request body (`o` holds the field's members).
 * NULL / absent = not set. A setting the type does not take is refused
 * (field_config_not_applicable), never ignored.
 */
export function parseTemplateFieldSettings(o: Readonly<Record<string, unknown>>, field_type: string): TemplateFieldSettingsParse {
  const refuse = (setting: TemplateFieldSetting, reason: FieldSettingRefusal['reason'], message: string): TemplateFieldSettingsParse => ({
    ok: false,
    refusal: { setting, reason, message },
  });
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null;
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

  let label: string | null = null;
  if (present('label')) {
    const v = o['label'];
    if (typeof v !== 'string') return refuse('label', 'checkbox_label_invalid', 'label must be text');
    const t = v.trim();
    if (t.length > FIELD_LABEL_MAX) return refuse('label', 'checkbox_label_invalid', `label must be at most ${FIELD_LABEL_MAX} characters`);
    label = t.length > 0 ? t : null;
  }

  let group_key: string | null = null;
  if (present('group_key')) {
    const v = o['group_key'];
    if (typeof v !== 'string') return refuse('group_key', 'checkbox_group_invalid', 'group_key must be text');
    const t = v.trim();
    if (t.length > FIELD_GROUP_KEY_MAX) return refuse('group_key', 'checkbox_group_invalid', `group_key must be at most ${FIELD_GROUP_KEY_MAX} characters`);
    group_key = t.length > 0 ? t : null;
  }
  if (group_key === null) {
    if (present('group_rule')) return refuse('group_rule', 'checkbox_group_required', 'group_rule needs a group_key');
    if (present('min_selected')) return refuse('min_selected', 'checkbox_group_required', 'min_selected needs a group_key');
    return { ok: true, settings: { label, group_key: null, group_rule: null, min_selected: null, name_mode } };
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
  return { ok: true, settings: { label, group_key, group_rule: rule as CheckboxGroupRuleSetting, min_selected, name_mode } };
}

/** One field as the group rule sees it. */
export interface GroupedTemplateField {
  readonly field_key: string;
  readonly signer_role: string | null;
  readonly required: boolean;
  readonly group_key: string | null;
  readonly group_rule: string | null;
  readonly min_selected: number | null;
}

export interface CheckboxGroupIssue {
  readonly group_key: string;
  readonly reason: 'checkbox_group_inconsistent' | 'checkbox_group_min_exceeds_size';
  readonly message: string;
}

/**
 * M-A6 §2.3 (Sign's checkboxGroups) — every box of a group belongs to one signer role and
 * shares the group's rule, minimum and required setting; the minimum is not more than the
 * boxes in the group. Returns every problem (empty = consistent).
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
      (b) => b.signer_role === first.signer_role && b.group_rule === first.group_rule && b.min_selected === first.min_selected && b.required === first.required,
    );
    if (!consistent) {
      out.push({
        group_key,
        reason: 'checkbox_group_inconsistent',
        message: `Check-box group ${group_key}: every box needs the same signer role, rule, minimum and required setting.`,
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
