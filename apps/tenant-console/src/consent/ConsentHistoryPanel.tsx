// Consent history panel — PR-9 §4.1 / §4.3.
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

import { useEffect, useState } from 'react';

import { ApiError } from '../api/client';

import { getTalentConsentHistory } from './consent-api';
import type { ConsentHistoryEvent, ConsentHistoryResponse } from './types';

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
      <section
        className="aramo-consent-history"
        data-testid="consent-history-panel"
      >
        <h2>Consent history</h2>
        <p>Loading consent history…</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section
        className="aramo-consent-history"
        data-testid="consent-history-panel"
      >
        <h2>Consent history</h2>
        <p>Consent history could not be loaded for talent {talentId}.</p>
      </section>
    );
  }

  if (state.isAnonymized) {
    return (
      <section
        className="aramo-consent-history"
        data-testid="consent-history-panel"
      >
        <h2>Consent history</h2>
        <p data-testid="consent-history-anonymized">
          This talent record has been anonymized.
        </p>
      </section>
    );
  }

  return (
    <section
      className="aramo-consent-history"
      data-testid="consent-history-panel"
    >
      <h2>Consent history</h2>
      {state.events.length === 0 ? (
        <p data-testid="consent-history-empty">No consent events recorded.</p>
      ) : (
        <table className="aramo-consent-history__events">
          <thead>
            <tr>
              <th>Event</th>
              <th>Scope</th>
              <th>Action</th>
              <th>Created at</th>
              <th>Expires at</th>
            </tr>
          </thead>
          <tbody>
            {state.events.map((event) => (
              <tr
                key={event.event_id}
                data-testid={`consent-history-event-${event.event_id}`}
              >
                <td>{event.event_id}</td>
                <td>{event.scope}</td>
                <td>{event.action}</td>
                <td>{event.created_at}</td>
                <td>{event.expires_at ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.nextCursor !== null ? (
        <button
          type="button"
          className="aramo-consent-history__load-more"
          data-testid="consent-history-load-more"
          onClick={handleLoadMore}
          disabled={state.fetchingMore}
        >
          {state.fetchingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}
