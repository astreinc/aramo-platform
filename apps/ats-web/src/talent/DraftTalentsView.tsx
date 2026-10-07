import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState, ErrorState, LoadingState, StatusPill, type PillTone } from '../ui';

import {
  listTalentIntakeDrafts,
  type TalentIntakeDraftListItem,
} from './talent-intake-api';

// Durable Async Résumé-First Talent Intake — the "Draft Talents" recovery
// surface. Makes "leave and come back later" first-class: a recruiter uploads a
// résumé, closes the browser, and returns here to find the durable draft, its
// processing state, and a Continue affordance. Promoted drafts leave the active
// list (server-filtered).

function statusTone(processing: string, review: string): PillTone {
  if (review === 'PROMOTED') return 'brand';
  switch (processing) {
    case 'READY':
      return 'ok';
    case 'PARTIAL':
      return 'warn';
    case 'FAILED':
      return 'danger';
    default:
      return 'info';
  }
}

function statusLabel(processing: string, review: string): string {
  if (review === 'PROMOTED') return 'Talent created';
  switch (processing) {
    case 'UPLOADED':
      return 'Uploaded';
    case 'QUEUED':
      return 'Queued';
    case 'PROCESSING':
      return 'Reading résumé…';
    case 'READY':
      return 'Ready — review';
    case 'PARTIAL':
      return 'Needs review';
    case 'FAILED':
      return 'Extraction failed';
    default:
      return processing;
  }
}

function errorMessage(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return 'Could not load your draft talents. Please try again.';
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; items: TalentIntakeDraftListItem[] }
  | { status: 'error'; error: string };

export function DraftTalentsView(): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    listTalentIntakeDrafts()
      .then((r) => {
        if (!cancelled) setState({ status: 'ready', items: r.items });
      })
      .catch((e) => {
        if (!cancelled) setState({ status: 'error', error: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="rc-page">
      <div className="rc-pagehead">
        <h1 className="rc-pagetitle">Draft talents</h1>
        <Link to="/talent/new" className="rc-hbtn rc-hbtn--primary">
          Add talent
        </Link>
      </div>

      {state.status === 'loading' ? <LoadingState label="Loading your drafts…" /> : null}

      {state.status === 'error' ? (
        <ErrorState message={state.error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title="No draft talents"
          message="Upload a résumé on Add talent and it will appear here while it's being read — you can leave and come back any time."
        />
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <Card flush>
          <div className="rc-tablewrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th>Résumé</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {state.items.map((d) => (
                  <tr key={d.id} data-testid="draft-talent-row">
                    <td>{d.source_filename}</td>
                    <td>
                      <StatusPill tone={statusTone(d.processing_status, d.review_status)}>
                        {statusLabel(d.processing_status, d.review_status)}
                      </StatusPill>
                    </td>
                    <td>{new Date(d.created_at).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {d.review_status === 'PROMOTED' && d.promoted_talent_record_id !== null ? (
                        <Link
                          to={`/talent/${encodeURIComponent(d.promoted_talent_record_id)}`}
                          className="rc-hbtn"
                        >
                          View talent
                        </Link>
                      ) : (
                        <Link
                          to={`/talent/new?draft=${encodeURIComponent(d.id)}`}
                          className="rc-hbtn rc-hbtn--primary"
                        >
                          Continue
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
