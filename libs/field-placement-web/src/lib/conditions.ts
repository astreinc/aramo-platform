// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-7 —
// authoring "Show only when…" in the shared web placement editor. Pure helpers over the editor's
// fields; every rule is the shared one:
//   - which fields may be a trigger: the ONE cross-field rule (@aramo/sign-fields
//     fieldConditionIssues, through settings-wire conditionIssues) accepts the condition;
//   - which fields a preview shows: the ONE visibility rule (@aramo/sign-fields shownFields, the
//     rule the server and the signer apps use).
// A field's key is its id (sign-web: the field_key it is saved with; console: the field_key).

import { CONDITION_TRIGGER_TYPES, FIELD_CONDITION_WHENS, orphanedConditionIndexes, shownFields, type FieldCondition, type FieldConditionWhen } from '@aramo/sign-fields';

import { type PlacedField } from './model';
import { cleanChoices, conditionIssues } from './settings-wire';

/** The types a condition can read (a check box or acknowledgement, a radio option, a dropdown). */
export const TRIGGER_TYPES: ReadonlySet<string> = new Set(FIELD_CONDITION_WHENS.flatMap((w) => CONDITION_TRIGGER_TYPES[w]));

/** The rules a trigger of this type offers (in the shared order). */
export function conditionWhensFor(type: string): FieldConditionWhen[] {
  return FIELD_CONDITION_WHENS.filter((w) => CONDITION_TRIGGER_TYPES[w].includes(type));
}

/** The words of each rule, for the editors' controls. */
export const CONDITION_WHEN_LABELS: Readonly<Record<FieldConditionWhen, string>> = {
  checked: 'is checked',
  unchecked: 'is not checked',
  chosen: 'has this option chosen',
  one_of: 'has one of these values',
};

/** The dropdown choice values a one_of condition may list (the trigger's cleaned choices). */
export function triggerChoices(trigger: Pick<PlacedField, 'settings'>): { readonly value: string; readonly label: string }[] {
  return cleanChoices(trigger.settings.options?.choices);
}

/**
 * The condition a newly picked trigger starts with: checked (a check box / acknowledgement), this
 * option chosen (a radio option), or the dropdown's first choice. Null when the field can't be a
 * trigger (a dropdown without choices, any other type).
 */
export function defaultConditionFor(trigger: Pick<PlacedField, 'id' | 'type' | 'settings'>): FieldCondition | null {
  const when = conditionWhensFor(trigger.type)[0];
  if (when === undefined) return null;
  if (when !== 'one_of') return { trigger_key: trigger.id, when };
  const first = triggerChoices(trigger)[0];
  return first === undefined ? null : { trigger_key: trigger.id, when, values: [first.value] };
}

/** Whether a field may be a trigger at all: an editable, placed field the rule reads, with someone to fill it. */
function triggerShaped(f: PlacedField): boolean {
  return TRIGGER_TYPES.has(f.type) && f.locked !== true && f.hidden !== true && f.binding === null && f.assignee !== null && !f.settings.senderFilled;
}

/**
 * The fields that can show or hide `dependentId`: same signer (or role), a type the rule reads,
 * not the field itself, and the shared rule accepts the condition (no loop, the chain at most
 * 3 deep). A field the sender fills, or a locked or prefilled one, never offers a trigger.
 */
export function usableTriggers(fields: readonly PlacedField[], dependentId: string): PlacedField[] {
  const dependent = fields.find((f) => f.id === dependentId);
  if (dependent === undefined || dependent.locked === true || dependent.binding !== null || dependent.assignee === null || dependent.settings.senderFilled) return [];
  const opts = { requireUnconditionalSignature: false } as const;
  const withCondition = (condition: FieldCondition | null) => fields.map((f) => (f.id === dependentId ? { ...f, settings: { ...f.settings, condition } } : f));
  // A loop or a too-deep chain may be reported on another field of the chain: a trigger is offered
  // only when it adds no problem anywhere.
  const before = conditionIssues(withCondition(null), opts);
  return fields.filter((t) => {
    if (t.id === dependentId || !triggerShaped(t) || t.assignee !== dependent.assignee) return false;
    const condition = defaultConditionFor(t);
    if (condition === null) return false;
    return [...conditionIssues(withCondition(condition), opts).keys()].every((id) => before.has(id));
  });
}

