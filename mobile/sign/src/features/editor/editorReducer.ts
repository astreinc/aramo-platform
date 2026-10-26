// The field editor's state machine (handoff §4.6 "Step 3: Fields"; directive §5).
// Pure: every action is deterministic (ids come in the action), so it is unit-tested
// without a renderer. Boxes are in the EDITOR frame (PDF points, top-left origin);
// geometry.ts converts to and from the wire and the screen.
import { FIELD_TYPE_SPECS, isAuthoringFieldType, type AuthoringFieldType } from './fieldTypes';
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
  };
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
      return commit(
        s,
        mapField(s.fields, a.key, (x) => ({ ...x, recipientKey: next })),
      );
    }
    case 'toggleRequired':
      if (!s.fields.some((f) => f.key === a.key)) return s;
      return commit(
        s,
        mapField(s.fields, a.key, (f) => ({ ...f, required: !f.required })),
      );
    case 'delete':
      if (!s.fields.some((f) => f.key === a.key)) return s;
      return {
        ...commit(
          s,
          s.fields.filter((f) => f.key !== a.key),
        ),
        selected: s.selected === a.key ? null : s.selected,
      };
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
  return `${FIELD_TYPE_SPECS[f.type].label}, for ${signerName}, ${f.required ? 'required' : 'optional'}, empty`;
}

/** Field count per recipient key, for the signer chips. */
export function fieldCounts(fields: readonly EditorField[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const f of fields) m.set(f.recipientKey, (m.get(f.recipientKey) ?? 0) + 1);
  return m;
}
