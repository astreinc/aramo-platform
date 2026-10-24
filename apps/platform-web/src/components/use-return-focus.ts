import { useEffect, useLayoutEffect, useRef } from 'react';

// PLATFORM-UX-1 F-1 — focus returns to the opener when a dialog or drawer
// closes (handoff §3.8, §8.1, §15). The fe-foundation Dialog has no Trigger, and
// Radix only restores focus to its own Trigger, so the opener is remembered here:
// captured in a layout effect when `open` turns true (before Radix moves focus
// into the content) and focused again after the content has unmounted.
export function useReturnFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  // The dialog/drawer that held the opener (a confirm dialog opened from a
  // drawer's footer): focus falls back to it when the opener itself is gone
  // (e.g. the footer action changed after the commit).
  const container = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      container.current = opener.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return undefined;
    }
    if (!wasOpen.current) return undefined;
    wasOpen.current = false;
    const target = opener.current;
    const fallback = container.current;
    opener.current = null;
    if (target === null) return undefined;
    const timer = window.setTimeout(() => {
      if (target.isConnected) target.focus();
      else if (fallback?.isConnected) fallback.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // A dialog that is UNMOUNTED while open (the parent renders it only while it
  // is open) never sees open → false: restore focus on unmount too. Radix's
  // own close auto-focus targets a Dialog.Trigger, which these dialogs don't
  // have, so without this focus falls to <body> (H-1 keyboard journeys J3/J5).
  useEffect(
    () => () => {
      const target = wasOpen.current ? opener.current : null;
      const fallback = container.current;
      if (target === null) return;
      window.setTimeout(() => {
        if (document.activeElement !== null && document.activeElement !== document.body) return;
        if (target.isConnected) target.focus();
        else if (fallback?.isConnected) fallback.focus();
      }, 0);
    },
    [],
  );
}
