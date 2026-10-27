import { useCallback, useRef, useState } from 'react';

import type { StudioDoc } from './doc-ops';

// PLATFORM-UX-1 F-9 (handoff §10.8 ⌘Z / ⌘⇧Z) — the Studio document with its own undo /
// redo history (the browser's contentEditable undo is never used: it would desync the
// block model). Typing in one block coalesces into a single step for 800ms.

const COALESCE_MS = 800;
const MAX_HISTORY = 200;

export interface StudioDocState {
  readonly doc: StudioDoc;
  /** Increments on every change (dirty = editRev !== the rev last saved). */
  readonly editRev: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Apply a change. `coalesce` groups consecutive changes with the same key. */
  readonly change: (next: (d: StudioDoc) => StudioDoc, coalesce?: string) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  /** Replace without history (load); the edit revision restarts at 0. */
  readonly reset: (doc: StudioDoc) => void;
}

export function useStudioDoc(initial: StudioDoc): StudioDocState {
  const [state, setState] = useState<{ doc: StudioDoc; past: StudioDoc[]; future: StudioDoc[]; editRev: number }>({
    doc: initial,
    past: [],
    future: [],
    editRev: 0,
  });
  const last = useRef<{ key: string; at: number } | null>(null);

  const change = useCallback((next: (d: StudioDoc) => StudioDoc, coalesce?: string) => {
    const now = Date.now();
    const merge = coalesce !== undefined && last.current !== null && last.current.key === coalesce && now - last.current.at < COALESCE_MS;
    last.current = coalesce !== undefined ? { key: coalesce, at: now } : null;
    setState((s) => {
      const doc = next(s.doc);
      if (doc === s.doc) return s;
      const past = merge ? s.past : [...s.past, s.doc].slice(-MAX_HISTORY);
      return { doc, past, future: [], editRev: s.editRev + 1 };
    });
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setState((s) => {
      const prev = s.past[s.past.length - 1];
      if (prev === undefined) return s;
      return { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], editRev: s.editRev + 1 };
    });
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setState((s) => {
      const [nxt, ...rest] = s.future;
      if (nxt === undefined) return s;
      return { doc: nxt, past: [...s.past, s.doc], future: rest, editRev: s.editRev + 1 };
    });
  }, []);

  const reset = useCallback((doc: StudioDoc) => {
    last.current = null;
    setState({ doc, past: [], future: [], editRev: 0 });
  }, []);

  return {
    doc: state.doc,
    editRev: state.editRev,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    change,
    undo,
    redo,
    reset,
  };
}
