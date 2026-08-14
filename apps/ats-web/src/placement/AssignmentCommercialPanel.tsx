import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardHead, InlineAlert } from '../ui';

import { CommercialCancelRevisionDialog } from './CommercialCancelRevisionDialog';
import { CommercialCurrentTermsCard } from './CommercialCurrentTermsCard';
import { CommercialEndedState } from './CommercialEndedState';
import { CommercialRevisionFormDialog } from './CommercialRevisionFormDialog';
import { CommercialRevisionTimeline } from './CommercialRevisionTimeline';
import {
  getPlacementAssignment,
  getPlacementAssignmentCommercials,
  listAssignmentCommercialRevisions,
} from './placement-api';
import type {
  AssignmentCommercialResponse,
  AssignmentCommercialSeriesResponse,
  AssignmentCommercialView,
  ContractAssignmentLifecycleState,
  PlacementAssignmentResponse,
} from './types';

// Track 6 / T6-B4 — the commercial LIFECYCLE panel (expands the T5-P3 read-only panel).
// It orchestrates the placement-detail commercial surface: current terms, the revision
// timeline, governed create (Effective-now only), and governed cancellation of a future
// open-tail revision. Decomposition per directive §4; each concern is a dedicated child.
//
// Authority (house least-visibility — hide, don't disable):
//   • the whole panel follows assignment:commercials:read (§5): no read scope → render
//     nothing and issue no commercial read;
//   • create/cancel controls follow the §6 / DateTime-amendment §2 predicate: read AND
//     write AND compensation:view:pay AND (compensation:view:bill OR :revenue) AND the
//     assignment lifecycle ACTIVE — exact hasScope, no wildcard, no compensation:edit:*.
//
// Lifecycle comes from GET /assignment (assignment:read). When that read is unavailable
// (no assignment:read, or no assignment), lifecycle is unknown → the predicate is false →
// no mutation controls (fail-closed), consistent with the amendment's `assignment?.` form.
// ended_at is NOT fetched (not on any read surface); the ENDED end instant is derived from
// the surviving series (ENDED-State amendment §3). All money/percent are rendered verbatim
// and mask-aware; refresh is server re-read (§17), never optimistic.
export interface AssignmentCommercialPanelProps {
  readonly placementId: string;
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly getCommercialsFn?: (id: string) => Promise<AssignmentCommercialResponse>;
  readonly getAssignmentFn?: (id: string) => Promise<PlacementAssignmentResponse>;
  readonly listRevisionsFn?: (id: string) => Promise<AssignmentCommercialSeriesResponse>;
  /** Injectable clock for deterministic timeline classification in tests. */
  readonly nowMs?: number;
}

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready';
      lifecycle: ContractAssignmentLifecycleState | null;
      commercials: AssignmentCommercialView | null;
      series: readonly AssignmentCommercialView[];
    }
  | { status: 'error' };

export function AssignmentCommercialPanel({
  placementId,
  sessionOverride,
  getCommercialsFn,
  getAssignmentFn,
  listRevisionsFn,
  nowMs,
}: AssignmentCommercialPanelProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scoped = session !== null && Array.isArray(session.scopes);

  // §5 — panel visibility.
  const canRead = scoped && hasScope(session, 'assignment:commercials:read');
  // §6 / DateTime-amendment §2 — the compensation-view half of the mutation predicate.
  const canWrite = scoped && hasScope(session, 'assignment:commercials:write');
  const canSeePay = scoped && hasScope(session, 'compensation:view:pay');
  const canSeeBill =
    scoped &&
    (hasScope(session, 'compensation:view:bill') || hasScope(session, 'compensation:view:revenue'));

  const getCommercialsFun = getCommercialsFn ?? getPlacementAssignmentCommercials;
  const getAssignmentFun = getAssignmentFn ?? getPlacementAssignment;
  const listRevisionsFun = listRevisionsFn ?? listAssignmentCommercialRevisions;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<AssignmentCommercialView | null>(null);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    // Least-visibility: an actor without assignment:commercials:read never issues a read.
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([
      // Lifecycle is auxiliary (assignment:read) — degrade to null if unavailable.
      getAssignmentFun(placementId)
        .then((r) => r.assignment)
        .catch(() => null),
      getCommercialsFun(placementId).then((r) => r.commercials),
      listRevisionsFun(placementId).then((r) => r.items),
    ])
      .then(([assignment, commercials, series]) => {
        if (!cancelled) {
          setState({
            status: 'ready',
            lifecycle: assignment?.lifecycle_state ?? null,
            commercials,
            series,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, getAssignmentFun, getCommercialsFun, listRevisionsFun, placementId, refreshKey]);

  // §5 — panel visibility follows assignment:commercials:read (hide, don't disable).
  if (!canRead) return null;

  const lifecycle = state.status === 'ready' ? state.lifecycle : null;
  const commercials = state.status === 'ready' ? state.commercials : null;
  const series = state.status === 'ready' ? state.series : [];
  // §6 / amendment §2 — mutation predicate (assignment must be ACTIVE).
  const canMutate = canRead && canWrite && canSeePay && canSeeBill && lifecycle === 'ACTIVE';

  // The predecessor window that resumes if the cancel target is withdrawn: the non-cancelled
  // version whose effective_to equals the target's effective_from (readable → shown, §13).
  const predecessor =
    cancelTarget === null
      ? undefined
      : series.find((v) => v.effective_to === cancelTarget.effective_from);

  return (
    <section className="rc-stack" data-testid="assignment-commercial-panel">
      {state.status === 'loading' && (
        <Card>
          <CardHead title="Commercials" />
          <p className="rc-muted-line" data-testid="commercials-loading">
            Loading commercial terms…
          </p>
        </Card>
      )}
      {state.status === 'error' && (
        <Card>
          <CardHead title="Commercials" />
          <InlineAlert variant="error">Could not load commercial terms. Please try again.</InlineAlert>
        </Card>
      )}
      {state.status === 'ready' && lifecycle === 'ENDED' && (
        <CommercialEndedState series={series} nowMs={nowMs} />
      )}
      {state.status === 'ready' && lifecycle !== 'ENDED' && (
        <>
          <CommercialCurrentTermsCard commercials={commercials} />
          <CommercialRevisionTimeline
            series={series}
            canMutate={canMutate}
            onCancel={(version) => setCancelTarget(version)}
            nowMs={nowMs}
          />
          {canMutate && (
            <div className="rc-formfoot">
              <Button
                variant="secondary"
                onClick={() => setCreateOpen(true)}
                data-testid="commercial-revision-create-action"
              >
                New commercial revision
              </Button>
            </div>
          )}
        </>
      )}

      {canMutate && (
        <CommercialRevisionFormDialog
          open={createOpen}
          placementId={placementId}
          defaultCurrency={commercials?.currency}
          defaultRatePeriod={commercials?.rate_period}
          onClose={() => setCreateOpen(false)}
          onRefresh={refresh}
        />
      )}
      {canMutate && cancelTarget !== null && (
        <CommercialCancelRevisionDialog
          open={cancelTarget !== null}
          placementId={placementId}
          revision={cancelTarget}
          predecessor={predecessor}
          onClose={() => setCancelTarget(null)}
          onRefresh={refresh}
        />
      )}
    </section>
  );
}
