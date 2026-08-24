import { hasScope, type Session, useToast } from '@aramo/fe-foundation';
import { useCallback, useEffect, useState } from 'react';

import { formatInstant } from '../format/date';
import { Button, Card, CardHead, InlineAlert } from '../ui';

import { CommercialProposalDecisionDialog, type CommercialDecisionVariant } from './CommercialProposalDecisionDialog';
import { CommercialProposeDialog } from './CommercialProposeDialog';
import { formatMoney, formatPercent } from './commercial-format';
import {
  decideCommercialProposal,
  listCommercialProposals,
  transitionCommercialProposal,
} from './placement-api';
import {
  COMMERCIAL_PROPOSAL_STATE_LABELS,
  COMMERCIAL_PROPOSAL_TERMINAL_STATES,
  type AssignmentCommercialView,
  type CommercialProposalView,
} from './types';

// Slice #4 — Commercial Approval surface. Lists the assignment's commercial proposals with
// their state + the BE-derived current → proposed → delta margin (rendered verbatim), and
// exposes the GOVERNED affordances by state × scope × segregation-of-duties. FE gating is
// UX-only — the BE is authoritative — but it must never OFFER an action the actor cannot take:
//   • Propose            — assignment:commercials:write.
//   • Submit / Withdraw  — the PROPOSER (session.sub === requested_by) with write scope.
//   • Margin approve /
//     Record client approval / Apply / Reject
//                        — assignment:commercials:approve AND NOT the proposer (SoD): the
//                          approve affordances are HIDDEN for the proposer, not merely disabled.
// Money/percent are server strings (never recomputed); instants use the instant-safe formatter.
export interface CommercialProposalSectionProps {
  readonly placementId: string;
  readonly session: Session;
  /** Current effective terms — the baseline for the propose dialog's live margin preview. */
  readonly currentCommercials: AssignmentCommercialView | null;
  /** Re-read the panel's authoritative server truth after a proposal mutation. */
  readonly onServerChange?: () => void;
  /** Test seam mirroring the network mock in AssignmentCommercialPanel.spec. */
  readonly listProposalsFn?: (id: string) => Promise<{ items: readonly CommercialProposalView[] }>;
}

type DecisionTarget = { readonly proposal: CommercialProposalView; readonly variant: CommercialDecisionVariant };

