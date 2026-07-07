import { useCallback, useEffect, useState } from 'react';
import { hasScope, InlineAlert, useSession, type Session } from '@aramo/fe-foundation';

import { BandPill, Card, FilterChip, PageHeader, StatusPill, Tag, Toolbar } from '../ui';
import {
  AdvisoryResolveDialog,
  type AdvisoryAction,
} from '../sourcing/components/AdvisoryResolveDialog';

import { getAdvisories } from './identity-advisories-api';
import { advisoryListErrorMessage } from './error-messages';
import type { AdvisoryListItem, AdvisoryStatus } from './types';

// The status worklist tabs, canonical order. PENDING_REVIEW is the default queue
// a reviewer works; the rest are browse-only history. Switching a tab refetches
// from cursor=none.
const STATUS_TABS: readonly { key: AdvisoryStatus; label: string }[] = [
  { key: 'PENDING_REVIEW', label: 'Pending review' },
  { key: 'MERGED', label: 'Merged' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'REVERSED', label: 'Reversed' },
];

// Terminal-status → StatusPill tone, for the read-only history tabs. Merged is a
// settled positive; dismissed is neutral; reversed is a warn (an undone merge).
const STATUS_TONE: Record<AdvisoryStatus, 'ok' | 'neutral' | 'warn' | 'info'> = {
  PENDING_REVIEW: 'info',
  MERGED: 'ok',
  DISMISSED: 'neutral',
  REVERSED: 'warn',
};
const STATUS_LABEL: Record<AdvisoryStatus, string> = {
  PENDING_REVIEW: 'Pending review',
  MERGED: 'Merged',
  DISMISSED: 'Dismissed',
  REVERSED: 'Reversed',
};

const COL_COUNT = 6; // pair · band · contradiction · named kinds · created · action

// Named-kind chip groups, in reading order. Each renders only when its array is
// non-empty (R10 — named anchor KINDS, never a number or a star).
function kindGroups(it: AdvisoryListItem): readonly { label: string; kinds: readonly string[] }[] {
  return [
    { label: 'Shares', kinds: it.shared_anchor_kinds },
    { label: 'Confirmed', kinds: it.confirmed_kinds },
    { label: 'Contradicts', kinds: it.contradiction_kinds },
    { label: 'Conflict', kinds: it.corroborator_conflict_kinds },
  ].filter((g) => g.kinds.length > 0);
}

// Short-form a subject UUID for the mono pair cell (full id is on the wire; the
// reviewer only needs a stable glance-token).
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

// ISO → readable local timestamp, rendered in the mono column. Falls back to the
// raw string if the date can't be parsed (never throws in a cell).
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface IdentityAdvisoriesViewProps {
  /** Test seam — replaces the useSession() read (mirrors the sibling views). */
  readonly sessionOverride?: Session;
}

