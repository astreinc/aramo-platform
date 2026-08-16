import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardHead, InlineAlert } from '../ui';

import { getEffectiveGuaranteeTerms, listGuaranteeTerms } from './guarantee-terms-api';
import { GuaranteeTermsFormDialog } from './GuaranteeTermsFormDialog';
import { GuaranteeTermVersionTimeline } from './GuaranteeTermVersionTimeline';
import type { GuaranteeTermVersionListResponse, GuaranteeTermVersionView } from './guarantee-terms-types';

// Track 7 / T7-P5 §5.5 — the requisition-level Guarantee Terms panel (the Requisition detail →
// Guarantee Terms tab body). Reusable (tenant, requisition)-keyed terms — distinct from the
// immutable per-placement activation snapshot. Least-visibility (§3.7): read follows
// placement:permanent:read (no read issued without it); create/revise follow
// placement:permanent:terms:write (actions hidden without it). No cancellation. Server re-read on
// save (never optimistic).
export interface GuaranteeTermsPanelProps {
  readonly requisitionId: string;
  readonly sessionOverride?: Session;
  readonly listFn?: (id: string) => Promise<GuaranteeTermVersionListResponse>;
  readonly effectiveFn?: (id: string) => Promise<GuaranteeTermVersionView>;
  /** Injectable clock for deterministic version classification in tests. */
  readonly nowMs?: number;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; versions: readonly GuaranteeTermVersionView[]; effective: GuaranteeTermVersionView | null }
  | { status: 'error' };

export function GuaranteeTermsPanel({ requisitionId, sessionOverride, listFn, effectiveFn, nowMs }: GuaranteeTermsPanelProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);
  const scoped = session !== null && Array.isArray(session.scopes);
  const canRead = scoped && hasScope(session, 'placement:permanent:read');
  const canWrite = scoped && hasScope(session, 'placement:permanent:terms:write');

  const listFun = listFn ?? listGuaranteeTerms;
  const effectiveFun = effectiveFn ?? getEffectiveGuaranteeTerms;

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [formMode, setFormMode] = useState<'create' | 'revise' | null>(null);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    Promise.all([
      listFun(requisitionId).then((r) => r.items),
      // A 404 = no effective version (a legit empty state), not an error.
      effectiveFun(requisitionId)
        .then((v): GuaranteeTermVersionView | null => v)
        .catch(() => null),
    ])
      .then(([versions, effective]) => {
        if (!cancelled) setState({ status: 'ready', versions, effective });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, listFun, effectiveFun, requisitionId, refreshKey]);

  // §3.7 — hide the whole panel (and issue no read) without the read scope.
  if (!canRead) return null;

  const versions = state.status === 'ready' ? state.versions : [];
  const hasVersions = versions.length > 0;
  const now = nowMs ?? Date.now();

  return (
    <section className="rc-stack rc-mt-16" data-testid="guarantee-terms-panel">
      <Card>
        <CardHead title="Guarantee terms" />
        <p className="rc-muted-line">
          Reusable guarantee terms for this requisition. Revisions apply to future permanent-placement
          activations only — permanent placements that have already started keep the guarantee snapshot
          captured at activation.
        </p>
        {state.status === 'loading' && (
          <p className="rc-muted-line" data-testid="guarantee-terms-loading">
            Loading guarantee terms…
          </p>
        )}
        {state.status === 'error' && (
          <InlineAlert variant="error">Could not load guarantee terms. Please try again.</InlineAlert>
        )}
        {state.status === 'ready' && (
          <>
            <GuaranteeTermVersionTimeline versions={versions} nowMs={now} />
            {canWrite && (
              <div className="rc-formfoot">
                {hasVersions ? (
                  <Button variant="secondary" onClick={() => setFormMode('revise')} data-testid="guarantee-terms-revise-action">
                    Revise terms
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setFormMode('create')} data-testid="guarantee-terms-create-action">
                    Create initial terms
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {canWrite && formMode !== null && (
        <GuaranteeTermsFormDialog
          open={formMode !== null}
          mode={formMode}
          requisitionId={requisitionId}
          onClose={() => setFormMode(null)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
