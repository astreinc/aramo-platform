import { useEffect, useLayoutEffect, useRef } from 'react';

// PLATFORM-UX-1 F-1 — focus returns to the opener when a dialog or drawer
// closes (handoff §3.8, §8.1, §15). The fe-foundation Dialog has no Trigger, and
// Radix only restores focus to its own Trigger, so the opener is remembered here:
// captured in a layout effect when `open` turns true (before Radix moves focus
// into the content) and focused again after the content has unmounted.
export function useReturnFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
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
    opener.current = null;
    if (target === null) return undefined;
    const timer = window.setTimeout(() => {
      if (target.isConnected) target.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);
}
