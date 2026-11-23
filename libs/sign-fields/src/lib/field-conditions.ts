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

// ---- B-3 — the ONE cross-field rule (every save path; the web editor shows the same refusals).

/** Every reason the cross-field rule refuses a field list (stable; §4.3 of the directive). */
export const FIELD_CONDITION_REFUSAL_REASONS = [
  'condition_invalid',
  'condition_trigger_unknown',
  'condition_trigger_type_invalid',
  'condition_cross_signer',
  'condition_values_invalid',
  'condition_cycle',
  'condition_depth_exceeded',
  'condition_no_unconditional_signature',
  'field_key_duplicate',
] as const;
export type FieldConditionRefusalReason = (typeof FIELD_CONDITION_REFUSAL_REASONS)[number];

/** One field as the cross-field rule sees it. */
export interface ConditionalFieldLike {
  /** The field's key (NULL / absent: none; such a field cannot be a trigger). */
  readonly field_key?: string | null;
  readonly field_type: string;
  /**
   * Who fills it: the envelope signer id (Sign) or the template signer role (templates). NULL:
   * nobody (template data), which can be neither conditional nor a trigger.
   */
  readonly signer: string | null;
  readonly condition?: FieldCondition | null;
  /** A DROPDOWN trigger's choices (a one_of condition's values are among them). */
  readonly options?: { readonly choices?: readonly { readonly value: string }[] } | null;
  readonly sender_filled?: boolean | null;
}

export interface FieldConditionIssue {
  /** The position of the refused field in the list. */
  readonly index: number;
  readonly field_key: string | null;
  readonly reason: FieldConditionRefusalReason;
  readonly message: string;
}

export interface FieldConditionCheckOptions {
  /**
   * Ruling C-6: every signer keeps at least one unconditional SIGNATURE when any of its
   * SIGNATURE fields is conditional (default true). A list that is not the signer's whole set
   * (the documents template route adds one field at a time beside a drawn signature block) passes
   * false; the template → envelope carry checks the whole set.
   */
  readonly requireUnconditionalSignature?: boolean;
}

/**
 * The cross-field problems of a field list (empty = none), at most one per field, in field order
 * (a key used twice is reported on its second use). Checks: the trigger exists (by key), has a type
 * the rule reads (CONDITION_TRIGGER_TYPES), belongs to the same signer, a one_of condition's values
 * are the dropdown's choice values, no cycle, a chain at most CONDITION_DEPTH_MAX deep, and (C-6)
 * each signer keeps an unconditional SIGNATURE. The shape of each condition is parseFieldCondition's
 * (the settings rule); a shape it would refuse is condition_invalid here too.
 */
export function fieldConditionIssues(fields: readonly ConditionalFieldLike[], opts: FieldConditionCheckOptions = {}): FieldConditionIssue[] {
  const issues = new Map<number, FieldConditionIssue>();
  const add = (index: number, reason: FieldConditionRefusalReason, message: string): void => {
    if (!issues.has(index)) issues.set(index, { index, field_key: fields[index]?.field_key ?? null, reason, message });
  };
  const byKey = new Map<string, number>();
  for (const [i, f] of fields.entries()) {
    const k = f.field_key;
    if (k === undefined || k === null) continue;
    if (byKey.has(k)) add(i, 'field_key_duplicate', `the field key ${k} is used twice`);
    else byKey.set(k, i);
  }
  const conditionOf = (f: ConditionalFieldLike | undefined): FieldCondition | null => {
    if (f?.condition === undefined || f.condition === null) return null;
    const parsed = parseFieldCondition(f.condition);
    return parsed.ok ? parsed.condition : null;
  };

  for (const [i, f] of fields.entries()) {
    if (f.condition === undefined || f.condition === null) continue;
    const c = conditionOf(f);
    if (c === null) {
      add(i, 'condition_invalid', 'the condition is not { trigger_key, when, values? }');
      continue;
    }
    if (f.sender_filled === true) {
      add(i, 'condition_invalid', 'a sender-filled field cannot be conditional');
      continue;
    }
    const t = byKey.get(c.trigger_key);
    const trigger = t === undefined ? undefined : fields[t];
    if (trigger === undefined) {
      add(i, 'condition_trigger_unknown', `no field has the key ${c.trigger_key}`);
      continue;
    }
    if (t === i) {
      add(i, 'condition_cycle', 'a field cannot be its own trigger');
      continue;
    }
    if (!CONDITION_TRIGGER_TYPES[c.when].includes(trigger.field_type)) {
      add(i, 'condition_trigger_type_invalid', `"${c.when}" reads a ${CONDITION_TRIGGER_TYPES[c.when].join(' or ')} field, not a ${trigger.field_type}`);
      continue;
    }
    if (f.signer === null || trigger.signer !== f.signer) {
      add(i, 'condition_cross_signer', 'the trigger belongs to another signer (a condition reads only the same signer\'s answers)');
      continue;
    }
    if (c.when === 'one_of') {
      const choices = new Set((trigger.options?.choices ?? []).map((ch) => ch.value));
      const stray = (c.values ?? []).find((v) => !choices.has(v));
      if (stray !== undefined) {
        add(i, 'condition_values_invalid', `${stray} is not a choice of the dropdown ${c.trigger_key}`);
        continue;
      }
    }
  }

  // Cycles and depth, along each chain (a field with an earlier problem is reported once).
  for (const [i, f] of fields.entries()) {
    if (issues.has(i) || conditionOf(f) === null) continue;
    const seen = new Set<number>([i]);
    let depth = 0;
    let cur: number | undefined = i;
    while (cur !== undefined) {
      const c = conditionOf(fields[cur]);
      if (c === null) break;
      depth += 1;
      const next = byKey.get(c.trigger_key);
      if (next !== undefined && seen.has(next)) {
        add(i, 'condition_cycle', 'the conditions form a loop (a field shows only when it is shown)');
        break;
      }
      if (depth > CONDITION_DEPTH_MAX) {
        add(i, 'condition_depth_exceeded', `a chain of conditions is at most ${CONDITION_DEPTH_MAX} deep`);
        break;
      }
      if (next !== undefined) seen.add(next);
      cur = next;
    }
  }

  // Ruling C-6 — a conditional SIGNATURE needs an unconditional one beside it (the same signer).
  if (opts.requireUnconditionalSignature !== false) {
    const signers = new Set(fields.filter((f) => f.field_type === 'SIGNATURE' && f.signer !== null).map((f) => f.signer as string));
    for (const s of signers) {
      const sigs = [...fields.entries()].filter(([, f]) => f.field_type === 'SIGNATURE' && f.signer === s);
      const conditional = sigs.filter(([, f]) => f.condition !== undefined && f.condition !== null);
      if (conditional.length === 0 || conditional.length < sigs.length) continue;
      const [first] = conditional;
      if (first !== undefined) add(first[0], 'condition_no_unconditional_signature', 'each signer needs at least one signature field that is always shown');
    }
  }
  return [...issues.values()].sort((a, b) => a.index - b.index);
}

