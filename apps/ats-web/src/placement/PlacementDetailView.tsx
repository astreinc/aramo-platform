import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Card, CardHead, InlineAlert, PageHeader } from '../ui';

import { AssignmentLifecyclePanel } from './AssignmentLifecyclePanel';
import { getPlacement, listPlacementEvents } from './placement-api';
import { PlacementCard } from './PlacementCard';
import { PlacementEventTimeline } from './PlacementEventTimeline';
import type { PlacementEventView, PlacementView } from './types';

// T4-E / E1-d composition — the placement DETAIL container. This is the missing
// product surface the E1-d placement panels + the T4-E assignment panel were
// built for but never composed. It is ORCHESTRATION ONLY: it resolves the
// placement identity from the route and composes three dedicated panels, each
// retaining its own domain responsibility. It owns NO lifecycle/assignment
// authority and adds NO capacity.
//
//   PlacementCard              — authoritative placement state (E1-d)
//   PlacementEventTimeline     — the authorized reason/event surface (E1-d)
//   AssignmentLifecyclePanel   — the ContractAssignment lifecycle + safe END (T4-E)
//
// The assignment read (GET /v1/placements/{id}/assignment) stays OWNED by the
// child panel — the container never issues it, so there is a single assignment
// read path over the aggregate.
export interface PlacementDetailViewProps {
  readonly placementIdOverride?: string;
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly getPlacementFn?: (id: string) => Promise<PlacementView>;
  readonly listEventsFn?: (id: string) => Promise<{ items: readonly PlacementEventView[] }>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; placement: PlacementView; events: readonly PlacementEventView[] }
  | { status: 'error' };

export function PlacementDetailView({
  placementIdOverride,
  sessionOverride,
  getPlacementFn,
  listEventsFn,
}: PlacementDetailViewProps) {
  const params = useParams<{ placementId?: string }>();
  const placementId = placementIdOverride ?? params.placementId ?? '';

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'placement:read');

  const getPlacementFun = getPlacementFn ?? getPlacement;
  const listEventsFun = listEventsFn ?? listPlacementEvents;

  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!canRead || placementId === '') return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    // The container reads ONLY placement + events; the assignment read is the
    // child panel's responsibility (no duplicate read path).
    Promise.all([getPlacementFun(placementId), listEventsFun(placementId)])
      .then(([placement, eventsRes]) => {
        if (!cancelled) {
          setState({ status: 'ready', placement, events: eventsRes.items });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [getPlacementFun, listEventsFun, placementId, canRead]);

  // Route visibility follows placement:read (RouteGuard also gates).
  if (!canRead) return null;

  if (placementId === '') {
    return <InlineAlert variant="error">Missing placement id in URL.</InlineAlert>;
  }

  return (
    <section className="rc-stack" data-testid="placement-detail">
      <PageHeader
        title="Placement"
        description="Lifecycle state, event history, and contract assignment."
      />
      <p>
        <Link to="/placements" className="rc-link-action" data-testid="placement-detail-back">
          ← Back to placements
        </Link>
      </p>

      {state.status === 'loading' && (
        <p className="rc-muted-line" data-testid="placement-detail-loading">
          Loading placement…
        </p>
      )}
      {state.status === 'error' && (
        <InlineAlert variant="error">
          Could not load this placement. It may not exist or may not be visible to you.
        </InlineAlert>
      )}
      {state.status === 'ready' && (
        <>
          <Card>
            <CardHead title="Placement state" />
            <PlacementCard placement={state.placement} scopes={session.scopes} />
          </Card>

          <Card>
            <CardHead title="History" />
            <PlacementEventTimeline events={state.events} />
          </Card>

          <AssignmentLifecyclePanel placementId={placementId} sessionOverride={sessionOverride} />
        </>
      )}
    </section>
  );
}
