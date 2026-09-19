import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useCursorPager, type CursorPage } from './CursorPager';

// SKILL-TAX-1F-C2 — the domain-neutral cursor paginator. Proves: first page loads on
// mount, loadMore appends the next page and echoes the opaque cursor verbatim, the
// stream ends when next_cursor is null, and a resetKey change restarts from page one.
describe('useCursorPager', () => {
  it('accumulates pages, passes the opaque cursor back, and ends at next_cursor=null', async () => {
    const seen: Array<string | null> = [];
    const fetchPage = vi.fn(async (cursor: string | null): Promise<CursorPage<number>> => {
      seen.push(cursor);
      if (cursor === null) return { items: [1, 2], next_cursor: 'opaque-cursor-1' };
      return { items: [3], next_cursor: null };
    });

    const { result } = renderHook(() => useCursorPager(fetchPage, 'k1'));

    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual([1, 2, 3]));
    expect(result.current.hasMore).toBe(false);

    // The cursor is echoed back verbatim — never decoded/derived.
    expect(seen).toEqual([null, 'opaque-cursor-1']);
  });

  it('restarts from the first page when resetKey changes', async () => {
    const fetchPage = vi.fn(async (cursor: string | null): Promise<CursorPage<string>> => {
      return { items: [cursor === null ? 'first' : 'more'], next_cursor: cursor === null ? 'c' : null };
    });

    const { result, rerender } = renderHook(({ k }: { k: string }) => useCursorPager(fetchPage, k), {
      initialProps: { k: 'k1' },
    });
    await waitFor(() => expect(result.current.items).toEqual(['first']));

    rerender({ k: 'k2' });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    // After reset, items reflect a fresh first page (not appended to the old one).
    expect(result.current.items).toEqual(['first']);
  });

  it('surfaces a fetch error and stops paging', async () => {
    const fetchPage = vi.fn(async (): Promise<CursorPage<number>> => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useCursorPager(fetchPage, 'k1'));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.hasMore).toBe(false);
  });
});
