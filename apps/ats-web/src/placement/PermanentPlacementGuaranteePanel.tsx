import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useState } from 'react';

import { Button } from '../ui';

import { CompleteRemedyDialog } from './CompleteRemedyDialog';
import { GuaranteeStateCard } from './GuaranteeStateCard';
import { RecordFalloffDialog } from './RecordFalloffDialog';
import { RemedyObligationCard } from './RemedyObligationCard';
import { SatisfyGuaranteeDialog } from './SatisfyGuaranteeDialog';
import { REMEDY_DUE_STATES, type PermanentPlacementView } from './permanent-placement-types';

// Track 7 / T7-P5 §5.2 — the permanent-placement guarantee panel. Rendered by PlacementDetailView
// ONLY when the placement has a permanent aggregate (GET permanent non-null); it composes the two
// dedicated cards (state + remedy) and the lifecycle action dialogs. Least-visibility (hide, don't
// disable, §3.7): the panel itself is guarded upstream by placement:permanent:read; the ACTIONS
// are gated exactly:
//   satisfy / falloff → placement:permanent:transition (only while GUARANTEE_ACTIVE);
//   complete remedy   → placement:remedy:resolve (only in a remedy-due state).
// No optimistic mutation — every action re-reads authoritative server truth via onRefresh.
export interface PermanentPlacementGuaranteePanelProps {
  readonly placementId: string;
  readonly permanent: PermanentPlacementView;
  /** Re-read the authoritative permanent placement (owned by the parent). */
  readonly onRefresh: () => void;
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
}

export function PermanentPlacementGuaranteePanel({
  placementId,
  permanent,
  onRefresh,
  sessionOverride,
}: PermanentPlacementGuaranteePanelProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scoped = session !== null && Array.isArray(session.scopes);

  const canTransition = scoped && hasScope(session, 'placement:permanent:transition');
  const canResolve = scoped && hasScope(session, 'placement:remedy:resolve');

  const [satisfyOpen, setSatisfyOpen] = useState(false);
  const [falloffOpen, setFalloffOpen] = useState(false);
  const [remedyOpen, setRemedyOpen] = useState(false);

  const state = permanent.lifecycle_state;
  const isActive = state === 'GUARANTEE_ACTIVE';
  const isRemedyDue = REMEDY_DUE_STATES.includes(state);

  const showLifecycleActions = isActive && canTransition;
  const showRemedyAction = isRemedyDue && canResolve && permanent.remedy !== null;

  return (
    <section className="rc-stack" data-testid="permanent-placement-panel">
      <GuaranteeStateCard permanent={permanent} />
      <RemedyObligationCard permanent={permanent} />

      {(showLifecycleActions || showRemedyAction) && (
        <div className="rc-formfoot">
          {showLifecycleActions && (
            <>
              <Button
                variant="secondary"
                onClick={() => setFalloffOpen(true)}
                data-testid="falloff-record-action"
              >
                Record falloff
              </Button>
              <Button onClick={() => setSatisfyOpen(true)} data-testid="guarantee-satisfy-action">
                Satisfy guarantee
              </Button>
            </>
          )}
          {showRemedyAction && (
            <Button onClick={() => setRemedyOpen(true)} data-testid="remedy-complete-action">
              Complete remedy
            </Button>
          )}
        </div>
      )}

      {showLifecycleActions && (
        <>
          <SatisfyGuaranteeDialog
            open={satisfyOpen}
            placementId={placementId}
            onClose={() => setSatisfyOpen(false)}
            onSatisfied={onRefresh}
          />
          <RecordFalloffDialog
            open={falloffOpen}
            placementId={placementId}
            onClose={() => setFalloffOpen(false)}
            onRecorded={onRefresh}
          />
        </>
      )}
      {showRemedyAction && permanent.remedy !== null && (
        <CompleteRemedyDialog
          open={remedyOpen}
          placementId={placementId}
          remedy={permanent.remedy}
          onClose={() => setRemedyOpen(false)}
          onCompleted={onRefresh}
        />
      )}
    </section>
  );
}