/**
 * B-7 — the fields whose condition has no trigger left to read: no field has its trigger_key any
 * more (the trigger was deleted) or the trigger is no longer a type its rule reads (retyped). Every
 * editor (web and app) clears these conditions in the same step as the delete or retype, with a
 * warning: the fields are then always shown. Positions in the list, in field order.
 */
export function orphanedConditionIndexes(fields: readonly Pick<ConditionalFieldLike, 'field_key' | 'field_type' | 'condition'>[]): number[] {
  const byKey = new Map<string, string>();
  for (const f of fields) if (typeof f.field_key === 'string' && !byKey.has(f.field_key)) byKey.set(f.field_key, f.field_type);
  const out: number[] = [];
  fields.forEach((f, i) => {
    if (f.condition === undefined || f.condition === null) return;
    const parsed = parseFieldCondition(f.condition);
    if (!parsed.ok || parsed.condition === null) return;
    const type = byKey.get(parsed.condition.trigger_key);
    if (type === undefined || !CONDITION_TRIGGER_TYPES[parsed.condition.when].includes(type)) out.push(i);
  });
  return out;
}

/** A dropdown choice as an editor holds it (a blank value is saved as its label). */
interface EditorChoiceLike {
  readonly value?: string | null;
  readonly label?: string | null;
}

/** The value a dropdown choice is saved with: its value, or its label when the value is blank; trimmed. */
function savedChoiceValue(c: EditorChoiceLike): string {
  return (c.value ?? '').trim() || (c.label ?? '').trim();
}

/**
 * B-7 — the condition a field starts with when `trigger` is picked as its trigger (every editor,
 * web and app): "is checked" for a check box or acknowledgement, "this option is chosen" for a radio
 * option, the first choice for a dropdown. Null when the field can't be a trigger (no key, a type
 * the rule does not read, a dropdown without choices).
 */
export function startingCondition(trigger: {
  readonly field_key?: string | null;
  readonly field_type: string;
  readonly options?: { readonly choices?: readonly EditorChoiceLike[] } | null;
}): FieldCondition | null {
  if (!isFieldKey(trigger.field_key)) return null;
  const when = FIELD_CONDITION_WHENS.find((w) => CONDITION_TRIGGER_TYPES[w].includes(trigger.field_type));
  if (when === undefined) return null;
  if (when !== 'one_of') return { trigger_key: trigger.field_key, when };
  const first = (trigger.options?.choices ?? []).map(savedChoiceValue).find((v) => v.length > 0);
  return first === undefined ? null : { trigger_key: trigger.field_key, when, values: [first] };
}

/**
 * B-7 — the fields that may show or hide the field at `index` (positions, in field order): the same
 * signer (or role), a type the rule reads, not the field itself, never a field the sender fills,
 * and the cross-field rule accepts the starting condition without any new problem anywhere (no
 * loop, no chain deeper than CONDITION_DEPTH_MAX). A field the sender fills, or one nobody fills,
 * takes no trigger. Pass each DROPDOWN's choices as they are saved (a blank value is its label).
 */
export function usableTriggerIndexes(fields: readonly ConditionalFieldLike[], index: number): number[] {
  const dependent = fields[index];
  if (dependent === undefined || dependent.signer === null || dependent.sender_filled === true) return [];
  const opts = { requireUnconditionalSignature: false } as const;
  const withCondition = (condition: FieldCondition | null): ConditionalFieldLike[] => fields.map((f, i) => (i === index ? { ...f, condition } : f));
  // A loop or a too-deep chain may be reported on another field of the chain.
  const before = new Set(fieldConditionIssues(withCondition(null), opts).map((x) => x.index));
  const out: number[] = [];
  fields.forEach((t, i) => {
    if (i === index || t.signer !== dependent.signer || t.sender_filled === true) return;
    const condition = startingCondition(t);
    if (condition === null) return;
    if (fieldConditionIssues(withCondition(condition), opts).every((x) => before.has(x.index))) out.push(i);
  });
  return out;
}
