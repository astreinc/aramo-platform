import { formatInstant } from '../format/date';
import { Card, CardHead } from '../ui';

import { CommercialMaskedValue } from './CommercialMaskedState';
import { formatMoney, formatPercent } from './commercial-format';
import type { AssignmentCommercialView } from './types';

// Track 6 / T6-B4 §8 — the CURRENT effective commercial terms card. Renders the T5-P2
// point-in-time projection verbatim (money/percent are server strings, never recomputed).
// Compensation-masked fields (pay/bill/margin/markup) arrive OMITTED (undefined) and are
// rendered with the dedicated non-leaking indicator (§7). currency / rate_period /
// spread_amount are never masked. Instants (effective_from/to) use the instant-safe
// formatter (DateTime amendment §6) — NOT a local/UTC date-only render — with the raw ISO
// on `<time dateTime>` so the exact instant stays machine-readable. Internal ids and the
// recorded_by UUID are never rendered (§8). A null projection is a coherent empty state.
export interface CommercialCurrentTermsCardProps {
  readonly commercials: AssignmentCommercialView | null;
}

export function CommercialCurrentTermsCard({ commercials }: CommercialCurrentTermsCardProps) {
  return (
    <Card>
      <CardHead title="Current commercial terms" />
      {commercials === null ? (
        <p className="rc-muted-line" data-testid="commercials-empty">
          No commercial terms recorded for this assignment yet.
        </p>
      ) : (
        <dl className="rc-deflist" data-testid="commercials-detail">
          <div className="rc-defrow">
            <dt>Pay rate</dt>
            <dd className="num" data-testid="commercials-pay-rate" data-rate-period={commercials.rate_period}>
              {commercials.pay_rate_amount === undefined ? (
                <CommercialMaskedValue />
              ) : (
                formatMoney(commercials.pay_rate_amount, commercials.currency, commercials.rate_period)
              )}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Bill rate</dt>
            <dd className="num" data-testid="commercials-bill-rate" data-rate-period={commercials.rate_period}>
              {commercials.bill_rate_amount === undefined ? (
                <CommercialMaskedValue />
              ) : (
                formatMoney(commercials.bill_rate_amount, commercials.currency, commercials.rate_period)
              )}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Spread</dt>
            <dd className="num" data-testid="commercials-spread">
              {formatMoney(commercials.spread_amount, commercials.currency, commercials.rate_period)}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Margin</dt>
            <dd className="num" data-testid="commercials-margin">
              {commercials.margin_percent === undefined ? (
                <CommercialMaskedValue />
              ) : (
                formatPercent(commercials.margin_percent)
              )}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Markup</dt>
            <dd className="num" data-testid="commercials-markup">
              {commercials.markup_percent === undefined ? (
                <CommercialMaskedValue />
              ) : (
                formatPercent(commercials.markup_percent)
              )}
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Effective from</dt>
            <dd>
              <time dateTime={commercials.effective_from} data-testid="commercials-effective-from">
                {formatInstant(commercials.effective_from)}
              </time>
            </dd>
          </div>
          <div className="rc-defrow">
            <dt>Effective to</dt>
            <dd data-testid="commercials-effective-to">
              {commercials.effective_to === null ? (
                'Current'
              ) : (
                <time dateTime={commercials.effective_to}>{formatInstant(commercials.effective_to)}</time>
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
  );
}
