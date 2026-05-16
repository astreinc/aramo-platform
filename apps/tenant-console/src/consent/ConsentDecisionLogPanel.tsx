// Consent decision-log panel — PR-9 §4.1 / §4.3.
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

import { useEffect, useState } from 'react';

import { ApiError } from '../api/client';

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
      <section
        className="aramo-consent-decision-log"
        data-testid="consent-decision-log-panel"
      >
        <h2>Consent decision log</h2>
        <p>Loading consent decision log…</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section
        className="aramo-consent-decision-log"
        data-testid="consent-decision-log-panel"
      >
        <h2>Consent decision log</h2>
        <p>
          Consent decision log could not be loaded for talent {talentId}.
        </p>
      </section>
    );
  }

  if (state.isAnonymized) {
    return (
      <section
        className="aramo-consent-decision-log"
        data-testid="consent-decision-log-panel"
      >
        <h2>Consent decision log</h2>
        <p data-testid="consent-decision-log-anonymized">
          This talent record has been anonymized.
        </p>
      </section>
    );
  }

  return (
    <section
      className="aramo-consent-decision-log"
      data-testid="consent-decision-log-panel"
    >
      <h2>Consent decision log</h2>
      {state.entries.length === 0 ? (
        <p data-testid="consent-decision-log-empty">
          No decision-log entries recorded.
        </p>
      ) : (
        <table className="aramo-consent-decision-log__entries">
          <thead>
            <tr>
              <th>Event</th>
              <th>Type</th>
              <th>Actor</th>
              <th>Created at</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry) => (
              <tr
                key={entry.event_id}
                data-testid={`consent-decision-log-entry-${entry.event_id}`}
              >
                <td>{entry.event_id}</td>
                <td>{entry.event_type}</td>
                <td>
                  {entry.actor_type}
                  {entry.actor_id ? ` (${entry.actor_id})` : ''}
                </td>
                <td>{entry.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {state.nextCursor !== null ? (
        <button
          type="button"
          className="aramo-consent-decision-log__load-more"
          data-testid="consent-decision-log-load-more"
          onClick={handleLoadMore}
          disabled={state.fetchingMore}
        >
          {state.fetchingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}
