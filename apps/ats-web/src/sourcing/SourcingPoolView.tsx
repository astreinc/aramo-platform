import { useCallback, useEffect, useRef, useState } from 'react';
import { hasScope, InlineAlert, useSession, type Session } from '@aramo/fe-foundation';

import { Avatar, BandPill, Card, Icons, StatusPill } from '../ui';

import { SourcingSubjectDrawer } from './components/SourcingSubjectDrawer';
import { getPool } from './sourcing-api';
import { poolErrorMessage } from './error-messages';
import type { PoolItem } from './types';

// The 4 trust dimensions, canonical order — one BandPill column each.
const DIMENSIONS = [
  { key: 'identity', label: 'Identity' },
  { key: 'claims', label: 'Claims' },
  { key: 'continuity', label: 'Continuity' },
  { key: 'eligibility', label: 'Eligibility' },
] as const;

const COL_COUNT = 2 + DIMENSIONS.length + 2; // subject + 4 bands + review + open

// SourcingPoolView — the un-promoted sourcing pool (talent:source). A keyset
// "Load more" queue (forked from TalentListView's paging shape): each row shows
// the subject's name/email, the 4 trust BandPills, and an open-contradiction
// indicator; Open drills into the subject drawer where identity is settled and
// promotion happens (detail-gated). Route-gated on talent:source; the advisory-
// resolve actions inside the drawer are separately gated on identity:resolve.
interface SourcingPoolViewProps {
  /** Test seam — replaces the useSession() read (mirrors the sibling views). */
  readonly sessionOverride?: Session;
}

export function SourcingPoolView({ sessionOverride }: SourcingPoolViewProps = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canResolve = session !== null && hasScope(session, 'identity:resolve');

  const [items, setItems] = useState<readonly PoolItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appendNote, setAppendNote] = useState<string | null>(null);
  const [drawerIndex, setDrawerIndex] = useState<number | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);

  const fetchPage = useCallback(async (cursor: string | null, append: boolean) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const res = await getPool(cursor !== null ? { cursor } : {});
      setItems((prev) => (append ? [...prev, ...res.items] : [...res.items]));
      setNextCursor(res.next_cursor);
      setError(null);
      if (append) setAppendNote(`Loaded ${res.items.length} more.`);
    } catch (err) {
      if (!append) setItems([]);
      setError(poolErrorMessage(err));
    } finally {
      if (append) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPage(null, false);
  }, [fetchPage]);

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(nextCursor, true);
  };

  // A promote removes the subject from the pool — close the drawer and re-read
  // the first page so the queue reflects the change.
  const onPromoted = () => {
    setDrawerIndex(null);
    void fetchPage(null, false);
  };

  const drawerItem = drawerIndex !== null ? (items[drawerIndex] ?? null) : null;

  return (
    <section className="rc-view rc-sourcing">
      <div className="rc-viewhead">
        <div>
          <h1>Sourcing</h1>
          <p className="rc-viewhead__sub">
            The pre-promotion pool — settle identity, then promote to a pipeline or
            your talent pool.
          </p>
        </div>
      </div>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <p role="status" className="rc-visually-hidden">
        {appendNote ?? ''}
      </p>

      <Card flush>
        {loading ? (
          <p className="rc-empty">Loading the sourcing pool…</p>
        ) : (
          <div className="rc-tablewrap">
            <table className="rc-table rc-table--comfortable rc-sourcing-table">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  {DIMENSIONS.map((d) => (
                    <th scope="col" key={d.key}>
                      {d.label}
                    </th>
                  ))}
                  <th scope="col">Review</th>
                  <th scope="col" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td className="rc-table__empty" colSpan={COL_COUNT}>
                      No talent in the sourcing pool yet.
                    </td>
                  </tr>
                ) : (
                  items.map((it, i) => {
                    const name = it.display_name ?? it.email ?? 'Unnamed subject';
                    return (
                      <tr
                        key={it.subject_id}
                        className={`rc-row--clickable${drawerIndex === i ? ' rc-row--active' : ''}`}
                        onClick={(e) => {
                          if (
                            e.target instanceof Element &&
                            e.target.closest('a,button,input,label')
                          )
                            return;
                          setDrawerIndex(i);
                        }}
                      >
                        <td>
                          <span className="rc-ent">
                            <Avatar name={name} size="sm" />
                            <span>
                              <span className="rc-ent__nm">{name}</span>
                              {it.email !== null ? (
                                <span className="rc-ent__rl mono">{it.email}</span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        {DIMENSIONS.map((d) => (
                          <td key={d.key}>
                            <BandPill band={it.trust_bands[d.key]} />
                          </td>
                        ))}
                        <td>
                          {it.open_contradiction_count > 0 ? (
                            <StatusPill tone="warn" dot>
                              {it.open_contradiction_count} to review
                            </StatusPill>
                          ) : (
                            <span className="rc-consent-stub">—</span>
                          )}
                        </td>
                        <td>
                          <div className="rc-rowq">
                            <button
                              type="button"
                              aria-label={`Open ${name}`}
                              onClick={() => setDrawerIndex(i)}
                            >
                              <Icons.IconOpen />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {nextCursor !== null ? (
              <div className="rc-loadmore">
                <button
                  ref={loadMoreRef}
                  type="button"
                  className="tc-button tc-button--ghost"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <SourcingSubjectDrawer
        item={drawerItem}
        index={drawerIndex ?? 0}
        total={items.length}
        canResolve={canResolve}
        onClose={() => setDrawerIndex(null)}
        onPrev={() => setDrawerIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
        onNext={() =>
          setDrawerIndex((i) => (i === null ? null : Math.min(items.length - 1, i + 1)))
        }
        onPromoted={onPromoted}
      />
    </section>
  );
}
