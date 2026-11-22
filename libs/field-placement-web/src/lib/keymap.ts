// FIELD-PARITY-1 P1-5 — the ONE placement keymap (sign-web Prepare's, now also the console's):
// on a focused field, arrows move 2pt (Shift: 10pt), Alt+arrows resize, Delete / Backspace
// removes, Escape deselects, Enter / Space selects; anywhere outside a text control,
// Cmd/Ctrl+Z undoes. Pure: the editor maps a key event to an intent.

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
  | { readonly kind: 'select' };

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
  if (e.key === 'Enter' || e.key === ' ') return { kind: 'select' };
  return null;
}

/** Cmd/Ctrl+Z (without Shift: Shift is kept free for a Phase 2 redo). */
export function isUndoKey(e: KeyLike): boolean {
  return (e.metaKey === true || e.ctrlKey === true) && e.shiftKey !== true && e.key.toLowerCase() === 'z';
}

/** Whether a key event's target is a text control (where Cmd/Ctrl+Z belongs to the control). */
export function isTextControl(target: unknown): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}
