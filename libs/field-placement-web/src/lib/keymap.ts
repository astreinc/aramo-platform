// FIELD-PARITY-1 P1-5 — the ONE placement keymap (sign-web Prepare's, now also the console's):
// on a focused field, arrows move 2pt (Shift: 10pt), Alt+arrows resize, Delete / Backspace
// removes, Escape deselects, Enter / Space selects; anywhere outside a text control,
// Cmd/Ctrl+Z undoes. Pure: the editor maps a key event to an intent.
//
// P2 (§5 P2-1..P2-3) — the keys act on the whole selection when the focused field is part of
// it; Shift+Enter / Shift+Space adds or removes the focused field; outside a text control,
// Shift+Cmd/Ctrl+Z and Ctrl+Y redo, and (inside the editor) Cmd/Ctrl+D duplicates,
// Cmd/Ctrl+C copies, Cmd/Ctrl+V pastes onto the page in view, Cmd/Ctrl+A selects the page's fields.
// KEYMAP below is the table both hosts show (and the parity checklist quotes).

export const NUDGE_STEP = 2;
export const NUDGE_STEP_LARGE = 10;

export interface KeyLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
}

export type FieldKeyIntent =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'resize'; readonly dw: number; readonly dh: number }
  | { readonly kind: 'delete' }
  | { readonly kind: 'deselect' }
  | { readonly kind: 'select' }
  | { readonly kind: 'toggle' };

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** The intent of a key pressed on a focused field (top-left frame: down = +dy), or null. */
export function fieldKeyIntent(e: KeyLike): FieldKeyIntent | null {
  const a = ARROWS[e.key];
  if (a !== undefined) {
    const step = e.shiftKey === true ? NUDGE_STEP_LARGE : NUDGE_STEP;
    return e.altKey === true ? { kind: 'resize', dw: a[0] * step, dh: a[1] * step } : { kind: 'move', dx: a[0] * step, dy: a[1] * step };
  }
  if (e.key === 'Delete' || e.key === 'Backspace') return { kind: 'delete' };
  if (e.key === 'Escape') return { kind: 'deselect' };
  if (e.key === 'Enter' || e.key === ' ') return e.shiftKey === true ? { kind: 'toggle' } : { kind: 'select' };
  return null;
}

/** Cmd/Ctrl+Z (without Shift: Shift is kept free for a Phase 2 redo). */
export function isUndoKey(e: KeyLike): boolean {
  return (e.metaKey === true || e.ctrlKey === true) && e.shiftKey !== true && e.key.toLowerCase() === 'z';
}

/** Shift+Cmd/Ctrl+Z, or Ctrl+Y (the Windows convention). */
export function isRedoKey(e: KeyLike): boolean {
  const k = e.key.toLowerCase();
  return (e.metaKey === true || e.ctrlKey === true) && ((e.shiftKey === true && k === 'z') || (e.ctrlKey === true && e.shiftKey !== true && k === 'y'));
}

export type EditorKeyIntent = 'undo' | 'redo' | 'duplicate' | 'copy' | 'paste' | 'select-all';

/** The editor-wide shortcut a key event means (the editor ignores them inside text controls). */
export function editorKeyIntent(e: KeyLike): EditorKeyIntent | null {
  if (isRedoKey(e)) return 'redo';
  if (isUndoKey(e)) return 'undo';
  if ((e.metaKey !== true && e.ctrlKey !== true) || e.shiftKey === true || e.altKey === true) return null;
  switch (e.key.toLowerCase()) {
    case 'd':
      return 'duplicate';
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'a':
      return 'select-all';
    default:
      return null;
  }
}

/** The keymap as shown to people (help text and the parity checklist). Cmd on a Mac, Ctrl elsewhere. */
export const KEYMAP: readonly { readonly keys: string; readonly action: string }[] = [
  { keys: 'Arrow keys', action: `Move the selection ${NUDGE_STEP}pt` },
  { keys: 'Shift+Arrow keys', action: `Move the selection ${NUDGE_STEP_LARGE}pt` },
  { keys: 'Alt+Arrow keys', action: `Resize the selection (${NUDGE_STEP}pt; with Shift ${NUDGE_STEP_LARGE}pt)` },
  { keys: 'Delete / Backspace', action: 'Delete the selection' },
  { keys: 'Enter / Space', action: 'Select the focused field' },
  { keys: 'Shift+Enter / Shift+Space', action: 'Add or remove the focused field from the selection' },
  { keys: 'Escape', action: 'Clear the selection' },
  { keys: 'Cmd/Ctrl+A', action: 'Select every field on the page' },
  { keys: 'Cmd/Ctrl+D', action: 'Duplicate the selection' },
  { keys: 'Cmd/Ctrl+C', action: 'Copy the selection' },
  { keys: 'Cmd/Ctrl+V', action: 'Paste onto the page in view (same position)' },
  { keys: 'Cmd/Ctrl+Z', action: 'Undo' },
  { keys: 'Shift+Cmd/Ctrl+Z or Ctrl+Y', action: 'Redo' },
  { keys: 'Shift while dragging', action: 'Turn snapping off for this drag' },
  { keys: 'Shift+click', action: 'Add or remove a field from the selection' },
];

/** Whether a key event's target is a text control (where Cmd/Ctrl+Z belongs to the control). */
export function isTextControl(target: unknown): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}
