// The field editor's state machine (handoff §4.6 "Step 3: Fields"; directive §5).
// Pure: every action is deterministic (ids come in the action), so it is unit-tested
// without a renderer. Boxes are in the EDITOR frame (PDF points, top-left origin);
// geometry.ts converts to and from the wire and the screen.
import { fieldSettingsOf, isFieldTypeKey, pendingSuggestions, type FieldCondition } from '@aramo/sign-client';

import { NEW_DROPDOWN_CHOICES, isGroupedType, type EditorFieldSettings } from './fieldSettings';

import {
  FIELD_TYPE_SPECS,
  MAX_LABEL,
  isAuthoringFieldType,
  type AuthoringFieldType,
  type GroupRule,
  type NameMode,
} from './fieldTypes';
import {
  centeredBox,
  clampBox,
  moveBoxTo,
  resizeBoxTo,
  type Box,
  type PageSize,
  type Point,
} from './geometry';

export const UNDO_DEPTH = 30;
/** FIELD-PARITY-1 P3 T-5 — the gap (points) between a radio option and the next "Add option" places. */
export const RADIO_OPTION_GAP = 8;

export interface EditorField extends Box, EditorFieldSettings {
  /**
   * Client key (the server re-creates fields on every PUT). FIELD-PARITY-2 B-1 — also the
   * field's stable field_key on the wire (1..200 characters, unique in the envelope).
   */
  readonly key: string;
  /** The draft document's key. */
  readonly docKey: string;
  /** 0-based page index. */
  readonly page: number;
  /** The draft recipient's key. */
  readonly recipientKey: string;
  readonly type: AuthoringFieldType;
  readonly required: boolean;
  /** M-A6 §2.2 — SIGNER_NAME only (default SIGNER_PROFILE). */
  readonly nameMode?: NameMode;
  /** M-A6 §2.3 — a check box's caption; FIELD-PARITY-1 P3 S-1 — every type's label (a radio's option text). */
  readonly label?: string | null;
  /** M-A6 §2.3 — CHECKBOX; FIELD-PARITY-1 P3 T-5 — RADIO (always one). */
  readonly groupKey?: string | null;
  readonly groupRule?: GroupRule | null;
  readonly minSelected?: number | null;
  /**
   * FIELD-PARITY-2 B-2 — "show only when" (absent / null: always shown). Its trigger_key is
   * another field's `key`: an editor field's key is the field_key it is saved with (B-1).
   */
  readonly condition?: FieldCondition | null;
}

/**
 * FIELD-PARITY-1 P2-4 — a suggested field (the server's deterministic detector), EDITOR frame.
 * Shown as a ghost until accepted (it becomes a field) or dismissed.
 */
export interface EditorSuggestion extends Box {
  readonly key: string;
  readonly docKey: string;
  /** 0-based page index. */
  readonly page: number;
  readonly type: string;
  /** The detector's reason (`label:Title`, `underscore_line`, …). */
  readonly reason: string;
}

export interface EditorState {
  readonly fields: readonly EditorField[];
  readonly selected: string | null;
  readonly tool: AuthoringFieldType | null;
  readonly activeRecipient: string | null;
  /** Snapshots of `fields`, oldest first, at most UNDO_DEPTH. */
  readonly undo: readonly (readonly EditorField[])[];
  /** P2-4 — the loaded suggestions (none until "Suggest" runs) and the dismissed keys. */
  readonly suggestions: readonly EditorSuggestion[];
  readonly dismissed: readonly string[];
}

