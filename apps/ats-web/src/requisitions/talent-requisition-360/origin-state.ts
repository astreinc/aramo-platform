import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Origin-view memory for the Talent × Requisition 360 entry points. When an origin
// surface (Requisitions list, Requisition detail) navigates to the 360 page it
// saves its view state (filters, expanded row, tab) plus the window scroll to
// sessionStorage; on the browser Back (a POP navigation) the origin consumes that
// snapshot ONCE and restores it. Any other mount starts clean. Session-scoped and
// best-effort: a storage failure simply means no restore.

const PREFIX = 'aramo.origin.';

interface Stored<T> {
  readonly value: T;
  readonly y: number;
  /** The history entry (location.key) the snapshot belongs to. */
  readonly entry: string;
}

/**
 * Save the origin's view state (+ current scroll) right before leaving for the 360
 * page. `entry` is the origin's current `location.key`, so only a Back to that same
 * history entry restores it.
 */
export function saveOriginSnapshot<T>(key: string, entry: string, value: T): void {
  try {
    const stored: Stored<T> = { value, y: window.scrollY, entry };
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(stored));
  } catch {
    /* storage unavailable — no restore */
  }
}

function read<T>(key: string): Stored<T> | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as Stored<T>);
  } catch {
    return null;
  }
}

export interface OriginSnapshot<T> {
  readonly value: T;
  readonly y: number;
}

/** The snapshot saved for `key`, consumed once on a Back/Forward (POP) mount; null otherwise. */
export function useOriginSnapshot<T>(key: string): OriginSnapshot<T> | null {
  const navType = useNavigationType();
  const { key: entry } = useLocation();
  const [stored] = useState<Stored<T> | null>(() => {
    if (navType !== 'POP') return null;
    const s = read<T>(key);
    return s !== null && s.entry === entry ? s : null;
  });
  // Consume after mount (an effect, so a StrictMode double-render still reads it).
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* storage unavailable */
    }
  }, [key]);
  return stored;
}

/** Re-apply a restored scroll position once the origin's content has rendered. */
export function useRestoreScroll(snapshot: OriginSnapshot<unknown> | null, ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || snapshot === null) return;
    done.current = true;
    const { y } = snapshot;
    if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
  }, [ready, snapshot]);
}
