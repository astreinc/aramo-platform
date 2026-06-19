// Consent decision-log panel — PR-9 §4.1 / §4.3 (restyled to Confident Blue).
//
// Displays GET /v1/consent/decision-log/:talent_id entries verbatim
// with opaque-cursor pagination (PR-9 §4.3). is_anonymized:true ⇒
// neutral anonymized state (PR-9 §4.4).
//
// Faithful-display discipline (PR-9 §7):
//   - Entries render the closed top-level fields the server returns;
//     event_payload is opaque JSON pass-through (per
//     ConsentDecisionLogEntry openapi schema). The directive forbids
//     extracting payload fields into top-level surfaces, so this panel
//     does not surface payload contents — it shows that a payload
//     exists and leaves it as-is.

import { ApiError } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import { Button, Card, CardHead, DataTable, type TableColumn } from '../ui';

import { getTalentConsentDecisionLog } from './consent-api';
import type {
  ConsentDecisionLogEntry,
  ConsentDecisionLogResponse,
} from './types';

interface ConsentDecisionLogPanelProps {
  talentId: string;
}

type LoadState =
  | { status: 'loading' }
  | {
      status: 'loaded';
      entries: ConsentDecisionLogEntry[];
      nextCursor: string | null;
      isAnonymized: boolean;
      fetchingMore: boolean;
    }
  | { status: 'error'; statusCode: number | null };

const ENTRY_COLUMNS: ReadonlyArray<TableColumn<ConsentDecisionLogEntry>> = [
  {
    key: 'event_id',
    header: 'Event',
    render: (entry) => (
      <span data-testid={`consent-decision-log-entry-${entry.event_id}`}>
        {entry.event_id}
      </span>
    ),
  },
  { key: 'event_type', header: 'Type', render: (entry) => entry.event_type },
  {
    key: 'actor',
    header: 'Actor',
    render: (entry) =>
      `${entry.actor_type}${entry.actor_id ? ` (${entry.actor_id})` : ''}`,
  },
  { key: 'created_at', header: 'Created at', render: (entry) => entry.created_at },
];

export function ConsentDecisionLogPanel({
  talentId,
}: ConsentDecisionLogPanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    getTalentConsentDecisionLog(talentId)
      .then((data: ConsentDecisionLogResponse) => {
        if (cancelled) return;
        setState({
          status: 'loaded',
          entries: data.entries,
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
      const data = await getTalentConsentDecisionLog(talentId, cursor);
      setState((prev) => {
        if (prev.status !== 'loaded') return prev;
        return {
          status: 'loaded',
          entries: [...prev.entries, ...data.entries],
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
      <section data-testid="consent-decision-log-panel">
        <Card>
          <CardHead title="Consent decision log" />
          <p className="rc-muted-line rc-mt-8">Loading consent decision log…</p>
        </Card>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section data-testid="consent-decision-log-panel">
        <Card>
          <CardHead title="Consent decision log" />
          <p className="rc-muted-line rc-mt-8">
            Consent decision log could not be loaded for talent {talentId}.
          </p>
        </Card>
      </section>
    );
  }

  if (state.isAnonymized) {
    return (
      <section data-testid="consent-decision-log-panel">
        <Card>
          <CardHead title="Consent decision log" />
          <p
            className="rc-muted-line rc-mt-8"
            data-testid="consent-decision-log-anonymized"
          >
            This talent record has been anonymized.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section data-testid="consent-decision-log-panel">
      <Card>
        <CardHead title="Consent decision log" />
        <div className="rc-mt-8">
          <DataTable
            columns={ENTRY_COLUMNS}
            rows={state.entries}
            rowKey={(entry) => entry.event_id}
            emptyMessage={
              <span data-testid="consent-decision-log-empty">
                No decision-log entries recorded.
              </span>
            }
          />
        </div>
        {state.nextCursor !== null ? (
          <div className="rc-mt-8">
            <Button
              variant="secondary"
              size="sm"
              data-testid="consent-decision-log-load-more"
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