export type EditorAction =
  | {
      readonly type: 'load';
      readonly fields: readonly EditorField[];
      readonly activeRecipient: string | null;
    }
  | { readonly type: 'pickTool'; readonly tool: AuthoringFieldType | null }
  | { readonly type: 'setRecipient'; readonly recipientKey: string }
  | {
      readonly type: 'placeAt';
      readonly key: string;
      readonly docKey: string;
      readonly page: number;
      readonly pageSize: PageSize;
      /** The tap point, EDITOR frame. */
      readonly center: Point;
      /** M-A12 W1-E.2 — the user's default field size (1 = the type's default). */
      readonly scale?: number;
    }
  | {
      /** Accessible placement (handoff §7): the picked tool, centred on the page. */
      readonly type: 'placeAtCenter';
      readonly key: string;
      readonly docKey: string;
      readonly page: number;
      readonly pageSize: PageSize;
      readonly scale?: number;
    }
  | { readonly type: 'select'; readonly key: string | null }
  /** A drag or resize gesture starts: one undo step for the whole gesture. */
  | { readonly type: 'beginGesture' }
  /** Live gesture update (not recorded; beginGesture already recorded). */
  | {
      readonly type: 'moveTo';
      readonly key: string;
      readonly to: Point;
      readonly pageSize: PageSize;
    }
  | {
      readonly type: 'resizeTo';
      readonly key: string;
      readonly size: { readonly width: number; readonly height: number };
      readonly pageSize: PageSize;
    }
  /** Accessible move / resize controls (recorded, one step each). */
  | {
      readonly type: 'nudge';
      readonly key: string;
      readonly dx: number;
      readonly dy: number;
      readonly pageSize: PageSize;
    }
  | {
      readonly type: 'grow';
      readonly key: string;
      readonly dw: number;
      readonly dh: number;
      readonly pageSize: PageSize;
    }
  /** "Assign to {next signer}": cycles through the recipients in order. */
  | { readonly type: 'reassign'; readonly key: string; readonly recipientKeys: readonly string[] }
  | { readonly type: 'toggleRequired'; readonly key: string }
  /** M-A6 §2.2 — who supplies a Name field's value. */
  | { readonly type: 'setNameMode'; readonly key: string; readonly mode: NameMode }
  /** M-A6 §2.3 — a check box's caption (empty clears it). */
  | { readonly type: 'setLabel'; readonly key: string; readonly label: string }
  /**
   * M-A6 §2.3 — put a check box in a group (null leaves it). Joining an existing group
   * adopts its rule, minimum and required setting; a group belongs to one recipient.
   */
  | { readonly type: 'setGroup'; readonly key: string; readonly groupKey: string | null }
  /** Applies to every box of the group; SELECT_ONE resets the minimum. */
  | { readonly type: 'setGroupRule'; readonly key: string; readonly rule: GroupRule }
  /** Applies to every box of the group; clamped to 1 … group size. */
  | { readonly type: 'setMinSelected'; readonly key: string; readonly min: number }
  /**
   * FIELD-PARITY-1 P3 §6.2 — change the P3 settings of a field (one undo step). Only the settings
   * its type takes apply; a group's read-only / sender-filled apply to every field of the group;
   * turning sender-filled off clears read-only and the sender's value; a radio option chosen as
   * the sender's value clears the others of its group.
   */
  | { readonly type: 'configure'; readonly key: string; readonly patch: EditorFieldSettings }
  /** FIELD-PARITY-1 P3 T-5 — "Add option": a sibling radio button just below, same group. */
  | { readonly type: 'addRadioOption'; readonly key: string; readonly newKey: string; readonly pageSize: PageSize }
  | { readonly type: 'delete'; readonly key: string }
  | { readonly type: 'undo' }
  /** Recipients changed elsewhere: drop the fields of removed recipients. */
  | { readonly type: 'recipientsChanged'; readonly recipientKeys: readonly string[] }
  /** P2-4 — the suggestions just loaded (replaces any before; nothing dismissed). Not an edit. */
  | { readonly type: 'setSuggestions'; readonly suggestions: readonly EditorSuggestion[] }
  /**
   * P2-4 — accept these pending suggestions as fields for the active recipient: ONE undo step.
   * `fieldKeys[i]` is the new field's key for `keys[i]` (keys come in the action).
   */
  | { readonly type: 'acceptSuggestions'; readonly keys: readonly string[]; readonly fieldKeys: readonly string[] }
  /** P2-4 — hide these suggestions (not an edit: nothing to undo). */
  | { readonly type: 'dismissSuggestions'; readonly keys: readonly string[] };

export function initialEditorState(
  fields: readonly EditorField[] = [],
  activeRecipient: string | null = null,
): EditorState {
  return { fields, selected: null, tool: null, activeRecipient, undo: [], suggestions: [], dismissed: [] };
}

