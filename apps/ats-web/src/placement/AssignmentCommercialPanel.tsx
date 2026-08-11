import { hasScope, type Session, useSession } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';

import { Card, CardHead, InlineAlert } from '../ui';

import { getPlacementAssignmentCommercials } from './placement-api';
import type { AssignmentCommercialResponse, AssignmentCommercialView } from './types';

// Track 5 (T5-P3) — the placement-detail commercial UI for commercial-authorized
// tenant roles (account_manager / tenant_admin / tenant_owner). It reads the CURRENT
// effective commercial projection for a placement's assignment
// (GET /v1/placements/{id}/assignment/commercials, assignment:commercials:read) and
// renders the stored actuals (pay / bill / currency / period) plus the DEC-5 derived
// views (spread / margin / markup). A coherent empty state renders when there is no
// assignment or no active commercial version (commercials === null); absence is NEVER
// an error.
//
// Authority (house least-visibility convention — hide, don't disable):
//   • the whole panel follows assignment:commercials:read — a DEDICATED financial
//     scope. Without it the panel renders NOTHING and issues NO request (an actor who
//     cannot see commercial figures never learns the surface exists). assignment:read,
//     placement:read, requisition:read and commercials-write-only do NOT satisfy it.
//
// This surface is READ-ONLY (T5-P3): no edit / revise / supersede / extend / effective_to
// mutation / overlap repair (those are T6), and no analytics (T9). Money and percentages
// are rendered VERBATIM as the server returns them — the client never recomputes
// spread / margin / markup and never picks an effective version.
export interface AssignmentCommercialPanelProps {
  readonly placementId: string;
  /** Test seam mirroring the house useSession + sessionOverride pattern. */
  readonly sessionOverride?: Session;
  readonly getCommercialsFn?: (id: string) => Promise<AssignmentCommercialResponse>;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; commercials: AssignmentCommercialView | null }
  | { status: 'error' };

// T5-P3 R6 — a LOCAL closed rate-period suffix map for this feature (deliberate,
// bounded duplication of the requisitions-local map; NOT extracted cross-feature).
const RATE_PERIOD_SUFFIX: Record<string, string> = {
  HOURLY: '/hr',
  DAILY: '/day',
  WEEKLY: '/wk',
  MONTHLY: '/mo',
  ANNUAL: '/yr',
};

function periodSuffix(ratePeriod: string): string {
  return RATE_PERIOD_SUFFIX[ratePeriod] ?? '';
}

// Presentation only (T5-P3 R7/R8): render the server's decimal percentage string
// verbatim with a % suffix; a null derived metric (zero denominator) shows an em-dash.
function pct(value: string | null): string {
  return value === null ? '—' : `${value}%`;
}

export function AssignmentCommercialPanel({
  placementId,
  sessionOverride,
  getCommercialsFn,
}: AssignmentCommercialPanelProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'assignment:commercials:read');

  const getCommercialsFun = getCommercialsFn ?? getPlacementAssignmentCommercials;

  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    // Least-visibility: an actor without assignment:commercials:read never issues the read.
    if (!canRead) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    getCommercialsFun(placementId)
      .then((res) => {
        if (!cancelled) setState({ status: 'ready', commercials: res.commercials });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [getCommercialsFun, placementId, canRead]);

  // Panel visibility follows assignment:commercials:read (hide, don't disable).
  if (!canRead) return null;

  const commercials = state.status === 'ready' ? state.commercials : null;

  return (
    <section className="rc-stack" data-testid="assignment-commercial-panel">
      <Card>
        <CardHead title="Commercials" />
        {state.status === 'loading' && (
          <p className="rc-muted-line" data-testid="commercials-loading">
            Loading commercial terms…
          </p>
        )}
        {state.status === 'error' && (
          // Fail-closed (T5-P3 R10): generic copy, no status-code branching, no values
          // shown. A server overlap (INTERNAL_ERROR) never leaks competing figures here.
          <InlineAlert variant="error">
            Could not load commercial terms. Please try again.
          </InlineAlert>
        )}
        {state.status === 'ready' && commercials === null && (
          <p className="rc-muted-line" data-testid="commercials-empty">
            No commercial terms recorded for this assignment yet.
          </p>
        )}
        {state.status === 'ready' && commercials !== null && (
          <dl className="rc-deflist" data-testid="commercials-detail">
            <div className="rc-defrow">
              <dt>Pay rate</dt>
              <dd className="num" data-testid="commercials-pay-rate" data-rate-period={commercials.rate_period}>
                {commercials.pay_rate_amount} {commercials.currency}
                {periodSuffix(commercials.rate_period)}
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Bill rate</dt>
              <dd className="num" data-testid="commercials-bill-rate" data-rate-period={commercials.rate_period}>
                {commercials.bill_rate_amount} {commercials.currency}
                {periodSuffix(commercials.rate_period)}
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Spread</dt>
              <dd className="num" data-testid="commercials-spread">
                {commercials.spread_amount} {commercials.currency}
                {periodSuffix(commercials.rate_period)}
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Margin</dt>
              <dd className="num" data-testid="commercials-margin">
                {pct(commercials.margin_percent)}
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Markup</dt>
              <dd className="num" data-testid="commercials-markup">
                {pct(commercials.markup_percent)}
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Effective from</dt>
              <dd>
                <time dateTime={commercials.effective_from} data-testid="commercials-effective-from">
                  {new Date(commercials.effective_from).toLocaleDateString()}
                </time>
              </dd>
            </div>
            <div className="rc-defrow">
              <dt>Effective to</dt>
              <dd data-testid="commercials-effective-to">
                {commercials.effective_to === null ? (
                  'Current'
                ) : (
                  <time dateTime={commercials.effective_to}>
                    {new Date(commercials.effective_to).toLocaleDateString()}
                  </time>
                )}
              </dd>
            </div>
            {commercials.change_reason !== null && (
              <div className="rc-defrow">
                <dt>Change reason</dt>
                <dd data-testid="commercials-change-reason">{commercials.change_reason}</dd>
              </div>
            )}
          </dl>
        )}
      </Card>
    </section>
  );
}
