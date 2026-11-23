// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-4 —
// the ONE visibility rule: given one signer's fields and their current values, which fields are
// shown. The server (fill, clear-on-hide, completion), the sign-web guest page and the Aramo Sign
// app all call it; no client keeps its own copy. It feeds signerFieldUnits, so a hidden field is
// never required and never counted.
//
// A field is shown when it has no condition, or when its trigger (the field whose field_key is
// the condition's trigger_key, in the same list) is itself shown AND the trigger's value meets the
// rule:
//   checked    the trigger holds 'true' (a ticked CHECKBOX / ACKNOWLEDGEMENT);
//   unchecked  it does not (unticked, cleared, or never touched);
//   chosen     the RADIO option the condition names holds 'true';
//   one_of     the DROPDOWN holds one of the condition's values.
// A hidden trigger hides its dependents, so chains follow by construction.
//
// Fail-open on a condition the server would have refused (a trigger not in the list, a loop, a
// broken shape): the field is shown, so a required field is never silently skipped.
//
// Pure TypeScript ESM (type:client-shared).
import { parseFieldCondition, type FieldCondition } from '@aramo/sign-fields';

/** One field as the visibility rule sees it (a signer-view field, a stored row, a draft field). */
export interface VisibilityFieldLike {
  readonly field_key?: string | null;
  /** { trigger_key, when, values? } or NULL (always shown); a stored JSON value is read safely. */
  readonly condition?: unknown;
}

/** The condition of a field, or null (none, or a shape the server would refuse). */
export function fieldConditionOf(f: VisibilityFieldLike): FieldCondition | null {
  if (f.condition === undefined || f.condition === null) return null;
  const parsed = parseFieldCondition(f.condition);
  return parsed.ok ? parsed.condition : null;
}

/** Whether a trigger value meets a condition's rule (the trigger itself being shown is separate). */
export function conditionMetBy(condition: FieldCondition, triggerValue: string | null | undefined): boolean {
  switch (condition.when) {
    case 'checked':
    case 'chosen':
      return triggerValue === 'true';
    case 'unchecked':
      return triggerValue !== 'true';
    case 'one_of':
      return typeof triggerValue === 'string' && (condition.values ?? []).includes(triggerValue);
  }
}

/**
 * The fields shown, as a set of the given field objects. `valueOf(f)`: the field's current value
 * (the signer's entry; null / undefined when empty).
 */
export function shownFields<T extends VisibilityFieldLike>(fields: readonly T[], valueOf: (f: T) => string | null | undefined): ReadonlySet<T> {
  const byKey = new Map<string, T>();
  for (const f of fields) {
    const k = f.field_key;
    if (typeof k === 'string' && !byKey.has(k)) byKey.set(k, f);
  }
  const triggerOf = (f: T): T | undefined => {
    const c = fieldConditionOf(f);
    return c === null ? undefined : byKey.get(c.trigger_key);
  };
  // Whether the chain from f runs into a loop (then every field on it reads as shown).
  const loops = (f: T): boolean => {
    const seen = new Set<T>([f]);
    for (let t = triggerOf(f); t !== undefined; t = triggerOf(t)) {
      if (seen.has(t)) return true;
      seen.add(t);
    }
    return false;
  };
  const memo = new Map<T, boolean>();
  const shown = (f: T): boolean => {
    const known = memo.get(f);
    if (known !== undefined) return known;
    const c = fieldConditionOf(f);
    const trigger = triggerOf(f);
    // Fail-open: no condition, a missing trigger, or a loop shows the field.
    const out = c === null || trigger === undefined || loops(f) ? true : shown(trigger) && conditionMetBy(c, valueOf(trigger));
    memo.set(f, out);
    return out;
  };
  return new Set(fields.filter((f) => shown(f)));
}

/** Whether one field is shown among its signer's fields (see shownFields). */
export function isFieldShown<T extends VisibilityFieldLike>(field: T, fields: readonly T[], valueOf: (f: T) => string | null | undefined): boolean {
  return shownFields(fields, valueOf).has(field);
}

/**
 * B-5 / ruling C-3 — the hidden fields that still hold a value: what the server clears, in the
 * same transaction, after a value changes (a hidden trigger hides its own dependents, so clearing
 * every hidden filled field follows a chain to its end in one pass).
 */
export function hiddenFilledFields<T extends VisibilityFieldLike>(fields: readonly T[], valueOf: (f: T) => string | null | undefined, filled: (f: T) => boolean): T[] {
  const shown = shownFields(fields, valueOf);
  return fields.filter((f) => !shown.has(f) && filled(f));
}
