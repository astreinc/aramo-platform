import { useCallback, useEffect, useState } from 'react';
import { hasScope, InlineAlert, useSession, type Session, Button } from '@aramo/fe-foundation';

import { Card, FilterChip, PageHeader, StatusPill, Tag, Toolbar } from '../ui';
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
  { key: 'APPROVED', label: 'Approved' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'REVERSED', label: 'Reversed' },
];

// Terminal-status → StatusPill tone, for the read-only history tabs. Merged is a
// settled positive; dismissed is neutral; reversed is a warn (an undone merge).
const STATUS_TONE: Record<AdvisoryStatus, 'ok' | 'neutral' | 'warn' | 'info'> = {
  PENDING_REVIEW: 'info',
  APPROVED: 'ok',
  DISMISSED: 'neutral',
  REVERSED: 'warn',
};
const STATUS_LABEL: Record<AdvisoryStatus, string> = {
  PENDING_REVIEW: 'Pending review',
  APPROVED: 'Approved',
  DISMISSED: 'Dismissed',
  REVERSED: 'Reversed',
};

const COL_COUNT = 5; // pair · basis · shared kinds · created · action

// Short-form a UUID for the pair cell when no name is available.
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function sideA(it: AdvisoryListItem): string {
  return it.talent_record_a_name ?? shortId(it.talent_record_a_id);
}

function sideB(it: AdvisoryListItem): string {
  if (it.sourced_talent_id !== null) {
    return `${it.sourced_talent_name ?? shortId(it.sourced_talent_id)} (sourced)`;
  }
  return it.talent_record_b_name ?? (it.talent_record_b_id !== null ? shortId(it.talent_record_b_id) : '—');
}

const BASIS_LABEL: Record<string, string> = {
  EMAIL: 'Shared email',
  PHONE: 'Shared cell phone',
  SOURCED_ARRIVAL: 'Sourced arrival',
};

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

// IdentityAdvisoriesView — the reviewer worklist for within-tenant duplicate
// advisories (identity:resolve; the route is scope-gated). ATI-SEP-1 T10 WP2:
// the advisories are ATS-local (two talent records, or a sourced arrival and a
// talent record, sharing a normalized email / cell phone). Status tabs across the
// review lifecycle; a keyset "Load more" queue per tab. Each row shows the pair
// (by name), the basis, the NAMED shared kinds and the created timestamp.
// Resolving reuses the shared AdvisoryResolveDialog (approve/dismiss). Labels
// only — never a number or a star.
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
        description="Review possible duplicate talent records and sourced arrivals in your tenant."
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
                  <th scope="col">Pair</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Shared</th>
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
                          <span className="rc-advisory-pair">
                            {sideA(it)} ↔ {sideB(it)}
                          </span>
                        </td>
                        <td>{BASIS_LABEL[it.basis] ?? it.basis}</td>
                        <td>
                          <span className="rc-tags">
                            {it.shared_anchor_kinds.length > 0 ? (
                              <Tag>{it.shared_anchor_kinds.join(', ')}</Tag>
                            ) : null}
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
                              <Button unstyled
                                type="button"
                                className="tc-button tc-button--ghost"
                                onClick={() => setTarget({ item: it, action: 'dismiss' })}
                              >
                                Dismiss
                              </Button>
                              <Button unstyled
                                type="button"
                                className="tc-button"
                                onClick={() => setTarget({ item: it, action: 'approve' })}
                              >
                                {it.basis === 'SOURCED_ARRIVAL' ? 'Same person' : 'Approve merge'}
                              </Button>
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
                <Button unstyled
                  type="button"
                  className="tc-button tc-button--ghost"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
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
                basis: target.item.basis,
                shared_kinds: target.item.shared_anchor_kinds,
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
