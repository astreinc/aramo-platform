import { useCallback, useEffect, useMemo, useState } from 'react';
import { hasScope, type Session } from '@aramo/fe-foundation';

import { COMMERCIAL_PERMISSIONS, NotEnabledState, TAX_NOT_ENABLED, WithheldAmount } from '../../components';

import { financeApi, type RevenueReport } from './finance-api';
import { monthRows, usd, withheldCount, withheldLine } from './finance-model';
import { Empty, LoadFailed, LoadingRows, PageHead, loadErrorText, type Load } from './finance-shared';

import '../commercial.css';
import './finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.5; v1.2 §17.2; Commercial Control Plane v1.2.dc.html
// `is.revenue`) — Finance › Revenue, the ONLY screen with money totals (A0-C6; the Dashboard stays
// counts-only, TD-B1-2). GET /platform/commercial/finance/revenue (CCP-D2, platform:billing:read):
// MRR = open active and past-due subscriptions × the pinned USD list price per month; ARR = MRR × 12;
// renewals by month for the next six months.
//
// Amounts (CCP-A1 Amendment A1, LOCKED): a holder of platform:billing:amount:read receives
// `mrr_minor` / `arr_minor` and each month's `mrr_minor`; every other billing reader receives the
// counts with `amount_withheld`, the page-level view-only note, WithheldAmount (stat) on MRR and
// ARR and (cell) on each month, and bars by renewal COUNT. The chart is never empty or broken.
// The design's "Design only" banner is not built: D2 is delivered (DV-V12-9).
//
// DV-V12-REV-1 (Lead correction, W-1 vs D2, 2026-10-25): the figures are derived from published
// list prices and are NOT recognized revenue, so they are never labelled "MRR", "ARR" or
// "revenue": the tiles read "Illustrative list-price value (monthly)" / "… (annualized)", and a
// visible note says so. The v1.2 copy differs; the text regions are masked in parity.

// DV-V12-REV-1: the v1.2 intro names the figures "recurring revenue"; reworded.
const INTRO =
  'Illustrative monthly and annualized values derived from commercial records: each open subscription at its pinned plan version’s published list price. USD only. This is the only screen with these money figures.';

export const LIST_PRICE_NOTE = 'Derived from published list prices; not recognized revenue.';
export const MONTHLY_LABEL = 'Illustrative list-price value (monthly)';
export const ANNUAL_LABEL = 'Illustrative list-price value (annualized)';

export interface RevenueViewProps {
  readonly session: Session;
}

export function RevenueView({ session }: RevenueViewProps) {
  const [load, setLoad] = useState<Load<RevenueReport>>({ status: 'loading' });
  const holder = hasScope(session, COMMERCIAL_PERMISSIONS.billingAmountRead);

  const fetchReport = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', value: await financeApi.revenue(6) });
    } catch (err) {
      setLoad({ status: 'error', message: loadErrorText(err, 'revenue') });
    }
  }, []);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  const r = load.status === 'ready' ? load.value : null;
  // The server decides: amounts are absent (and marked) whenever they are withheld.
  const amounts = r !== null && r.amount_withheld === undefined && typeof r.mrr_minor === 'number';
  const months = useMemo(() => (r === null ? [] : monthRows(r.renewal_pipeline.by_month, amounts)), [r, amounts]);
  const empty = r !== null && r.counts.open_commercial_subscriptions === 0;

  return (
    <div className="pc-page" data-testid="finance-revenue">
      <PageHead title="Revenue" intro={INTRO} />
      {!holder ? (
        <div className="pf-note" role="note">
          <b>View only.</b> These figures require Finance access. Counts stay visible; every figure is withheld.
        </div>
      ) : null}
      <div className="pf-note" role="note" data-testid="revenue-list-price-note">
        {LIST_PRICE_NOTE}
      </div>
      <NotEnabledState title={TAX_NOT_ENABLED.title} reason={TAX_NOT_ENABLED.reason} />
      {/* The design draws the loading and empty states on the canvas, not in a card. */}
      {load.status === 'loading' ? <LoadingRows label="Loading revenue…" /> : null}
      {load.status === 'error' ? (
        <section className="pc-card">
          <LoadFailed message={load.message} onRetry={() => void fetchReport()} />
        </section>
      ) : null}
      {r !== null && !empty ? (
        <>
          <div className="pf-tiles">
            <div className="pf-tile" data-testid="revenue-mrr">
              <div className="pf-tile__label">{MONTHLY_LABEL}</div>
              {amounts ? <div className="pf-tile__n">{usd(r.mrr_minor ?? 0)}</div> : <div><WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="stat" /></div>}
              <div className="pf-tile__sub">Active and past-due subscriptions × pinned list price</div>
            </div>
            <div className="pf-tile" data-testid="revenue-arr">
              <div className="pf-tile__label">{ANNUAL_LABEL}</div>
              {amounts ? <div className="pf-tile__n">{usd(r.arr_minor ?? 0)}</div> : <div><WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="stat" /></div>}
              <div className="pf-tile__sub">Monthly value × 12</div>
            </div>
            <div className="pf-tile">
              <div className="pf-tile__label">Included</div>
              <div className="pf-tile__n">{r.counts.included}</div>
              <div className="pf-tile__sub">Subscriptions with a USD list price</div>
            </div>
            <div className="pf-tile">
              <div className="pf-tile__label">Withheld</div>
              <div className="pf-tile__n">{withheldCount(r.counts.excluded_by_reason)}</div>
              <div className="pf-tile__sub">{withheldLine(r.counts.excluded_by_reason)}</div>
            </div>
          </div>
          <section className="pc-card" aria-labelledby="pf-rv-months">
            <div className="pf-card-head">
              <h2 id="pf-rv-months">Renewals by month</h2>
              <p>
                Commitment ends and provider period ends over the next six months, valued at pinned list prices. Withheld renewals aren’t valued.{' '}
                {amounts ? 'Bar length shows list value.' : 'Bar length shows the number of renewals.'}
              </p>
            </div>
            <div className="pf-months">
              {months.map((m) => (
                <div key={m.month} className="pf-month" data-testid={`revenue-month-${m.month}`}>
                  <span className="pf-month__label">{m.label}</span>
                  <span className="pf-month__track" aria-hidden="true">
                    <span className="pf-month__bar" style={{ width: `${m.bar}%` }} />
                  </span>
                  <span className="pf-month__n">{m.count}</span>
                  <span className="pf-month__v">
                    {m.value.kind === 'shown' ? m.value.text : m.value.kind === 'withheld' ? <WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="cell" /> : '—'}
                  </span>
                  <span className="pf-month__w">{m.withheldNote}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
      {empty ? <Empty title="No open subscriptions" body="Revenue appears once subscriptions are open." /> : null}
    </div>
  );
}