// IdentityAdvisoriesView — TR-6 B2. The reviewer worklist for same-human MERGE
// advisories (identity:resolve; the route is scope-gated, so the holder is
// assumed). Status tabs across the review lifecycle; a keyset "Load more" queue
// per tab (forked from SourcingPoolView's paging shape). Each pending row shows
// the advise BandPill, a contradiction flag, the NAMED anchor kinds (shared /
// confirmed / contradicting / conflicting), a reopen-provenance marker, and mono
// timestamps + subject ids. Resolving reuses the shared AdvisoryResolveDialog
// (approve/dismiss), now enriched with the named-kinds summary. R10: bands +
// labels only — never a number or a star.
export function IdentityAdvisoriesView({ sessionOverride }: IdentityAdvisoriesViewProps = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canResolve = session !== null && hasScope(session, 'identity:resolve');

  const [status, setStatus] = useState<AdvisoryStatus>('PENDING_REVIEW');
  const [items, setItems] = useState<readonly AdvisoryListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appendNote, setAppendNote] = useState<string | null>(null);
  const [target, setTarget] = useState<
    { item: AdvisoryListItem; action: AdvisoryAction } | null
  >(null);

  const fetchPage = useCallback(
    async (nextStatus: AdvisoryStatus, cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await getAdvisories({
          status: nextStatus,
          ...(cursor !== null ? { cursor } : {}),
        });
        setItems((prev) => (append ? [...prev, ...res.items] : [...res.items]));
        setNextCursor(res.next_cursor);
        setError(null);
        if (append) setAppendNote(`Loaded ${res.items.length} more.`);
      } catch (err) {
        if (!append) setItems([]);
        setError(advisoryListErrorMessage(err));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [],
  );

  // First page on mount + whenever the tab changes (from cursor=none).
  useEffect(() => {
    void fetchPage(status, null, false);
  }, [fetchPage, status]);

  const selectTab = (next: AdvisoryStatus) => {
    if (next === status) return;
    setNextCursor(null);
    setAppendNote(null);
    setStatus(next);
  };

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(status, nextCursor, true);
  };

  // A resolve removes the advisory from the pending queue — re-read the current
  // tab so the resolved row drops off.
  const onResolved = () => {
    setTarget(null);
    void fetchPage(status, null, false);
  };

  return (
    <section className="rc-view rc-identity-advisories">
      <PageHeader
        title="Identity Advisories"
        description="Review possible same-person matches across your talent."
      />

      <Toolbar>
        {STATUS_TABS.map((t) => (
          <FilterChip
            key={t.key}
            active={status === t.key}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </FilterChip>
        ))}
      </Toolbar>

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <p role="status" className="rc-visually-hidden">
        {appendNote ?? ''}
      </p>

      <Card flush>
        {loading ? (
          <p className="rc-empty">Loading advisories…</p>
        ) : (
          <div className="rc-tablewrap">
            <table className="rc-table rc-table--comfortable rc-advisories-table">
              <thead>
                <tr>
                  <th scope="col">Subject pair</th>
                  <th scope="col">Advise band</th>
                  <th scope="col">Contradiction flag</th>
                  <th scope="col">Named kinds</th>
                  <th scope="col">Created</th>
                  <th scope="col" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td className="rc-table__empty" colSpan={COL_COUNT}>
                      No advisories in this tab.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => {
                    const isPending = it.status === 'PENDING_REVIEW';
                    return (
                      <tr key={it.id}>
                        <td>
                          <span className="rc-advisory-pair mono">
                            {shortId(it.subject_a_id)} ↔ {shortId(it.subject_b_id)}
                          </span>
                          {it.reopened_at !== null ? (
                            <span className="rc-advisory-reopen">
                              <StatusPill tone="warn" dot>
                                Reopened
                                {it.reopened_from_band !== null
                                  ? ` from ${it.reopened_from_band}`
                                  : ''}
                              </StatusPill>
                              <span className="rc-advisory-when mono">
                                {formatWhen(it.reopened_at)}
                              </span>
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <BandPill band={it.advise_band} />
                        </td>
                        <td>
                          <StatusPill tone={it.has_contradiction ? 'danger' : 'info'}>
                            {it.has_contradiction ? 'Contradiction' : 'Clean'}
                          </StatusPill>
                        </td>
                        <td>
                          <span className="rc-tags">
                            {kindGroups(it).map((g) => (
                              <Tag key={g.label}>
                                {g.label}: {g.kinds.join(', ')}
                              </Tag>
                            ))}
                          </span>
                        </td>
                        <td>
                          <span className="rc-advisory-when mono">
                            {formatWhen(it.created_at)}
                          </span>
                        </td>
                        <td>
                          {isPending && canResolve ? (
                            <div className="rc-rowq">
                              <button
                                type="button"
                                className="tc-button tc-button--ghost"
                                onClick={() => setTarget({ item: it, action: 'dismiss' })}
                              >
                                Dismiss
                              </button>
                              <button
                                type="button"
                                className="tc-button"
                                onClick={() => setTarget({ item: it, action: 'approve' })}
                              >
                                Approve merge
                              </button>
                            </div>
                          ) : (
                            <StatusPill tone={STATUS_TONE[it.status]} dot={isPending}>
                              {STATUS_LABEL[it.status]}
                            </StatusPill>
                          )}
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

      <AdvisoryResolveDialog
        advisory={
          target !== null
            ? {
                id: target.item.id,
                has_contradiction: target.item.has_contradiction,
                kinds: {
                  shared_anchor_kinds: target.item.shared_anchor_kinds,
                  confirmed_kinds: target.item.confirmed_kinds,
                  contradiction_kinds: target.item.contradiction_kinds,
                  corroborator_conflict_kinds: target.item.corroborator_conflict_kinds,
                },
              }
            : null
        }
        action={target?.action ?? 'dismiss'}
        onClose={() => setTarget(null)}
        onResolved={onResolved}
      />
    </section>
  );
}
