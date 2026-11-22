import { useCallback, useEffect, useRef, useState } from 'react';

// FIELD-PARITY-1 P1-5 — sign-web Prepare's autosave, shared: after a user edit (a new
// `revision`), wait `delayMs` (600) of quiet, then save the full field set through the host's
// own call. A newer edit restarts the wait; `flush()` saves now (the console's Save button).

export const AUTOSAVE_DELAY_MS = 600;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveOptions {
  /** Bumped by every user edit; 0 (or unchanged) never saves. */
  readonly revision: number;
  readonly enabled: boolean;
  readonly save: () => Promise<void>;
  readonly delayMs?: number;
  readonly formatError?: (e: unknown) => string;
}

export interface Autosave {
  readonly state: SaveState;
  readonly error: string;
  /** Save now (cancels a pending autosave). */
  readonly flush: () => Promise<void>;
}

const defaultFormat = (e: unknown): string => (e instanceof Error && e.message !== '' ? e.message : 'Not saved.');

export function useAutosave({ revision, enabled, save, delayMs = AUTOSAVE_DELAY_MS, formatError = defaultFormat }: AutosaveOptions): Autosave {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saved = useRef(revision);
  const latest = useRef({ save, formatError });
  latest.current = { save, formatError };

  const run = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setState('saving');
    try {
      await latest.current.save();
      setState('saved');
      setError('');
    } catch (e) {
      setState('error');
      setError(latest.current.formatError(e));
    }
  }, []);

  useEffect(() => {
    if (!enabled || revision === saved.current) return undefined;
    saved.current = revision;
    setState('saving');
    timer.current = setTimeout(() => {
      timer.current = null;
      void run();
    }, delayMs);
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [revision, enabled, delayMs, run]);

  return { state, error, flush: run };
}
