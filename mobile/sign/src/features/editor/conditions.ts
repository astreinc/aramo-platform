// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-7 —
// "Show only when…" in the app's sender editor (the Send flow; never self-sign, ruling C-7). The
// rules are the shared ones (@aramo/sign-client over @aramo/sign-fields), the same the web editor
// and the server run: which fields may be a trigger and how a picked one starts
// (usableTriggerIndexes / startingCondition), and the save refusal shown inline
// (fieldConditionIssues). An editor field's key is the field_key it is saved with (B-1), and its
// signer is its recipient. Pure: unit-tested.
import {
  CONDITION_TRIGGER_TYPES,
  FIELD_CONDITION_WHENS,
  fieldConditionIssues,
  startingCondition,
  usableTriggerIndexes,
  type ConditionalFieldLike,
  type FieldCondition,
  type FieldConditionIssue,
  type FieldConditionWhen,
} from '@aramo/sign-client';

import type { EditorField } from './editorReducer';
import { cleanChoices } from './fieldSettings';
import { FIELD_TYPE_SPECS } from './fieldTypes';

/** The editor's fields as the shared cross-field rule reads them (choices as they are saved). */
export function conditionRows(fields: readonly EditorField[]): ConditionalFieldLike[] {
  return fields.map((f) => ({
    field_key: f.key,
    field_type: f.type,
    signer: f.recipientKey,
    condition: f.condition ?? null,
    options: f.options ? { ...f.options, choices: cleanChoices(f.options.choices) } : null,
    sender_filled: f.senderFilled === true,
  }));
}

/** The fields that may show or hide `key` (the shared rule). */
export function usableTriggers(fields: readonly EditorField[], key: string): EditorField[] {
  const index = fields.findIndex((f) => f.key === key);
  return index < 0 ? [] : usableTriggerIndexes(conditionRows(fields), index).flatMap((i) => (fields[i] ? [fields[i]] : []));
}

/** The condition `key` starts with when `trigger` is picked (null: it can't be a trigger). */
export function conditionFor(trigger: EditorField): FieldCondition | null {
  return startingCondition({ field_key: trigger.key, field_type: trigger.type, options: trigger.options ?? null });
}

/** The save refusal of this field's condition (the server's rule), or null. */
export function conditionIssueOf(fields: readonly EditorField[], key: string): FieldConditionIssue | null {
  const index = fields.findIndex((f) => f.key === key);
  return fieldConditionIssues(conditionRows(fields)).find((i) => i.index === index) ?? null;
}

/** The fields whose condition names `key`. */
export function dependentsOfKey(fields: readonly EditorField[], key: string): EditorField[] {
  return fields.filter((f) => f.key !== key && f.condition?.trigger_key === key);
}

/** The rules a trigger of this type offers. */
export function conditionWhensFor(type: string): FieldConditionWhen[] {
  return FIELD_CONDITION_WHENS.filter((w) => CONDITION_TRIGGER_TYPES[w].includes(type));
}

/** How a field is named in the trigger list: its type, its label and its page. */
export function describeField(f: EditorField): string {
  const label = (f.label ?? '').trim();
  return `${FIELD_TYPE_SPECS[f.type].label}${label.length > 0 ? ` “${label}”` : ''} · page ${f.page + 1}`;
}

/** The warning after a delete left fields without their trigger (0: none). */
export function conditionsClearedText(n: number): string {
  if (n <= 0) return '';
  return `${n} field${n === 1 ? '' : 's'} that showed only for an answer to the deleted field ${n === 1 ? 'is' : 'are'} now always shown. Undo brings the condition back.`;
}