/** The fields whose condition names one of `triggerIds`. */
export function dependentsOf(fields: readonly Pick<PlacedField, 'id' | 'settings'>[], triggerIds: Iterable<string>): string[] {
  const ids = new Set(triggerIds);
  return fields.filter((f) => !ids.has(f.id) && f.settings.condition !== null && ids.has(f.settings.condition.trigger_key)).map((f) => f.id);
}

/**
 * The conditions that no longer have a trigger to read: the trigger is gone (deleted) or is no
 * longer a type its rule reads (retyped). Those fields are always shown once cleared.
 */
export function staleConditionIds(fields: readonly Pick<PlacedField, 'id' | 'type' | 'settings'>[]): string[] {
  return orphanedConditionIndexes(fields.map((f) => ({ field_key: f.id, field_type: f.type, condition: f.settings.condition }))).map((i) => fields[i]!.id);
}

/**
 * Clear the stale conditions (staleConditionIds) — what a delete or a retype of a trigger does to
 * its dependents. Unchanged fields keep their identity (the editor's history records only real
 * changes, so the clear is part of the same undo step as the delete).
 */
export function clearStaleConditions<T extends Pick<PlacedField, 'id' | 'type' | 'settings'>>(fields: readonly T[]): T[] {
  const stale = new Set(staleConditionIds(fields));
  if (stale.size === 0) return [...fields];
  return fields.map((f) => (stale.has(f.id) ? { ...f, settings: { ...f.settings, condition: null } } : f));
}

/**
 * Copies of fields whose triggers were copied with them follow the copy: a condition naming a
 * copied field is pointed at that field's copy (`idMap`: source id → copy id). A condition on a
 * trigger that was not copied keeps naming the original.
 */
export function remapConditions<T extends Pick<PlacedField, 'settings'>>(copies: readonly T[], idMap: ReadonlyMap<string, string>): T[] {
  return copies.map((f) => {
    const c = f.settings.condition;
    const to = c === null ? undefined : idMap.get(c.trigger_key);
    return c === null || to === undefined ? f : { ...f, settings: { ...f.settings, condition: { ...c, trigger_key: to } } };
  });
}

/**
 * The preview: which fields are shown for these preview answers (field id → value: 'true' for a
 * ticked check box or a chosen radio option, a choice value for a dropdown), by the ONE visibility
 * rule. The ids not in the set are drawn dimmed.
 */
export function previewShownIds(fields: readonly Pick<PlacedField, 'id' | 'settings'>[], answers: ReadonlyMap<string, string>): ReadonlySet<string> {
  const rows = fields.map((f) => ({ id: f.id, field_key: f.id, condition: f.settings.condition }));
  const shown = shownFields(rows, (r) => answers.get(r.id) ?? null);
  return new Set([...shown].map((r) => r.id));
}

/**
 * A preview answer for a trigger: a check box / acknowledgement toggles; choosing a radio option
 * un-chooses the other options of its group (one signer's group); a dropdown takes the value
 * ('' clears it).
 */
export function setPreviewAnswer(answers: ReadonlyMap<string, string>, fields: readonly PlacedField[], trigger: PlacedField, value?: string): Map<string, string> {
  const next = new Map(answers);
  if (trigger.type === 'DROPDOWN') {
    if (value === undefined || value === '') next.delete(trigger.id);
    else next.set(trigger.id, value);
    return next;
  }
  const on = value !== undefined ? value === 'true' : next.get(trigger.id) !== 'true';
  if (trigger.type === 'RADIO' && on) {
    const g = trigger.settings.groupKey.trim();
    for (const f of fields) if (f.type === 'RADIO' && f.assignee === trigger.assignee && f.settings.groupKey.trim() === g) next.delete(f.id);
  }
  if (on) next.set(trigger.id, 'true');
  else next.delete(trigger.id);
  return next;
}
