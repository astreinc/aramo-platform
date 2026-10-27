// The field editor's state machine (handoff §4.6 "Step 3: Fields"; directive §5).
// Pure: every action is deterministic (ids come in the action), so it is unit-tested
// without a renderer. Boxes are in the EDITOR frame (PDF points, top-left origin);
// geometry.ts converts to and from the wire and the screen.
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

export interface EditorField extends Box {
  /** Client key (the server re-creates fields on every PUT). */
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
  /** M-A6 §2.3 — CHECKBOX only. */
  readonly label?: string | null;
  readonly groupKey?: string | null;
  readonly groupRule?: GroupRule | null;
  readonly minSelected?: number | null;
}

export interface EditorState {
  readonly fields: readonly EditorField[];
  readonly selected: string | null;
  readonly tool: AuthoringFieldType | null;
  readonly activeRecipient: string | null;
  /** Snapshots of `fields`, oldest first, at most UNDO_DEPTH. */
  readonly undo: readonly (readonly EditorField[])[];
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
    }
  | {
      /** Accessible placement (handoff §7): the picked tool, centred on the page. */
      readonly type: 'placeAtCenter';
      readonly key: string;
      readonly docKey: string;
      readonly page: number;
      readonly pageSize: PageSize;
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
  | { readonly type: 'delete'; readonly key: string }
  | { readonly type: 'undo' }
  /** Recipients changed elsewhere: drop the fields of removed recipients. */
  | { readonly type: 'recipientsChanged'; readonly recipientKeys: readonly string[] };

export function initialEditorState(
  fields: readonly EditorField[] = [],
  activeRecipient: string | null = null,
): EditorState {
  return { fields, selected: null, tool: null, activeRecipient, undo: [] };
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
  };
}

/** The boxes of `groupKey` (none when null). */
export function groupMembers(
  fields: readonly EditorField[],
  groupKey: string | null | undefined,
): EditorField[] {
  if (groupKey === null || groupKey === undefined) return [];
  return fields.filter((f) => f.type === 'CHECKBOX' && f.groupKey === groupKey);
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
      const box = centeredBox(center, spec, a.pageSize);
      const f = newField(a.key, tool, recipient, a.docKey, a.page, box);
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
      if (!f || f.type !== 'CHECKBOX') return s;
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
      if (!f || f.type !== 'CHECKBOX' || (f.groupKey ?? null) === a.groupKey) return s;
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
      if (lead && lead.recipientKey !== f.recipientKey) return s;
      const joined = mapField(s.fields, a.key, (x) => ({
        ...x,
        groupKey: a.groupKey,
        groupRule: lead?.groupRule ?? 'SELECT_ANY',
        minSelected: lead ? (lead.minSelected ?? null) : null,
        required: lead ? lead.required : x.required,
      }));
      return commit(s, clampGroupMin(joined, f.groupKey));
    }
    case 'setGroupRule': {
      const f = s.fields.find((x) => x.key === a.key);
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
  const label = f.type === 'CHECKBOX' && f.label ? ` "${f.label}"` : '';
  return `${FIELD_TYPE_SPECS[f.type].label}${label}, for ${signerName}, ${f.required ? 'required' : 'optional'}, empty`;
}

/** Field count per recipient key, for the signer chips. */
export function fieldCounts(fields: readonly EditorField[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const f of fields) m.set(f.recipientKey, (m.get(f.recipientKey) ?? 0) + 1);
  return m;
}
