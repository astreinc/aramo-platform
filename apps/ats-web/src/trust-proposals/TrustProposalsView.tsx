import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasScope, InlineAlert, useSession, type Session } from '@aramo/fe-foundation';

import { Card, FilterChip, PageHeader, StatusPill, Tag, Toolbar } from '../ui';
import { ContradictionResolveDialog } from '../talent/components/ContradictionResolveDialog';
import { requestEmailVerification } from '../talent/talent-api';

import { getProposals, markProposalActed } from './trust-proposals-api';
import { ProposalDismissDialog } from './ProposalDismissDialog';
import { proposalListErrorMessage, verifyActErrorState } from './error-messages';
import type { ProposalKind, ProposalListItem, ProposalStatus } from './types';

// Worklist tabs, canonical order. OPEN is the queue a recruiter works; the rest
// are terminal browse tabs.
const STATUS_TABS: readonly { key: ProposalStatus; label: string }[] = [
  { key: 'OPEN', label: 'Open' },
  { key: 'ACTED', label: 'Acted' },
  { key: 'DISMISSED', label: 'Dismissed' },
  { key: 'SETTLED', label: 'Settled' },
];

const STATUS_TONE: Record<ProposalStatus, 'ok' | 'neutral' | 'warn' | 'info'> = {
  OPEN: 'info',
  ACTED: 'ok',
  DISMISSED: 'neutral',
  SETTLED: 'neutral',
};
const STATUS_LABEL: Record<ProposalStatus, string> = {
  OPEN: 'Open',
  ACTED: 'Acted',
  DISMISSED: 'Dismissed',
  SETTLED: 'Settled',
};

// Kind + trigger → reader labels (words, never numbers — R10).
const KIND_LABEL: Record<ProposalKind, string> = {
  VERIFY_CONTACT: 'Verify contact',
  RENEW_VERIFICATION: 'Renew verification',
  RESOLVE_CONTRADICTION: 'Resolve contradiction',
};
const TRIGGER_LABEL: Record<string, string> = {
  SINGLE_SOURCE_ONLY: 'Single source',
  VERIFIED_CONTROL_STALE: 'Verification stale',
  OPEN_CONTRADICTION: 'Open contradiction',
};

const COL_COUNT = 6; // kind · record · basis kinds · trigger · created · action
const VERIFY_KINDS = new Set<ProposalKind>(['VERIFY_CONTACT', 'RENEW_VERIFICATION']);

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
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

interface TrustProposalsViewProps {
  /** Test seam — replaces the useSession() read (mirrors the sibling views). */
  readonly sessionOverride?: Session;
}

