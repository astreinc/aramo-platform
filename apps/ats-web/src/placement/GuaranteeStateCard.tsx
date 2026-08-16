import { formatDate } from '../format/date';
import { Card, CardHead, StatusPill } from '../ui';
import type { PillTone } from '../ui/pills';

import { formatMoney } from './commercial-format';
import {
  PERMANENT_PLACEMENT_STATE_LABELS,
  type PermanentPlacementState,
  type PermanentPlacementView,
} from './permanent-placement-types';

// Track 7 / T7-P5 §5.2/§5.3 — the guarantee snapshot card. Renders the IMMUTABLE per-placement
// activation snapshot (window dates as calendar DATE via formatDate — NOT the instant formatter;
// exposure as a verbatim decimal string with its currency adjacent). Status is communicated with
// an explicit text label AND a pill tone (never color alone, §11). Remaining days are a safe
// calendar derivation for an active guarantee only. Transient FELL_OFF internals are not
// surfaced here.

// Explicit state → pill tone (semantic; the label text is always present regardless of tone).
const STATE_TONE: Record<PermanentPlacementState, PillTone> = {
  GUARANTEE_ACTIVE: 'ok',
  GUARANTEE_SATISFIED: 'ok',
  FELL_OFF: 'warn',
  REPLACEMENT_DUE: 'warn',
  REFUND_DUE: 'warn',
  PRORATED_CREDIT_DUE: 'warn',
  REMEDY_COMPLETED: 'neutral',
};

// Whole calendar days from today (UTC) to the guarantee end (a @db.Date midnight-UTC value).
function remainingDays(endDateIso: string): number | null {
  const end = new Date(endDateIso);
  if (Number.isNaN(end.getTime())) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end.getTime() - todayUtc) / 86_400_000);
}

export interface GuaranteeStateCardProps {
  readonly permanent: PermanentPlacementView;
}

export function GuaranteeStateCard({ permanent }: GuaranteeStateCardProps) {
  const state = permanent.lifecycle_state;
  const isActive = state === 'GUARANTEE_ACTIVE';
  const remaining = isActive ? remainingDays(permanent.guarantee_end_date) : null;

  return (
    <Card>
      <CardHead title="Guarantee" />
      <dl className="rc-deflist" data-testid="guarantee-detail">
        <div className="rc-defrow">
          <dt>Status</dt>
          <dd data-testid="guarantee-status">
            <StatusPill tone={STATE_TONE[state]}>{PERMANENT_PLACEMENT_STATE_LABELS[state]}</StatusPill>
          </dd>
        </div>
        <div className="rc-defrow">
          <dt>Guarantee start</dt>
          <dd data-testid="guarantee-start">{formatDate(permanent.guarantee_start_date)}</dd>
        </div>
        <div className="rc-defrow">
          <dt>Guarantee end</dt>
          <dd data-testid="guarantee-end">{formatDate(permanent.guarantee_end_date)}</dd>
        </div>
        <div className="rc-defrow">
          <dt>Duration</dt>
          <dd data-testid="guarantee-duration">{permanent.guarantee_duration_days} days</dd>
        </div>
        <div className="rc-defrow">
          <dt>Guarantee exposure</dt>
          <dd className="num" data-testid="guarantee-exposure">
            {formatMoney(permanent.guarantee_exposure_amount, permanent.guarantee_exposure_currency, '')}
          </dd>
        </div>
        {isActive && remaining !== null && (
          <div className="rc-defrow">
            <dt>Time remaining</dt>
            <dd data-testid="guarantee-remaining">
              {remaining > 0 ? `${remaining} days remaining` : 'Guarantee window elapsed'}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}
