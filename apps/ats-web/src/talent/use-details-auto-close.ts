import { useEffect, type RefObject } from 'react';

// Close a native <details> dropdown when the user clicks outside it or presses
// Escape — the click-outside-to-dismiss behavior the rest of the app's filters
// have (e.g. the Requisitions list's native selects). The <details> stays
// UNCONTROLLED (no React `open` prop); we toggle the `open` attribute directly,
// so React never fights the browser's native summary toggle.
export function useDetailsAutoClose(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    function close(): void {
      ref.current?.removeAttribute('open');
    }
    function onPointerDown(e: PointerEvent): void {
      const el = ref.current;
      if (el === null || !el.open) return;
      if (e.target instanceof Node && !el.contains(e.target)) close();
    }
    function onKeyDown(e: KeyboardEvent): void {
      const el = ref.current;
      if (el === null || !el.open) return;
      if (e.key === 'Escape') close();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ref]);
}