// TrustProposalsView — TR-12 B2. The caseworker's worklist: rows the deterministic
// policy engine minted, each pointing at one existing gated action. Status tabs
// across the lifecycle; a keyset "Load more" queue per tab (the IdentityAdvisories
// pattern). Per OPEN row, scope-gated by the action's OWN scope: RESOLVE opens the
// existing contradiction dialog (identity:resolve); VERIFY/RENEW one-clicks the
// existing request endpoint when its email slot resolved (talent:edit) — the
// consent 403 renders as the row's "Consent required" state, a fact not an error;
// a PHONE / unresolved slot deep-links to the record instead. Marking a row acted
// or dismissing it is queue participation (talent:read). R10: kinds + words only.
export function TrustProposalsView({ sessionOverride }: TrustProposalsViewProps = {}) {
  const sessionState = useSession();
  const session =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canVerify = session !== null && hasScope(session, 'talent:edit');
  const canResolve = session !== null && hasScope(session, 'identity:resolve');

  const [status, setStatus] = useState<ProposalStatus>('OPEN');
  const [items, setItems] = useState<readonly ProposalListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appendNote, setAppendNote] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<ProposalListItem | null>(null);
  const [dismissTarget, setDismissTarget] = useState<string | null>(null);
  // Per-row ACT refusal (verify/renew): 'consent_required' (a fact) or 'error'.
  const [refusal, setRefusal] = useState<Record<string, 'consent_required' | 'error'>>({});

  const fetchPage = useCallback(
    async (nextStatus: ProposalStatus, cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const res = await getProposals({
          status: nextStatus,
          ...(cursor !== null ? { cursor } : {}),
        });
        setItems((prev) => (append ? [...prev, ...res.items] : [...res.items]));
        setNextCursor(res.next_cursor);
        setError(null);
        if (append) setAppendNote(`Loaded ${res.items.length} more.`);
      } catch (err) {
        if (!append) setItems([]);
        setError(proposalListErrorMessage(err));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetchPage(status, null, false);
  }, [fetchPage, status]);

  const selectTab = (next: ProposalStatus) => {
    if (next === status) return;
    setNextCursor(null);
    setAppendNote(null);
    setRefusal({});
    setStatus(next);
  };

  const loadMore = () => {
    if (nextCursor !== null) void fetchPage(status, nextCursor, true);
  };

  const refetch = () => void fetchPage(status, null, false);

  // VERIFY/RENEW one-click → fire the EXISTING request endpoint, then mark-acted.
  // A consent 403 becomes the row's refusal state; the row stays OPEN.
  const onVerify = async (it: ProposalListItem) => {
    if (it.record_id === undefined || it.slot === undefined) return;
    setRefusal((p) => {
      if (!(it.id in p)) return p;
      const next = { ...p };
      delete next[it.id];
      return next;
    });
    try {
      await requestEmailVerification(it.record_id, it.slot);
      await markProposalActed(it.id);
      refetch();
    } catch (err) {
      setRefusal((p) => ({ ...p, [it.id]: verifyActErrorState(err) }));
    }
  };

  const onResolved = () => {
    const t = resolveTarget;
    setResolveTarget(null);
    if (t !== null) {
      void markProposalActed(t.id).finally(() => refetch());
    }
  };

  const renderAction = (it: ProposalListItem) => {
    if (it.status !== 'OPEN') {
      return (
        <StatusPill tone={STATUS_TONE[it.status]} dot={false}>
          {STATUS_LABEL[it.status]}
        </StatusPill>
      );
    }
    const dismissBtn = (
      <button
        type="button"
        className="tc-button tc-button--ghost"
        onClick={() => setDismissTarget(it.id)}
      >
        Dismiss
      </button>
    );

    // The consent refusal — a fact about the row, not an error toast.
    if (refusal[it.id] === 'consent_required') {
      return (
        <div className="rc-rowq">
          <StatusPill tone="warn">Consent required</StatusPill>
          {dismissBtn}
        </div>
      );
    }

    if (it.kind === 'RESOLVE_CONTRADICTION') {
      return (
        <div className="rc-rowq">
          {canResolve ? (
            <button
              type="button"
              className="tc-button"
              onClick={() => setResolveTarget(it)}
            >
              Resolve
            </button>
          ) : null}
          {dismissBtn}
        </div>
      );
    }

    if (VERIFY_KINDS.has(it.kind)) {
      const oneClick = it.slot !== undefined && canVerify;
      return (
        <div className="rc-rowq">
          {oneClick ? (
            <button type="button" className="tc-button" onClick={() => void onVerify(it)}>
              Verify
            </button>
          ) : it.record_id !== undefined ? (
            <Link className="tc-button tc-button--ghost" to={`/talent/${it.record_id}`}>
              Open record to verify
            </Link>
          ) : null}
          {refusal[it.id] === 'error' ? (
            <span className="rc-inline-error">Couldn’t send — try again.</span>
          ) : null}
          {dismissBtn}
        </div>
      );
    }
    return dismissBtn;
  };

  return (
    <section className="rc-view rc-trust-proposals">
      <PageHeader
        title="Trust Proposals"
        description="What deserves attention next across your talent — each proposal is one click into an action you already have."
      />

      <Toolbar>
        {STATUS_TABS.map((t) => (
          <FilterChip key={t.key} active={status === t.key} onClick={() => selectTab(t.key)}>
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
          <p className="rc-empty">Loading proposals…</p>
        ) : (
          <div className="rc-tablewrap">
            <table className="rc-table rc-table--comfortable rc-proposals-table">
              <thead>
                <tr>
                  <th scope="col">Proposal</th>
                  <th scope="col">Record</th>
                  <th scope="col">Basis</th>
                  <th scope="col">Trigger</th>
                  <th scope="col">Created</th>
                  <th scope="col" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td className="rc-table__empty" colSpan={COL_COUNT}>
                      No proposals in this tab.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => (
                    <tr key={it.id}>
                      <td>{KIND_LABEL[it.kind]}</td>
                      <td>
                        {it.record_id !== undefined ? (
                          <Link className="mono" to={`/talent/${it.record_id}`}>
                            {shortId(it.record_id)}
                          </Link>
                        ) : (
                          <span className="rc-muted-line mono">{shortId(it.subject_id)}</span>
                        )}
                      </td>
                      <td>
                        <span className="rc-tags">
                          {it.basis_kinds.map((k) => (
                            <Tag key={k}>{k}</Tag>
                          ))}
                        </span>
                      </td>
                      <td>{TRIGGER_LABEL[it.trigger_kind] ?? it.trigger_kind}</td>
                      <td>
                        <span className="rc-advisory-when mono">{formatWhen(it.created_at)}</span>
                      </td>
                      <td>{renderAction(it)}</td>
                    </tr>
                  ))
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

      <ContradictionResolveDialog
        item={
          resolveTarget !== null
            ? {
                evidence_id: resolveTarget.basis_ref_id,
                dimension: '',
                assertion_type: resolveTarget.basis_kinds[0] ?? '',
                reason: null,
                contradicting_evidence_id: null,
                assertion_payload: null,
              }
            : null
        }
        onClose={() => setResolveTarget(null)}
        onResolved={onResolved}
      />
      <ProposalDismissDialog
        proposalId={dismissTarget}
        onClose={() => setDismissTarget(null)}
        onDismissed={refetch}
      />
    </section>
  );
}
