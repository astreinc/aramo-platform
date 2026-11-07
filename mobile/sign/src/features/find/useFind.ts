// M-A12 W1-C.2 — Find state for an open set of documents. Text layers load lazily the
// first time Find opens, are held in component memory only, and are dropped with it.
import { useCallback, useMemo, useRef, useState } from 'react';

import type { TextLayer } from '../../api/m-a12-contract-types';
import {
  FIND_COPY,
  findListStatus,
  findMatches,
  findStatus,
  hasText,
  pageHighlights,
  matchSnippet,
  stepMatch,
  type FindMatch,
  type MatchSnippet,
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
  /** M-A14 — the Find in Document sheet's line ("N matches · highlighted on the page"). */
  readonly listStatus: string;
  readonly current: FindMatch | null;
  show(): void;
  close(): void;
  /** M-A14 — close the sheet but keep the matches highlighted (a match was picked). */
  hide(): void;
  setQuery(q: string): void;
  next(): FindMatch | null;
  prev(): FindMatch | null;
  highlights(docKey: string, page: number): ReturnType<typeof pageHighlights>;
  /** M-A14 — the text around a match, for the list of matches by page. */
  snippet(m: FindMatch): MatchSnippet | null;
}

export function useFind(docs: readonly FindDoc[]): FindState {
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState(false);
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

  const listStatus = loading
    ? FIND_COPY.loading
    : !searchable && failed
      ? FIND_COPY.failed
      : findListStatus({ query, matches, searchable });

  return {
    open,
    query,
    matches,
    index: safeIndex,
    status,
    listStatus,
    current: matches[safeIndex] ?? null,
    show() {
      setOpen(true);
      load();
    },
    close() {
      setOpen(false);
      setKept(false);
      setQueryState('');
      setIndex(0);
    },
    hide() {
      setOpen(false);
      setKept(true);
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
      return open || kept ? pageHighlights(matches, safeIndex, docKey, page) : [];
    },
    snippet(m) {
      if (m.word === undefined || m.count === undefined) return null;
      const layer = ready.find((r) => r.docKey === m.docKey)?.layer;
      const page = layer?.pages.find((p) => p.page === m.page + 1);
      return page ? matchSnippet(page.words, m.word, m.count) : null;
    },
  };
}
