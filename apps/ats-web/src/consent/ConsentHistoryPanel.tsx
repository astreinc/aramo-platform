// Consent history panel — PR-9 §4.1 / §4.3 (restyled to Confident Blue).
//
// Displays GET /v1/consent/history/:talent_id event ledger verbatim,
// with opaque-cursor pagination (PR-9 §4.3):
//   - Initial load: no cursor
//   - "Load more": fetch next page with next_cursor passed back verbatim
//   - When next_cursor is null/absent: hide the affordance
//
// Faithful-display discipline (PR-9 §7):
//   - Events are shown in the server's order; no client-side merge,
//     dedupe, or summarization
//   - No "consent history summary" widening (R5 mitigation)
//   - is_anonymized:true ⇒ neutral anonymized state (PR-9 §4.4)

import { ApiError } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  CardHead,
  DataTable,
  StatusPill,
  type PillTone,
  type TableColumn,
} from '../ui';

import { getTalentConsentHistory } from './consent-api';
import type {
  ConsentDecisionAction,
  ConsentHistoryEvent,
  ConsentHistoryResponse,
} from './types';

interface ConsentHistoryPanelProps {
  talentId: string;
}

type LoadState =
  | { status: 'loading' }
  | {
      status: 'loaded';
      events: ConsentHistoryEvent[];
      nextCursor: string | null;
      isAnonymized: boolean;
      fetchingMore: boolean;
    }
  | { status: 'error'; statusCode: number | null };

const ACTION_TONE: Record<ConsentDecisionAction, PillTone> = {
  granted: 'ok',
  revoked: 'danger',
  expired: 'warn',
};

const EVENT_COLUMNS: ReadonlyArray<TableColumn<ConsentHistoryEvent>> = [
  {
    key: 'event_id',
    header: 'Event',
    render: (e) => (
      <span data-testid={`consent-history-event-${e.event_id}`}>
        {e.event_id}
      </span>
    ),
  },
  { key: 'scope', header: 'Scope', render: (e) => e.scope },
  {
    key: 'action',
    header: 'Action',
    render: (e) => <StatusPill tone={ACTION_TONE[e.action]}>{e.action}</StatusPill>,
  },
  { key: 'created_at', header: 'Created at', render: (e) => e.created_at },
  { key: 'expires_at', header: 'Expires at', render: (e) => e.expires_at ?? '—' },
];

export function ConsentHistoryPanel({ talentId }: ConsentHistoryPanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getTalentConsentHistory(talentId)
      .then((data: ConsentHistoryResponse) => {
        if (cancelled) return;
        setState({
          status: 'loaded',
          events: data.events,
          nextCursor: data.next_cursor,
          isAnonymized: data.is_anonymized,
          fetchingMore: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const code = err instanceof ApiError ? err.status : null;
        setState({ status: 'error', statusCode: code });
      });
    return () => {
      cancelled = true;
    };
  }, [talentId]);

  const handleLoadMore = async () => {
    if (state.status !== 'loaded' || state.nextCursor === null) {
      return;
    }
    const cursor = state.nextCursor;
    setState({ ...state, fetchingMore: true });
    try {
      const data = await getTalentConsentHistory(talentId, cursor);
      setState((prev) => {
        if (prev.status !== 'loaded') return prev;
        return {
          status: 'loaded',
          events: [...prev.events, ...data.events],
          nextCursor: data.next_cursor,
          isAnonymized: data.is_anonymized,
          fetchingMore: false,
        };
      });
    } catch (err: unknown) {
      const code = err instanceof ApiError ? err.status : null;
      setState({ status: 'error', statusCode: code });
    }
  };

  if (state.status === 'loading') {
    return (
      <section data-testid="consent-history-panel">
        <Card>
          <CardHead title="Consent history" />
          <p className="rc-muted-line rc-mt-8">Loading consent history…</p>
        </Card>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section data-testid="consent-history-panel">
        <Card>
          <CardHead title="Consent history" />
          <p className="rc-muted-line rc-mt-8">
            Consent history could not be loaded for talent {talentId}.
          </p>
        </Card>
      </section>
    );
  }

  if (state.isAnonymized) {
    return (
      <section data-testid="consent-history-panel">
        <Card>
          <CardHead title="Consent history" />
          <p
            className="rc-muted-line rc-mt-8"
            data-testid="consent-history-anonymized"
          >
            This talent record has been anonymized.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section data-testid="consent-history-panel">
      <Card>
        <CardHead title="Consent history" />
        <div className="rc-mt-8">
          <DataTable
            columns={EVENT_COLUMNS}
            rows={state.events}
            rowKey={(e) => e.event_id}
            emptyMessage={
              <span data-testid="consent-history-empty">
                No consent events recorded.
              </span>
            }
          />
        </div>
        {state.nextCursor !== null ? (
          <div className="rc-mt-8">
            <Button
              variant="secondary"
              size="sm"
              data-testid="consent-history-load-more"
              onClick={handleLoadMore}
              disabled={state.fetchingMore}
            >
              {state.fetchingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