/**
 * P2-4 — the suggestions still shown as ghosts: an authoring type, not dismissed, not already
 * covered by a field (so an accepted one disappears and comes back on undo). The rule is the
 * one the web editor uses (@aramo/sign-fields pendingSuggestions).
 */
export function pendingEditorSuggestions(s: Pick<EditorState, 'suggestions' | 'dismissed' | 'fields'>): EditorSuggestion[] {
  const types = s.suggestions.map((x) => x.type).filter(isAuthoringFieldType);
  return pendingSuggestions(
    s.suggestions.map((x) => ({ ...x, id: x.key, docId: x.docKey })),
    s.fields.map((f) => ({ docId: f.docKey, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height })),
    { types, dismissed: new Set(s.dismissed) },
  ).map(({ id: _id, docId: _docId, ...x }) => x);
}

function pushUndo(s: EditorState): EditorState['undo'] {
  return [...s.undo, s.fields].slice(-UNDO_DEPTH);
}

function commit(s: EditorState, fields: readonly EditorField[]): EditorState {
  return { ...s, fields, undo: pushUndo(s) };
}

function mapField(
  fields: readonly EditorField[],
  key: string,
  fn: (f: EditorField) => EditorField,
): readonly EditorField[] {
  return fields.map((f) => (f.key === key ? fn(f) : f));
}

function newField(
  key: string,
  tool: AuthoringFieldType,
  recipientKey: string,
  docKey: string,
  page: number,
  box: Box,
  fields: readonly EditorField[] = [],
): EditorField {
  return {
    key,
    docKey,
    page,
    recipientKey,
    type: tool,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    required: FIELD_TYPE_SPECS[tool].requiredByDefault,
    ...(tool === 'SIGNER_NAME' ? { nameMode: 'SIGNER_PROFILE' as const } : {}),
    ...(tool === 'CHECKBOX'
      ? { label: null, groupKey: null, groupRule: null, minSelected: null }
      : {}),
    // FIELD-PARITY-1 P3 T-5 — a radio button is always one option of a group (its own, new).
    ...(tool === 'RADIO'
      ? { label: 'Option 1', groupKey: nextGroupKey(fields), groupRule: 'SELECT_ONE' as const, minSelected: null }
      : {}),
    // T-4 — a dropdown starts with two choices to edit (the server needs at least one).
    ...(tool === 'DROPDOWN' ? { options: { choices: NEW_DROPDOWN_CHOICES } } : {}),
  };
}

/** The boxes of `groupKey` (none when null): a check-box group or a radio group (T-5). */
export function groupMembers(
  fields: readonly EditorField[],
  groupKey: string | null | undefined,
): EditorField[] {
  if (groupKey === null || groupKey === undefined) return [];
  return fields.filter((f) => isGroupedType(f.type) && f.groupKey === groupKey);
}

/** The P3 settings `type` takes, from a patch (the rest dropped). */
function applicablePatch(type: string, patch: EditorFieldSettings): EditorFieldSettings {
  if (!isFieldTypeKey(type)) return {};
  const takes = new Set<string>(fieldSettingsOf(type));
  const key: Record<keyof EditorFieldSettings, string> = {
    tooltip: 'tooltip',
    placeholder: 'placeholder',
    readOnly: 'read_only',
    senderFilled: 'sender_filled',
    senderValue: 'sender_filled',
    validation: 'validation',
    fontSize: 'font_size',
    dataName: 'data_name',
    options: 'options',
  };
  return Object.fromEntries(
    Object.entries(patch).filter(([k]) => takes.has(key[k as keyof EditorFieldSettings])),
  ) as EditorFieldSettings;
}

/** A group key not yet used in `fields` ("group-1", "group-2", …). */
export function nextGroupKey(fields: readonly EditorField[]): string {
  const used = new Set(fields.map((f) => f.groupKey).filter((k): k is string => !!k));
  let n = 1;
  while (used.has(`group-${n}`)) n += 1;
  return `group-${n}`;
}

/** Apply `fn` to the field `key` and, when it is a grouped check box, its whole group. */
function mapGroup(
  fields: readonly EditorField[],
  key: string,
  fn: (f: EditorField) => EditorField,
): readonly EditorField[] {
  const f = fields.find((x) => x.key === key);
  if (!f) return fields;
  const members = new Set(groupMembers(fields, f.groupKey).map((m) => m.key));
  members.add(key);
  return fields.map((x) => (members.has(x.key) ? fn(x) : x));
}

