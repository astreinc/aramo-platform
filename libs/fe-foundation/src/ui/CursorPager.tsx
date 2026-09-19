import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../components';

// A domain-neutral keyset/cursor paginator (SKILL-TAX-1F-C2). fe-foundation carries
// no domain knowledge: the hook accepts a page-fetcher that returns an opaque
// `next_cursor` string and accumulates items across pages. The cursor is a black box
// — this primitive NEVER decodes or interprets it; it only echoes it back to the
// fetcher. When `resetKey` changes (e.g. the consumer's filter set), the accumulation
// restarts from the first page. A monotonic request token guards against out-of-order
// responses when filters change mid-flight.

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface CursorPagerState<T> {
  readonly items: readonly T[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  /** Load the next page (no-op while loading or when there is no more). */
  readonly loadMore: () => void;
  /** Re-fetch from the first page under the current resetKey. */
  readonly reload: () => void;
}

export function useCursorPager<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
  resetKey: string,
): CursorPagerState<T> {
  const [items, setItems] = useState<readonly T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;

  const run = useCallback(async (nextCursor: string | null, token: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPageRef.current(nextCursor);
      if (tokenRef.current !== token) return; // a newer resetKey/reload superseded us
      setItems((prev) => (nextCursor === null ? [...page.items] : [...prev, ...page.items]));
      setCursor(page.next_cursor);
      setHasMore(page.next_cursor !== null);
    } catch (e) {
      if (tokenRef.current !== token) return;
      setError(e instanceof Error ? e.message : 'Failed to load.');
      setHasMore(false);
    } finally {
      if (tokenRef.current === token) setLoading(false);
    }
  }, []);

  // Reset + first page whenever the filter fingerprint changes.
  useEffect(() => {
    const token = (tokenRef.current += 1);
    setItems([]);
    setCursor(null);
    setHasMore(true);
    void run(null, token);
  }, [resetKey, run]);

  const loadMore = useCallback(() => {
    if (loading || !hasMore || cursor === null) return;
    void run(cursor, tokenRef.current);
  }, [loading, hasMore, cursor, run]);

  const reload = useCallback(() => {
    const token = (tokenRef.current += 1);
    setItems([]);
    setCursor(null);
    setHasMore(true);
    void run(null, token);
  }, [run]);

  return { items, loading, error, hasMore, loadMore, reload };
}

// The paired button primitive: renders a "Load more" affordance while more pages
// exist, and a terminal marker once the stream is exhausted.
export function CursorLoadMore({
  hasMore,
  loading,
  onLoadMore,
  endLabel = 'End of results.',
}: {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadMore: () => void;
  readonly endLabel?: string;
}) {
  if (!hasMore) {
    return (
      <div role="status" style={{ padding: '10px 0', color: 'var(--rc-fg-muted, #667085)', fontSize: '0.85rem' }}>
        {endLabel}
      </div>
    );
  }
  return (
    <div style={{ padding: '10px 0', display: 'flex', justifyContent: 'center' }}>
      <Button variant="secondary" onClick={onLoadMore} disabled={loading}>
        {loading ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}
