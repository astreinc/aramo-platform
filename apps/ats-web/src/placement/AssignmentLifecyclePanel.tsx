import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, CardHead, InlineAlert } from '../ui';

import { ConvertToPermanentDialog } from './ConvertToPermanentDialog';
import { EndAssignmentDialog } from './EndAssignmentDialog';
import { getPlacementAssignment } from './placement-api';
import {
  ASSIGNMENT_END_REASON_DISPLAY_LABELS,
  ASSIGNMENT_LIFECYCLE_LABELS,
  ASSIGNMENT_PROVENANCE_LABELS,
  type ContractAssignmentEndReason,
  type ContractAssignmentLifecycleState,
  type ContractAssignmentView,
  type ConvertToPermanentResponse,
  type PlacementAssignmentResponse,
} from './types';

// Track 4 (T4-E) — the ContractAssignment lifecycle panel. It reads the
// authoritative assignment for a placement (GET /v1/placements/{id}/assignment,
// assignment:read) and renders lifecycle state, started date, provenance and —
// when ENDED — the ending reason, preserving the COMPLETED / WORKER_ENDED /
// CLIENT_ENDED discriminator. A coherent empty state renders when no assignment
// has started (assignment === null); absence is NEVER an error.
//
// Authority (house least-visibility convention — hide, don't disable):
//   • the whole panel follows assignment:read (no read scope → render nothing,
//     and never fetch what the actor cannot see);
//   • the END control follows assignment:end (a distinct scope — placement:*
//     does NOT satisfy it) AND lifecycle_state === 'ACTIVE'.
//
// Capacity is out of scope on this surface: no capacity field is read and none
// is derived here.
export interface AssignmentLifecyclePanelProps {
  readonly placementId: string;
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly getAssignmentFn?: (id: string) => Promise<PlacementAssignmentResponse>;
  readonly endAssignmentFn?: (
    id: string,
    endReason: ContractAssignmentEndReason,
  ) => Promise<{ ok: true }>;
  // Track 7 / T7-PX — injectable conversion seams (mirror the end/get seams for tests).
  readonly convertToPermanentFn?: (id: string) => Promise<ConvertToPermanentResponse>;
  readonly effectiveTermsFn?: (requisitionId: string) => Promise<import('../requisitions/guarantee-terms-types').GuaranteeTermVersionView>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; assignment: ContractAssignmentView | null }
  | { status: 'error' };

function lifecycleLabel(state: ContractAssignmentLifecycleState | null): string {
  return state === null ? '—' : ASSIGNMENT_LIFECYCLE_LABELS[state];
}

export function AssignmentLifecyclePanel({
  placementId,
  sessionOverride,
  getAssignmentFn,
  endAssignmentFn,
  convertToPermanentFn,
  effectiveTermsFn,
}: AssignmentLifecyclePanelProps) {
  const sessionState = useSession();
  const navigate = useNavigate();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scoped = session !== null && Array.isArray(session.scopes);
  const canRead = scoped && hasScope(session, 'assignment:read');
  const canEnd = scoped && hasScope(session, 'assignment:end');
  // Track 7 / T7-PX §9 — conversion needs the EXACT conjunction assignment:end AND
  // placement:permanent:transition (both authoritative-tier; exact-string match, no wildcard).
  const canConvert = scoped && hasScope(session, 'assignment:end') && hasScope(session, 'placement:permanent:transition');

  const getAssignmentFun = getAssignmentFn ?? getPlacementAssignment;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    // Least-visibility: an actor without assignment:read never issues the read.
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    getAssignmentFun(placementId)
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', assignment: res.assignment });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [getAssignmentFun, placementId, canRead, refreshKey]);

  // Panel visibility follows assignment:read.
  if (!canRead) return null;

  const assignment = state.status === 'ready' ? state.assignment : null;
  const isActive = assignment?.lifecycle_state === 'ACTIVE';
  const showEndControl = isActive && canEnd;
  const showConvertControl = isActive && canConvert;

  return (
    <section className="rc-stack" data-testid="assignment-lifecycle-panel">
      <Card>
        <CardHead title="Assignment" />
        {state.status === 'loading' && (
          <p className="rc-muted-line" data-testid="assignment-loading">
            Loading assignment…
          </p>
        )}
        {state.status === 'error' && (
          <InlineAlert variant="error">
            Could not load the assignment. Please try again.
          </InlineAlert>
        )}
        {state.status === 'ready' && assignment === null && (
          <p className="rc-muted-line" data-testid="assignment-empty">
            No assignment has started for this placement yet.
          </p>
        )}
        {state.status === 'ready' && assignment !== null && (
          <>
            <dl className="rc-deflist" data-testid="assignment-detail">
              <div className="rc-defrow">
                <dt>Status</dt>
                <dd
                  data-testid="assignment-lifecycle-state"
                  data-lifecycle-state={assignment.lifecycle_state ?? ''}
                >
                  {lifecycleLabel(assignment.lifecycle_state)}
                </dd>
              </div>
              <div className="rc-defrow">
                <dt>Started</dt>
                <dd>
                  <time dateTime={assignment.started_at} data-testid="assignment-started-at">
                    {new Date(assignment.started_at).toLocaleDateString()}
                  </time>
                </dd>
              </div>
              <div className="rc-defrow">
                <dt>Origin</dt>
                <dd data-testid="assignment-provenance">
                  {ASSIGNMENT_PROVENANCE_LABELS[assignment.provenance]}
                </dd>
              </div>
              {assignment.lifecycle_state === 'ENDED' && assignment.end_reason !== null && (
                <div className="rc-defrow">
                  <dt>Ended because</dt>
                  <dd
                    data-testid="assignment-end-reason"
                    data-end-reason={assignment.end_reason}
                  >
                    {ASSIGNMENT_END_REASON_DISPLAY_LABELS[assignment.end_reason]}
                  </dd>
                </div>
              )}
            </dl>
            {(showEndControl || showConvertControl) && (
              <div className="rc-formfoot">
                {showEndControl && (
                  <Button
                    variant="secondary"
                    onClick={() => setDialogOpen(true)}
                    data-testid="assignment-end-action"
                  >
                    End assignment
                  </Button>
                )}
                {showConvertControl && (
                  <Button
                    onClick={() => setConvertOpen(true)}
                    data-testid="convert-to-permanent-action"
                  >
                    Convert to permanent
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>
      {showEndControl && (
        <EndAssignmentDialog
          open={dialogOpen}
          placementId={placementId}
          endAssignmentFn={endAssignmentFn}
          onClose={() => setDialogOpen(false)}
          onEnded={refresh}
        />
      )}
      {showConvertControl && assignment !== null && (
        <ConvertToPermanentDialog
          open={convertOpen}
          placementId={placementId}
          requisitionId={assignment.requisition_id}
          onClose={() => setConvertOpen(false)}
          // §14 — navigate to the NEW permanent PlacementProcess; its guarantee panel then
          // renders naturally via GET :id/permanent (server truth, never manufactured).
          onConverted={(result) => navigate(`/placements/${result.target_placement_process_id}`)}
          convertFn={convertToPermanentFn}
          effectiveTermsFn={effectiveTermsFn}
        />
      )}
    </section>
  );
}
