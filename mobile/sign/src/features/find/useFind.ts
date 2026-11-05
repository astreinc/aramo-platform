// M-A12 W1-C.2 — Find state for an open set of documents. Text layers load lazily the
// first time Find opens, are held in component memory only, and are dropped with it.
import { useCallback, useMemo, useRef, useState } from 'react';

import type { TextLayer } from '../../api/m-a12-contract-types';
import {
  FIND_COPY,
  findMatches,
  findStatus,
  hasText,
  pageHighlights,
  stepMatch,
  type FindMatch,
} from './findModel';

export interface FindDoc {
  readonly docKey: string;
  /** Loads the document's text layer; null when the document has none to offer yet. */
  readonly load: (() => Promise<TextLayer>) | null;
}

export interface FindState {
  readonly open: boolean;
  readonly query: string;
  readonly matches: readonly FindMatch[];
  readonly index: number;
  readonly status: string;
  readonly current: FindMatch | null;
  show(): void;
  close(): void;
  setQuery(q: string): void;
  next(): FindMatch | null;
  prev(): FindMatch | null;
  highlights(docKey: string, page: number): ReturnType<typeof pageHighlights>;
}

export function useFind(docs: readonly FindDoc[]): FindState {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [index, setIndex] = useState(0);
  const [layers, setLayers] = useState<Record<string, TextLayer | 'failed' | 'loading'>>({});
  const requested = useRef(new Set<string>());

  const load = useCallback(() => {
    for (const d of docs) {
      if (!d.load || requested.current.has(d.docKey)) continue;
      requested.current.add(d.docKey);
      setLayers((m) => ({ ...m, [d.docKey]: 'loading' }));
      d.load().then(
        (l) => setLayers((m) => ({ ...m, [d.docKey]: l })),
        () => {
          requested.current.delete(d.docKey);
          setLayers((m) => ({ ...m, [d.docKey]: 'failed' }));
        },
      );
    }
  }, [docs]);

  const ready = useMemo(
    () =>
      docs.map((d) => {
        const l = layers[d.docKey];
        return { docKey: d.docKey, layer: l && typeof l === 'object' ? l : null };
      }),
    [docs, layers],
  );
  const loading = docs.some((d) => layers[d.docKey] === 'loading');
  const failed = docs.some((d) => layers[d.docKey] === 'failed');
  const matches = useMemo(() => findMatches(ready, query), [ready, query]);
  const searchable = hasText(ready.map((r) => r.layer));
  const safeIndex = matches.length ? Math.min(index, matches.length - 1) : 0;
  const status = loading
    ? FIND_COPY.loading
    : !searchable && failed
      ? FIND_COPY.failed
      : findStatus({ query, matches, index: safeIndex, searchable });

  return {
    open,
    query,
    matches,
    index: safeIndex,
    status,
    current: matches[safeIndex] ?? null,
    show() {
      setOpen(true);
      load();
    },
    close() {
      setOpen(false);
      setQueryState('');
      setIndex(0);
    },
    setQuery(q) {
      setQueryState(q);
      setIndex(0);
    },
    next() {
      const i = stepMatch(safeIndex, matches.length, 1);
      setIndex(i);
      return matches[i] ?? null;
    },
    prev() {
      const i = stepMatch(safeIndex, matches.length, -1);
      setIndex(i);
      return matches[i] ?? null;
    },
    highlights(docKey, page) {
      return open ? pageHighlights(matches, safeIndex, docKey, page) : [];
    },
  };
}
