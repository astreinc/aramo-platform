import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Card, InlineAlert, PageHeader } from '../ui';

import { OnboardingWorkspace } from './OnboardingWorkspace';
import type { RequirementAffordance } from './pre-start-affordance';
import {
  getPreStartRequirements,
  markPlacementReady,
  reopenRequirement,
  statusMoveRequirement,
  verifyRequirement,
  waiveRequirement,
} from './pre-start-api';
import { WAIVER_AUTHORITY_VALUES, type PreStartPlacementRequirements, type WaiverAuthority } from './types';

// L5-P7 — the onboarding workspace CONTAINER (the owning surface). Orchestration only:
// resolves the placement from the route, reads the governed requirements
// (pre_start_requirement:read), renders OnboardingWorkspace, and dispatches each governed
// affordance to its write client, refreshing after. Satisfy/Fail/Verify/Mark-ready need
// no input; Waive/Reopen open a justification form (Waive also needs an authority class).
// The BE guards + domain floors are the authority. Injectable fn/session seams mirror the
// house test pattern (PlacementDetailView).
export interface PreStartWorkspaceViewProps {
  readonly placementIdOverride?: string;
  readonly sessionOverride?: Session;
  readonly getRequirementsFn?: typeof getPreStartRequirements;
  readonly statusMoveFn?: typeof statusMoveRequirement;
  readonly verifyFn?: typeof verifyRequirement;
  readonly waiveFn?: typeof waiveRequirement;
  readonly reopenFn?: typeof reopenRequirement;
  readonly markReadyFn?: typeof markPlacementReady;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: PreStartPlacementRequirements }
  | { status: 'error' };

// A pending Waive/Reopen awaiting its justification (and authority, for waive).
interface PendingInput {
  readonly instanceId: string;
  readonly action: 'WAIVE' | 'REOPEN';
}

export function PreStartWorkspaceView({
  placementIdOverride,
  sessionOverride,
  getRequirementsFn,
  statusMoveFn,
  verifyFn,
  waiveFn,
  reopenFn,
  markReadyFn,
}: PreStartWorkspaceViewProps): JSX.Element {
  const params = useParams<{ placementId?: string }>();
  const placementId = placementIdOverride ?? params.placementId ?? '';

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scopes = session !== null && Array.isArray(session.scopes) ? session.scopes : [];
  const canRead = session !== null && hasScope(session, 'pre_start_requirement:read');

  const getReq = getRequirementsFn ?? getPreStartRequirements;
  const statusMove = statusMoveFn ?? statusMoveRequirement;
  const verify = verifyFn ?? verifyRequirement;
  const waive = waiveFn ?? waiveRequirement;
  const reopen = reopenFn ?? reopenRequirement;
  const markReady = markReadyFn ?? markPlacementReady;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInput | null>(null);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!canRead || placementId === '') return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    getReq(placementId)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, placementId, refreshKey, getReq]);

  const run = useCallback(
    async (op: () => Promise<unknown>, ok: string) => {
      setNotice(null);
      setActionError(null);
      try {
        await op();
        setNotice(ok);
        refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : 'Action failed');
      }
    },
    [refresh],
  );

  const onRequirementAction = useCallback(
    (instanceId: string, a: RequirementAffordance) => {
      switch (a.action) {
        case 'SATISFY':
          void run(() => statusMove(instanceId, { to: 'SATISFIED' }), 'Requirement satisfied');
          break;
        case 'FAIL':
          void run(() => statusMove(instanceId, { to: 'FAILED' }), 'Requirement marked failed');
          break;
        case 'VERIFY':
          void run(() => verify(instanceId, {}), 'Requirement verified');
          break;
        case 'WAIVE':
        case 'REOPEN':
          setPending({ instanceId, action: a.action });
          break;
      }
    },
    [run, statusMove, verify],
  );

  const onMarkReady = useCallback(() => {
    void run(() => markReady(placementId), 'Placement marked ready to start');
  }, [run, markReady, placementId]);

  if (!canRead) {
    return (
      <>
        <PageHeader title="Onboarding" />
        <InlineAlert variant="error">You do not have access to pre-start requirements.</InlineAlert>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Onboarding readiness" />
      {notice !== null ? <InlineAlert variant="success">{notice}</InlineAlert> : null}
      {actionError !== null ? <InlineAlert variant="error">{actionError}</InlineAlert> : null}
      {state.status === 'loading' ? <Card>Loading…</Card> : null}
      {state.status === 'error' ? <InlineAlert variant="error">Failed to load requirements.</InlineAlert> : null}
      {state.status === 'ready' ? (
        <>
          <OnboardingWorkspace
            data={state.data}
            scopes={scopes}
            onRequirementAction={onRequirementAction}
            onMarkReady={onMarkReady}
          />
          {pending !== null ? (
            <PendingActionForm
              pending={pending}
              onCancel={() => setPending(null)}
              onConfirm={(justification, authority) => {
                const { instanceId, action } = pending;
                setPending(null);
                if (action === 'WAIVE') {
                  void run(
                    () => waive(instanceId, { authority: authority ?? 'INTERNAL', justification }),
                    'Requirement waived',
                  );
                } else {
                  void run(() => reopen(instanceId, { justification }), 'Requirement reopened');
                }
              }}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

function PendingActionForm({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingInput;
  onConfirm: (justification: string, authority?: WaiverAuthority) => void;
  onCancel: () => void;
}): JSX.Element {
  const [justification, setJustification] = useState('');
  const [authority, setAuthority] = useState<WaiverAuthority>('INTERNAL');
  const label = pending.action === 'WAIVE' ? 'Waive requirement' : 'Reopen requirement';
  return (
    <Card>
      <form
        aria-label={label}
        onSubmit={(e) => {
          e.preventDefault();
          if (justification.trim().length > 0) onConfirm(justification, authority);
        }}
      >
        <p className="rc-onboarding__form-label">{label}</p>
        {pending.action === 'WAIVE' ? (
          <label>
            Authority
            <select value={authority} onChange={(e) => setAuthority(e.target.value as WaiverAuthority)}>
              {WAIVER_AUTHORITY_VALUES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Justification
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            aria-label="Justification"
          />
        </label>
        <button type="submit" className="rc-hbtn rc-hbtn--primary" disabled={justification.trim().length === 0}>
          Confirm
        </button>
        <button type="button" className="rc-hbtn" onClick={() => onCancel()}>
          Cancel
        </button>
      </form>
    </Card>
  );
}
