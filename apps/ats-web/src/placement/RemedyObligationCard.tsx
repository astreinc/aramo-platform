import { formatDate, formatInstant } from '../format/date';
import { Card, CardHead } from '../ui';

import { formatMoney } from './commercial-format';
import { falloffReasonLabel } from './falloff-reason-labels';
import { REMEDY_POLICY_LABELS, type PermanentPlacementView, type RemedyPolicy } from './permanent-placement-types';

// Track 7 / T7-P5 §5.3 — the falloff + remedy OBLIGATION card. Rendered only once a qualifying
// falloff has been recorded. Shows the falloff facts (date as calendar DATE; governed reason via
// the closed label map) and the deterministic remedy OBLIGATION. The calculated amount is a
// server-derived, READ-ONLY obligation figure (present only for REFUND / PRORATED_CREDIT;
// REPLACEMENT is non-monetary). Completion, when present, shows the governed completion EVIDENCE
// (a reference, or a linked replacement placement) — never a payment. Wording uses
// "obligation" / "completion evidence"; Aramo executes no settlement.

// Human obligation summary per remedy type (never implies money movement).
const OBLIGATION_SUMMARY: Record<RemedyPolicy, string> = {
  REPLACEMENT: 'A replacement permanent placement is owed under the guarantee.',
  REFUND: 'A refund obligation is owed under the guarantee.',
  PRORATED_CREDIT: 'A prorated credit obligation is owed under the guarantee.',
};

export interface RemedyObligationCardProps {
  readonly permanent: PermanentPlacementView;
}

export function RemedyObligationCard({ permanent }: RemedyObligationCardProps) {
  const remedy = permanent.remedy;
  if (permanent.falloff_effective_date === null && remedy === null) return null;

  const completed = remedy !== null && remedy.completed_at !== null;

  return (
    <Card>
      <CardHead title="Falloff & remedy" />
      <dl className="rc-deflist" data-testid="remedy-detail">
        {permanent.falloff_effective_date !== null && (
          <div className="rc-defrow">
            <dt>Falloff effective date</dt>
            <dd data-testid="falloff-effective-date">{formatDate(permanent.falloff_effective_date)}</dd>
          </div>
        )}
        {permanent.falloff_reason !== null && (
          <div className="rc-defrow">
            <dt>Falloff reason</dt>
            <dd data-testid="falloff-reason">{falloffReasonLabel(permanent.falloff_reason)}</dd>
          </div>
        )}
        {remedy !== null && (
          <>
            <div className="rc-defrow">
              <dt>Remedy obligation</dt>
              <dd data-testid="remedy-type">
                {REMEDY_POLICY_LABELS[remedy.remedy_type]} — {OBLIGATION_SUMMARY[remedy.remedy_type]}
              </dd>
            </div>
            {remedy.calculated_amount !== null && remedy.currency !== null && (
              <div className="rc-defrow">
                <dt>Obligation amount</dt>
                <dd className="num" data-testid="remedy-amount">
                  {formatMoney(remedy.calculated_amount, remedy.currency, '')}
                  <span className="rc-muted-line"> (obligation — not a payment)</span>
                </dd>
              </div>
            )}
            <div className="rc-defrow">
              <dt>Status</dt>
              <dd data-testid="remedy-status">
                {completed ? 'Remedy evidence completed' : 'Remedy obligation outstanding'}
              </dd>
            </div>
            {completed && (
              <>
                <div className="rc-defrow">
                  <dt>Completed</dt>
                  <dd>
                    <time dateTime={remedy.completed_at ?? undefined} data-testid="remedy-completed-at">
                      {formatInstant(remedy.completed_at)}
                    </time>
                  </dd>
                </div>
                {remedy.completion_reference !== null && (
                  <div className="rc-defrow">
                    <dt>Completion evidence</dt>
                    <dd data-testid="remedy-completion-reference">{remedy.completion_reference}</dd>
                  </div>
                )}
                {remedy.replacement_placement_process_id !== null && (
                  <div className="rc-defrow">
                    <dt>Replacement placement</dt>
                    <dd data-testid="remedy-replacement">{remedy.replacement_placement_process_id}</dd>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </dl>
    </Card>
  );
}
