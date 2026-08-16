import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Card, CardHead, InlineAlert, PageHeader } from '../ui';

import { AssignmentCommercialPanel } from './AssignmentCommercialPanel';
import { AssignmentLifecyclePanel } from './AssignmentLifecyclePanel';
import { getPermanentPlacement } from './permanent-placement-api';
import type { PermanentPlacementResponse, PermanentPlacementView } from './permanent-placement-types';
import { PermanentPlacementGuaranteePanel } from './PermanentPlacementGuaranteePanel';
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
  readonly getPermanentFn?: (id: string) => Promise<PermanentPlacementResponse>;
}

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready';
      placement: PlacementView;
      events: readonly PlacementEventView[];
      permanent: PermanentPlacementView | null;
    }
  | { status: 'error' };

export function PlacementDetailView({
  placementIdOverride,
  sessionOverride,
  getPlacementFn,
  listEventsFn,
  getPermanentFn,
}: PlacementDetailViewProps) {
  const params = useParams<{ placementId?: string }>();
  const placementId = placementIdOverride ?? params.placementId ?? '';

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scoped = session !== null && Array.isArray(session.scopes);
  const canRead = scoped && hasScope(session, 'placement:read');
  // T7-P5 §5.1 — the permanent read is issued ONLY when the principal holds
  // placement:permanent:read. Absent scope → no request → the placement is treated as
  // contract (assignment panels), never via a misread forbidden response.
  const canReadPermanent = scoped && hasScope(session, 'placement:permanent:read');

  const getPlacementFun = getPlacementFn ?? getPlacement;
  const listEventsFun = listEventsFn ?? listPlacementEvents;
  const getPermanentFun = getPermanentFn ?? getPermanentPlacement;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!canRead || placementId === '') return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    // The container reads placement + events, and (only with the permanent read scope) the
    // permanent aggregate — the discriminator for the T7 branch (§5.1). The assignment reads
    // remain the child panels' responsibility on the contract branch.
    Promise.all([
      getPlacementFun(placementId),
      listEventsFun(placementId),
      canReadPermanent
        ? getPermanentFun(placementId)
            .then((r) => r.permanent)
            .catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([placement, eventsRes, permanent]) => {
        if (!cancelled) {
          setState({ status: 'ready', placement, events: eventsRes.items, permanent });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [getPlacementFun, listEventsFun, getPermanentFun, placementId, canRead, canReadPermanent, refreshKey]);

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

          {state.permanent !== null ? (
            // T7-P5 §5.1 — permanent aggregate present: render the guarantee UI and SUPPRESS the
            // contract-assignment panels (their empty states are misleading for a permanent
            // placement, which mints no ContractAssignment).
            <PermanentPlacementGuaranteePanel
              placementId={placementId}
              permanent={state.permanent}
              onRefresh={refresh}
              sessionOverride={sessionOverride}
            />
          ) : (
            <>
              <AssignmentLifecyclePanel placementId={placementId} sessionOverride={sessionOverride} />
              <AssignmentCommercialPanel placementId={placementId} sessionOverride={sessionOverride} />
            </>
          )}
        </>
      )}
    </section>
  );
}
