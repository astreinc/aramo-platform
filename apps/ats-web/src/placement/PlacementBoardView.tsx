import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, DataTable, InlineAlert, PageHeader, type TableColumn } from '../ui';

import { listPlacements } from './placement-api';
import { PLACEMENT_STATE_LABELS, type PlacementView } from './types';

// T4-E / E1-d composition — the placement DISCOVERY board. Its sole product
// responsibility is: an authorized user can find an existing placement and open
// its detail surface. It is deliberately NOT a dashboard — no filters, search,
// sort, bulk actions, analytics, or editing (those are separate product scope).
// It reads the authoritative collection (GET /v1/placements, placement:read)
// and identifies each placement by its OWN human-meaningful fields (client offer
// reference + lifecycle state + offered date) — never a raw UUID (no id leak, no
// N+1 name resolution).
export interface PlacementBoardViewProps {
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly listPlacementsFn?: () => Promise<{ items: readonly PlacementView[] }>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly PlacementView[] }
  | { status: 'error' };

// Deterministic display order: newest offered first, id as a stable tiebreak.
function ordered(rows: readonly PlacementView[]): readonly PlacementView[] {
  return [...rows].sort((a, b) => {
    if (a.offered_at !== b.offered_at) return a.offered_at < b.offered_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}

export function PlacementBoardView({ sessionOverride, listPlacementsFn }: PlacementBoardViewProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'placement:read');

  const listFun = listPlacementsFn ?? listPlacements;

  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    // Least-visibility: never read the collection without placement:read.
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    listFun()
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', rows: ordered(res.items) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [listFun, canRead]);

  // Route visibility follows placement:read (the RouteGuard also gates; this is
  // defense-in-depth for a directly-rendered container).
  if (!canRead) return null;

  const columns: ReadonlyArray<TableColumn<PlacementView>> = [
    {
      key: 'placement',
      header: 'Placement',
      render: (p) => (
        <Link
          to={`/placements/${encodeURIComponent(p.id)}`}
          className="rc-link-strong"
          data-testid={`placement-row-${p.id}`}
        >
          {p.client_offer_reference ?? 'Placement'}
        </Link>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      render: (p) => (
        <span data-testid={`placement-row-state-${p.id}`}>
          {PLACEMENT_STATE_LABELS[p.state]}
        </span>
      ),
    },
    {
      key: 'offered',
      header: 'Offered',
      render: (p) => new Date(p.offered_at).toLocaleDateString(),
    },
  ];

  return (
    <section className="rc-stack" data-testid="placement-board">
      <PageHeader
        title="Placements"
        description="Find a placement to view its lifecycle and assignment."
      />
      {state.status === 'loading' && (
        <p className="rc-muted-line" data-testid="placement-board-loading">
          Loading placements…
        </p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">
          Could not load placements. Please try again.
        </InlineAlert>
      )}
      {state.status === 'ready' && (
        <Card flush>
          <DataTable
            columns={columns}
            rows={state.rows}
            rowKey={(p) => p.id}
            emptyMessage="No placements visible to you yet."
          />
        </Card>
      )}
    </section>
  );
}
