// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4 Phase B —
// field keys and conditional fields, ONE rule for every API that writes a field: the Sign sender
// API (PUT …/fields), the documents template field route, the console fixed form, the template →
// envelope carry and the web editor.
//
// B-1 — a field's stable key. A template field has always had one (field_key, unique per
// version); an envelope field gets one too (sign SignatureField.field_key, unique per envelope),
// set from the template's key at carry time and from the editor's id when a sender saves. A
// condition names its trigger by this key, never by row id (the replace-all PUT re-creates rows).
//
// Pure TypeScript ESM, no dependency (scope:shared).

/** The longest field key an envelope field stores (the sign SignatureField_field_key_check CHECK). */
export const FIELD_KEY_MAX = 200;

/** Whether `v` is a field key an envelope field can store: text of 1 to FIELD_KEY_MAX characters, not blank. */
export function isFieldKey(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= FIELD_KEY_MAX && v.trim().length > 0;
}

/** The keys that appear more than once (NULL / absent keys are never duplicates), in first-seen order. */
export function duplicateFieldKeys(fields: readonly { readonly field_key?: string | null }[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const f of fields) {
    const k = f.field_key;
    if (k === undefined || k === null) continue;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return [...dup];
}

// ---- B-2 — the condition a field may carry (one trigger per field, ruling C-1).

/** How a condition reads its trigger. */
export const FIELD_CONDITION_WHENS = ['checked', 'unchecked', 'chosen', 'one_of'] as const;
export type FieldConditionWhen = (typeof FIELD_CONDITION_WHENS)[number];

/**
 * The trigger types each rule reads: a check box or an acknowledgement is checked or not; a
 * radio condition names ONE option field (shown while that option is chosen); a dropdown
 * condition lists the choice values that show the field.
 */
export const CONDITION_TRIGGER_TYPES: Readonly<Record<FieldConditionWhen, readonly string[]>> = {
  checked: ['CHECKBOX', 'ACKNOWLEDGEMENT'],
  unchecked: ['CHECKBOX', 'ACKNOWLEDGEMENT'],
  chosen: ['RADIO'],
  one_of: ['DROPDOWN'],
};

/** The longest chain: a field, its trigger's trigger, and one more (ruling C-1). */
export const CONDITION_DEPTH_MAX = 3;
/** A one_of condition lists 1 to this many values (the most choices a dropdown has). */
export const CONDITION_VALUES_MAX = 50;
/** The longest value a one_of condition lists (a dropdown choice value's limit). */
export const CONDITION_VALUE_MAX = 100;

/**
 * "Show this field only when the field `trigger_key` …": is checked / is not checked (a CHECKBOX
 * or ACKNOWLEDGEMENT), has this option chosen (a RADIO option field), or has one of `values` (a
 * DROPDOWN). The database CHECK on both field tables mirrors this shape.
 */
export interface FieldCondition {
  readonly trigger_key: string;
  readonly when: FieldConditionWhen;
  /** one_of only: the trigger dropdown's choice values that show the field. */
  readonly values?: readonly string[];
}

export type FieldConditionParse =
  | { readonly ok: true; readonly condition: FieldCondition | null }
  | { readonly ok: false; readonly message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The shape of one field's condition (NULL / absent = none). The rest of the rule needs the other
 * fields: fieldConditionIssues. A refused shape is the settings reason condition_invalid.
 */
export function parseFieldCondition(raw: unknown): FieldConditionParse {
  if (raw === undefined || raw === null) return { ok: true, condition: null };
  const fail = (message: string): FieldConditionParse => ({ ok: false, message });
  if (!isObject(raw)) return fail('condition must be an object { trigger_key, when, values? }');
  for (const k of Object.keys(raw)) {
    if (k !== 'trigger_key' && k !== 'when' && k !== 'values') return fail(`condition.${k} is not a condition property`);
  }
  if (!isFieldKey(raw['trigger_key'])) return fail(`condition.trigger_key names the trigger field's key (1 to ${FIELD_KEY_MAX} characters)`);
  const when = raw['when'];
  if (typeof when !== 'string' || !(FIELD_CONDITION_WHENS as readonly string[]).includes(when)) return fail(`condition.when must be one of ${FIELD_CONDITION_WHENS.join(', ')}`);
  const values = raw['values'];
  if (when !== 'one_of') {
    if (values !== undefined && values !== null) return fail('condition.values applies to one_of only');
    return { ok: true, condition: { trigger_key: raw['trigger_key'], when: when as FieldConditionWhen } };
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > CONDITION_VALUES_MAX) return fail(`a one_of condition lists 1 to ${CONDITION_VALUES_MAX} values`);
  const seen = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > CONDITION_VALUE_MAX) return fail(`each condition value is text of 1 to ${CONDITION_VALUE_MAX} characters`);
    if (seen.has(v)) return fail(`the condition value ${v} appears twice`);
    seen.add(v);
  }
  return { ok: true, condition: { trigger_key: raw['trigger_key'], when: 'one_of', values: [...seen] } };
}