export function CommercialProposalSection({
  placementId,
  session,
  currentCommercials,
  onServerChange,
  listProposalsFn,
}: CommercialProposalSectionProps) {
  const toast = useToast();
  const listFn = listProposalsFn ?? listCommercialProposals;

  const canWrite = hasScope(session, 'assignment:commercials:write');
  const canApprove = hasScope(session, 'assignment:commercials:approve');

  const [items, setItems] = useState<readonly CommercialProposalView[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [decisionTarget, setDecisionTarget] = useState<DecisionTarget | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onServerChange?.();
  }, [onServerChange]);

  useEffect(() => {
    let cancelled = false;
    listFn(placementId)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [listFn, placementId, refreshKey]);

  // Direct (no-capture) governed actions: proposer submit/withdraw, authority margin_approve/apply.
  const runDirect = async (
    proposal: CommercialProposalView,
    action: 'submit' | 'withdraw' | 'margin_approve' | 'apply',
  ) => {
    setPendingId(proposal.id);
    setError(null);
    try {
      if (action === 'submit' || action === 'withdraw') {
        await transitionCommercialProposal(placementId, proposal.id, action);
      } else {
        await decideCommercialProposal(placementId, proposal.id, { action });
      }
      toast.show('Proposal updated.');
      refresh();
    } catch {
      setError('Could not update the proposal — its state may have changed. The latest state has been refreshed.');
      refresh();
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Card>
      <CardHead title="Commercial proposals" />
      <section className="rc-stack" data-testid="commercial-proposals-section">
        {canWrite && (
          <div className="rc-formfoot">
            <Button
              variant="secondary"
              onClick={() => setProposeOpen(true)}
              data-testid="commercial-proposal-create-action"
            >
              Propose revision
            </Button>
          </div>
        )}

        {items.length === 0 ? (
          <p className="rc-muted-line" data-testid="commercial-proposals-empty">
            No commercial proposals for this assignment.
          </p>
        ) : (
          <ul className="rc-deflist" data-testid="commercial-proposals-list">
            {items.map((p) => {
              const isProposer = session.sub === p.requested_by;
              const isTerminal = COMMERCIAL_PROPOSAL_TERMINAL_STATES.includes(p.state);
              const canDecide = canApprove && !isProposer; // segregation of duties — hide for proposer
              const busy = pendingId === p.id;
              const period = p.proposed_rate_period;
              const currency = p.proposed_currency;
              return (
                <li
                  key={p.id}
                  className="rc-defrow"
                  data-testid="commercial-proposal-row"
                  data-proposal-id={p.id}
                  data-state={p.state}
                >
                  <div>
                    <span className="rc-tag" data-testid="commercial-proposal-state">
                      {COMMERCIAL_PROPOSAL_STATE_LABELS[p.state]}
                    </span>{' '}
                    <time dateTime={p.created_at}>{formatInstant(p.created_at)}</time>
                  </div>
                  <dd className="num" data-testid="commercial-proposal-margin">
                    Current{' '}
                    {formatMoney(p.margin.current.pay_rate_amount, currency, period)} pay ·{' '}
                    {formatMoney(p.margin.current.bill_rate_amount, currency, period)} bill ·{' '}
                    {formatPercent(p.margin.current.margin_percent)} margin
                    {' → Proposed '}
                    {formatMoney(p.margin.proposed.pay_rate_amount, currency, period)} pay ·{' '}
                    {formatMoney(p.margin.proposed.bill_rate_amount, currency, period)} bill ·{' '}
                    {formatPercent(p.margin.proposed.margin_percent)} margin
                    {' (Δ pay '}
                    {p.margin.pay_rate_delta}
                    {' · Δ bill '}
                    {p.margin.bill_rate_delta}
                    {' · Δ margin '}
                    {formatPercent(p.margin.margin_point_delta)}
                    {')'}
                  </dd>
                  {p.reason.trim().length > 0 && (
                    <div className="rc-muted-line" data-testid="commercial-proposal-reason">
                      {p.reason}
                    </div>
                  )}

                  {!isTerminal && (
                    <div className="rc-formfoot">
                      {p.state === 'DRAFT' && canWrite && isProposer && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => void runDirect(p, 'submit')}
                            disabled={busy}
                            data-testid="commercial-proposal-submit-action"
                          >
                            Submit for review
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => void runDirect(p, 'withdraw')}
                            disabled={busy}
                            data-testid="commercial-proposal-withdraw-action"
                          >
                            Withdraw
                          </Button>
                        </>
                      )}

                      {p.state === 'PENDING_REVIEW' && canDecide && (
                        <>
                          <Button
                            onClick={() => void runDirect(p, 'margin_approve')}
                            disabled={busy}
                            data-testid="commercial-proposal-margin-approve-action"
                          >
                            Approve margin
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setDecisionTarget({ proposal: p, variant: 'reject' })}
                            disabled={busy}
                            data-testid="commercial-proposal-reject-action"
                          >
                            Reject
                          </Button>
                        </>
                      )}

                      {p.state === 'PENDING_CLIENT_APPROVAL' && canDecide && (
                        <>
                          <Button
                            onClick={() => setDecisionTarget({ proposal: p, variant: 'client_approve' })}
                            disabled={busy}
                            data-testid="commercial-proposal-client-approve-action"
                          >
                            Record client approval
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setDecisionTarget({ proposal: p, variant: 'reject' })}
                            disabled={busy}
                            data-testid="commercial-proposal-reject-action"
                          >
                            Reject
                          </Button>
                        </>
                      )}

                      {p.state === 'APPROVED' && (
                        <>
                          {canDecide && (
                            <Button
                              onClick={() => void runDirect(p, 'apply')}
                              disabled={busy}
                              data-testid="commercial-proposal-apply-action"
                            >
                              Apply
                            </Button>
                          )}
                          {canWrite && isProposer && (
                            <Button
                              variant="secondary"
                              onClick={() => void runDirect(p, 'withdraw')}
                              disabled={busy}
                              data-testid="commercial-proposal-withdraw-action"
                            >
                              Withdraw
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      </section>

      {canWrite && (
        <CommercialProposeDialog
          open={proposeOpen}
          placementId={placementId}
          current={currentCommercials}
          onClose={() => setProposeOpen(false)}
          onRefresh={refresh}
        />
      )}
      {decisionTarget !== null && (
        <CommercialProposalDecisionDialog
          open={decisionTarget !== null}
          variant={decisionTarget.variant}
          placementId={placementId}
          proposal={decisionTarget.proposal}
          onClose={() => setDecisionTarget(null)}
          onRefresh={refresh}
        />
      )}
    </Card>
  );
}
