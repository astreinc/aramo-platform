import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';

// PLATFORM-UX-1 F-9 (handoff §10.4 Drag and drop) — one drag model for the canvas blocks,
// the Outline rows and the Variables cards (Sections is the designed empty state, R-13).
// A 3px line marks the drop point above / below the target; while dragging, a "Drop here
// to add at the end" zone appears. The payload lives in a ref (not dataTransfer), so a
// drag from another page carries nothing the Studio would act on.

export type DragPayload = { readonly kind: 'block'; readonly id: string } | { readonly kind: 'var'; readonly key: string };
export type DropPos = 'before' | 'after';

export interface StudioDrag {
  readonly dragging: boolean;
  readonly dropAt: { readonly id: string; readonly pos: DropPos } | null;
  readonly start: (e: DragEvent, payload: DragPayload) => void;
  readonly end: () => void;
  /** Over a block / outline row: mark before / after by the pointer's half. */
  readonly over: (e: DragEvent<HTMLElement>, id: string) => void;
  /** Over the canvas background or the end zone. */
  readonly overCanvas: (e: DragEvent) => void;
  /** Drop on a block / row (`id`) or at the end (null). */
  readonly drop: (e: DragEvent, id: string | null) => void;
}

export function useStudioDrag(onDrop: (payload: DragPayload, targetId: string | null, pos: DropPos) => void): StudioDrag {
  const payload = useRef<DragPayload | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropAt, setDropAt] = useState<{ id: string; pos: DropPos } | null>(null);
  const dropRef = useRef(dropAt);
  dropRef.current = dropAt;

  const end = useCallback(() => {
    payload.current = null;
    setDragging(false);
    setDropAt(null);
  }, []);

  const start = useCallback((e: DragEvent, p: DragPayload) => {
    try {
      e.dataTransfer.setData('text/plain', p.kind);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      // jsdom / restricted DataTransfer — the ref carries the payload.
    }
    payload.current = p;
    setDragging(true);
  }, []);

  const over = useCallback((e: DragEvent<HTMLElement>, id: string) => {
    if (payload.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const pos: DropPos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    const d = dropRef.current;
    if (d === null || d.id !== id || d.pos !== pos) setDropAt({ id, pos });
  }, []);

  const overCanvas = useCallback((e: DragEvent) => {
    if (payload.current !== null) e.preventDefault();
  }, []);

  const drop = useCallback(
    (e: DragEvent, id: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      const p = payload.current;
      const pos = dropRef.current?.pos ?? 'after';
      end();
      if (p !== null) onDrop(p, id, pos);
    },
    [end, onDrop],
  );

  return useMemo(() => ({ dragging, dropAt, start, end, over, overCanvas, drop }), [dragging, dropAt, start, end, over, overCanvas, drop]);
}