/** After a box leaves a group, the group's minimum never exceeds its size. */
function clampGroupMin(fields: readonly EditorField[], groupKey: string | null | undefined) {
  const members = groupMembers(fields, groupKey);
  const min = members[0]?.minSelected;
  if (min === null || min === undefined || min <= members.length) return fields;
  const clamped = Math.max(1, members.length);
  return fields.map((f) =>
    f.type === 'CHECKBOX' && f.groupKey === groupKey ? { ...f, minSelected: clamped } : f,
  );
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'load':
      return initialEditorState(
        a.fields.filter((f) => isAuthoringFieldType(f.type)),
        a.activeRecipient,
      );
    case 'setSuggestions':
      return { ...s, suggestions: a.suggestions, dismissed: [] };
    case 'dismissSuggestions': {
      const known = new Set(s.suggestions.map((x) => x.key));
      const add = a.keys.filter((k) => known.has(k) && !s.dismissed.includes(k));
      return add.length === 0 ? s : { ...s, dismissed: [...s.dismissed, ...add] };
    }
    case 'acceptSuggestions': {
      const recipient = s.activeRecipient;
      if (recipient === null) return s;
      const pending = new Map(pendingEditorSuggestions(s).map((x) => [x.key, x]));
      const added: EditorField[] = [];
      a.keys.forEach((k, i) => {
        const sug = pending.get(k);
        const key = a.fieldKeys[i];
        if (!sug || key === undefined || !isAuthoringFieldType(sug.type)) return;
        added.push(newField(key, sug.type, recipient, sug.docKey, sug.page, { x: sug.x, y: sug.y, width: sug.width, height: sug.height }, [...s.fields, ...added]));
      });
      if (added.length === 0) return s;
      return { ...commit(s, [...s.fields, ...added]), tool: null, selected: added.length === 1 ? (added[0]?.key ?? null) : null };
    }
    case 'pickTool':
      if (a.tool !== null && !isAuthoringFieldType(a.tool)) return s;
      return { ...s, tool: a.tool, selected: a.tool !== null ? null : s.selected };
    case 'setRecipient':
      return { ...s, activeRecipient: a.recipientKey };
    case 'placeAt':
    case 'placeAtCenter': {
      const tool = s.tool;
      const recipient = s.activeRecipient;
      if (tool === null || recipient === null || !isAuthoringFieldType(tool)) return s;
      const spec = FIELD_TYPE_SPECS[tool];
      const center =
        a.type === 'placeAt' ? a.center : { x: a.pageSize.width / 2, y: a.pageSize.height / 2 };
      const k = a.scale && a.scale > 0 ? a.scale : 1;
      const box = centeredBox(
        center,
        { width: Math.round(spec.width * k), height: Math.round(spec.height * k) },
        a.pageSize,
      );
      const f = newField(a.key, tool, recipient, a.docKey, a.page, box, s.fields);
      // The tool is released and the new field selected (handoff §4.6).
      return { ...commit(s, [...s.fields, f]), tool: null, selected: f.key };
    }
    case 'select':
      if (a.key !== null && !s.fields.some((f) => f.key === a.key)) return s;
      return { ...s, selected: a.key, tool: a.key !== null ? null : s.tool };
    case 'beginGesture':
      return { ...s, undo: pushUndo(s) };
    case 'moveTo':
      return {
        ...s,
        fields: mapField(s.fields, a.key, (f) => ({ ...f, ...moveBoxTo(f, a.to, a.pageSize) })),
      };
    case 'resizeTo':
      return {
        ...s,
        fields: mapField(s.fields, a.key, (f) => ({ ...f, ...resizeBoxTo(f, a.size, a.pageSize) })),
      };
    case 'nudge': {
      if (!s.fields.some((f) => f.key === a.key)) return s;
      return commit(
        s,
        mapField(s.fields, a.key, (f) => ({
          ...f,
          ...clampBox(
            { x: f.x + a.dx, y: f.y + a.dy, width: f.width, height: f.height },
            a.pageSize,
          ),
        })),
      );
    }
    case 'grow': {
      if (!s.fields.some((f) => f.key === a.key)) return s;
      return commit(
        s,
        mapField(s.fields, a.key, (f) => ({
          ...f,
          ...resizeBoxTo(f, { width: f.width + a.dw, height: f.height + a.dh }, a.pageSize),
        })),
      );
    }
    case 'reassign': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f || a.recipientKeys.length < 2) return s;
      const i = a.recipientKeys.indexOf(f.recipientKey);
      const next = a.recipientKeys[(i + 1) % a.recipientKeys.length];
      if (next === undefined) return s;
      // A check-box group belongs to one recipient: the whole group moves.
      return commit(
        s,
        mapGroup(s.fields, a.key, (x) => ({ ...x, recipientKey: next })),
      );
    }
    case 'toggleRequired': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f) return s;
      const required = !f.required;
      return commit(
        s,
        mapGroup(s.fields, a.key, (x) => ({ ...x, required })),
      );
    }
    case 'setNameMode': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f || f.type !== 'SIGNER_NAME' || f.nameMode === a.mode) return s;
      return commit(
        s,
        mapField(s.fields, a.key, (x) => ({ ...x, nameMode: a.mode })),
      );
    }
    case 'setLabel': {
      const f = s.fields.find((x) => x.key === a.key);
      // FIELD-PARITY-1 P3 S-1 — every type that takes a label (the catalog).
      if (!f || !isFieldTypeKey(f.type) || !fieldSettingsOf(f.type).includes('label')) return s;
      const label = a.label.trim().slice(0, MAX_LABEL);
      const next = label.length > 0 ? label : null;
      if ((f.label ?? null) === next) return s;
      return commit(
        s,
        mapField(s.fields, a.key, (x) => ({ ...x, label: next })),
      );
    }
    case 'setGroup': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f || !isGroupedType(f.type) || (f.groupKey ?? null) === a.groupKey) return s;
      // T-5 — a radio button never leaves every group.
      if (f.type === 'RADIO' && a.groupKey === null) return s;
      if (a.groupKey === null) {
        const left = mapField(s.fields, a.key, (x) => ({
          ...x,
          groupKey: null,
          groupRule: null,
          minSelected: null,
        }));
        return commit(s, clampGroupMin(left, f.groupKey));
      }
      const others = groupMembers(s.fields, a.groupKey).filter((m) => m.key !== a.key);
      const lead = others[0];
      if (lead && (lead.recipientKey !== f.recipientKey || lead.type !== f.type)) return s;
      const joined = mapField(s.fields, a.key, (x) => ({
        ...x,
        groupKey: a.groupKey,
        groupRule: x.type === 'RADIO' ? 'SELECT_ONE' : (lead?.groupRule ?? 'SELECT_ANY'),
        minSelected: lead && x.type !== 'RADIO' ? (lead.minSelected ?? null) : null,
        required: lead ? lead.required : x.required,
        // P3 — a group shares its read-only / sender-filled setting.
        ...(lead ? { readOnly: lead.readOnly === true, senderFilled: lead.senderFilled === true } : {}),
        ...(lead && lead.senderFilled !== true ? { senderValue: null } : {}),
      }));
      return commit(s, clampGroupMin(joined, f.groupKey));
    }
    case 'setGroupRule': {
      const f = s.fields.find((x) => x.key === a.key);
      // T-5 — a radio group's rule is always SELECT_ONE.
      if (!f || f.type !== 'CHECKBOX' || !f.groupKey || f.groupRule === a.rule) return s;
      return commit(
        s,
        mapGroup(s.fields, a.key, (x) => ({
          ...x,
          groupRule: a.rule,
          minSelected: a.rule === 'SELECT_ONE' ? null : (x.minSelected ?? null),
        })),
      );
    }
    case 'setMinSelected': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f || f.type !== 'CHECKBOX' || !f.groupKey || f.groupRule === 'SELECT_ONE') return s;
      const size = groupMembers(s.fields, f.groupKey).length;
      const min = Math.max(1, Math.min(size, Math.round(a.min)));
      const value = min === 1 ? null : min;
      if ((f.minSelected ?? null) === value) return s;
      return commit(
        s,
        mapGroup(s.fields, a.key, (x) => ({ ...x, minSelected: value })),
      );
    }
    case 'configure': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f) return s;
      const patch = applicablePatch(f.type, a.patch);
      if (Object.keys(patch).length === 0) return s;
      let next: EditorField = { ...f, ...patch };
      // S-4 — read-only only with sender-filled; a field no longer sender-filled loses its value.
      if (next.senderFilled !== true) next = { ...next, readOnly: false, senderValue: null };
      const changed = (Object.keys(next) as (keyof EditorField)[]).some((k) => JSON.stringify(next[k]) !== JSON.stringify(f[k]));
      if (!changed) return s;
      const shared = patch.readOnly !== undefined || patch.senderFilled !== undefined;
      const radioChosen = f.type === 'RADIO' && patch.senderValue === 'true';
      const members = new Set(groupMembers(s.fields, f.groupKey).map((m) => m.key));
      return commit(
        s,
        s.fields.map((x) => {
          if (x.key === f.key) return next;
          if (!members.has(x.key)) return x;
          let y = x;
          if (shared) {
            y = { ...y, readOnly: next.readOnly === true, senderFilled: next.senderFilled === true };
            if (next.senderFilled !== true) y = { ...y, senderValue: null };
          }
          if (radioChosen && y.senderValue === 'true') y = { ...y, senderValue: 'false' };
          return y;
        }),
      );
    }
    case 'addRadioOption': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f || f.type !== 'RADIO' || !f.groupKey || s.fields.some((x) => x.key === a.newKey)) return s;
      const count = groupMembers(s.fields, f.groupKey).length;
      // EDITOR frame (top-left origin): below = a larger y.
      const box = clampBox({ x: f.x, y: f.y + f.height + RADIO_OPTION_GAP, width: f.width, height: f.height }, a.pageSize);
      const sibling: EditorField = {
        ...f,
        ...box,
        key: a.newKey,
        label: `Option ${count + 1}`,
        senderValue: f.senderFilled === true ? 'false' : null,
      };
      return { ...commit(s, [...s.fields, sibling]), selected: sibling.key };
    }
    case 'delete': {
      const f = s.fields.find((x) => x.key === a.key);
      if (!f) return s;
      return {
        ...commit(
          s,
          clampGroupMin(
            s.fields.filter((x) => x.key !== a.key),
            f.groupKey,
          ),
        ),
        selected: s.selected === a.key ? null : s.selected,
      };
    }
    case 'undo': {
      const prev = s.undo[s.undo.length - 1];
      if (prev === undefined) return s;
      const selected =
        s.selected !== null && prev.some((f) => f.key === s.selected) ? s.selected : null;
      return { ...s, fields: prev, undo: s.undo.slice(0, -1), selected };
    }
    case 'recipientsChanged': {
      const keep = new Set(a.recipientKeys);
      const filtered = s.fields.filter((f) => keep.has(f.recipientKey));
      const removed = filtered.length !== s.fields.length;
      const fields = removed ? filtered : s.fields;
      const active =
        s.activeRecipient !== null && keep.has(s.activeRecipient)
          ? s.activeRecipient
          : (a.recipientKeys[0] ?? null);
      const selected =
        s.selected !== null && fields.some((f) => f.key === s.selected) ? s.selected : null;
      // Undo snapshots may reference removed recipients, so they go with them.
      return { ...s, fields, activeRecipient: active, selected, undo: removed ? [] : s.undo };
    }
  }
}

/** "{Type}, for {signer}, {required|optional}, {empty}" (handoff §7). */
export function fieldAccessibilityLabel(f: EditorField, signerName: string): string {
  const label = f.label && (f.type === 'CHECKBOX' || f.type === 'RADIO' || f.type === 'ACKNOWLEDGEMENT') ? ` "${f.label}"` : '';
  return `${FIELD_TYPE_SPECS[f.type].label}${label}, for ${signerName}, ${f.required ? 'required' : 'optional'}, empty`;
}

/** Field count per recipient key, for the signer chips. */
export function fieldCounts(fields: readonly EditorField[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const f of fields) m.set(f.recipientKey, (m.get(f.recipientKey) ?? 0) + 1);
  return m;
}
