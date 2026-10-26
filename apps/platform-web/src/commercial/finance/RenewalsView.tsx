import { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox, Select } from '@aramo/fe-foundation';

import { NotEnabledState, RenewalRemainingPill, TAX_NOT_ENABLED, WithheldPrice } from '../../components';

import { financeApi, type RenewalsReport } from './finance-api';
import { HORIZONS, renewalCount, renewalRows, type Horizon } from './finance-model';
import { Empty, LoadFailed, LoadingRows, PageHead, SourceTag, TenantLink, loadErrorText, useJoins, type Load } from './finance-shared';

import '../commercial.css';
import './finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.1; v1.2 §17.2; Commercial Control Plane v1.2.dc.html
// `is.renewals`) — Finance › Renewals: commitment ends and provider period ends inside the chosen
// horizon (GET /platform/commercial/finance/renewals, CCP-C6, platform:billing:read), lapsed dates
// included on request, chronological, NO totals. The C5 tax box sits above the table.
//
// W-1 (Architect ruling, 2026-10-25): the list price is catalog information and is shown to every
// billing reader, holder or not (the v1.2 file shows WithheldAmount to non-holders: DV-V12-W1).
// A row the catalog cannot price keeps WithheldPrice with its reason.

const INTRO =
  'Commitment ends and provider period ends inside the horizon you choose. Dates already passed show as lapsed. List prices only, no totals; list-price values are on Finance › Revenue.';

const HORIZON_LABEL: Readonly<Record<Horizon, string>> = { 30: 'Next 30 days', 60: 'Next 60 days', 90: 'Next 90 days', 180: 'Next 180 days' };

export function RenewalsView() {
  const [horizon, setHorizon] = useState<Horizon>(90);
  const [includeLapsed, setIncludeLapsed] = useState(true);
  const [load, setLoad] = useState<Load<RenewalsReport>>({ status: 'loading' });
  const joins = useJoins({ workbench: true });

  const fetchReport = useCallback(async (h: Horizon): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', value: await financeApi.renewals(h) });
    } catch (err) {
      setLoad({ status: 'error', message: loadErrorText(err, 'renewals') });
    }
  }, []);

  useEffect(() => {
    void fetchReport(horizon);
  }, [fetchReport, horizon]);

  const now = load.status === 'ready' ? new Date(load.value.as_of) : new Date();
  const rows = useMemo(
    () => (load.status === 'ready' ? renewalRows(load.value.items, includeLapsed, joins.workbench, joins.slugOf, new Date(load.value.as_of)) : []),
    [load, includeLapsed, joins],
  );

  return (
    <div className="pc-page" data-testid="finance-renewals">
      <PageHead title="Renewals" intro={INTRO} />
      <NotEnabledState title={TAX_NOT_ENABLED.title} reason={TAX_NOT_ENABLED.reason} />
      <div className="pf-toolbar">
        <Select unstyled aria-label="Horizon" className="pf-select" value={String(horizon)} onChange={(e) => setHorizon(Number(e.target.value) as Horizon)}>
          {HORIZONS.map((h) => (
            <option key={h} value={String(h)}>
              {HORIZON_LABEL[h]}
            </option>
          ))}
        </Select>
        <label className="pf-check">
          <Checkbox unstyled className="pf-check__box" checked={includeLapsed} onChange={(e) => setIncludeLapsed(e.target.checked)} />
          Include lapsed
        </label>
        <span className="pf-count" data-testid="renewals-count">
          {load.status === 'error' ? '' : renewalCount(rows)}
        </span>
      </div>
      <section className="pc-card" aria-label="Renewals">
        {load.status === 'loading' ? <LoadingRows label="Loading renewals…" /> : null}
        {load.status === 'error' ? <LoadFailed message={load.message} onRetry={() => void fetchReport(horizon)} /> : null}
        {load.status === 'ready' && rows.length > 0 ? (
          <div className="pc-scroll">
            <table className="pc-table pf-table pf-table--1040">
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Product</th>
                  <th scope="col">Plan · version</th>
                  <th scope="col">Source</th>
                  <th scope="col">End date</th>
                  <th scope="col">Remaining</th>
                  <th scope="col">List price</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.item.subscription_id}:${r.item.renewal_kind}`} data-testid={`renewal-${r.item.subscription_id}`}>
                    <td>
                      <TenantLink id={r.item.tenant_id}>{r.tenant}</TenantLink>
                      <div className="pf-slug">{r.slug}</div>
                    </td>
                    <td>{r.product}</td>
                    <td>
                      {r.plan}
                      <div className="pf-sub">{r.status}</div>
                    </td>
                    <td>
                      <SourceTag badge={r.source} />
                    </td>
                    <td>
                      <span className="pf-nowrap">{r.end}</span>
                      <div className="pf-sub">{r.kind}</div>
                    </td>
                    <td>
                      <RenewalRemainingPill endDate={new Date(r.item.renewal_at)} now={now} days={r.item.days_until} />
                    </td>
                    <td data-testid="renewal-price">
                      {r.price.kind === 'price' ? (
                        <>
                          <span className="pf-price">{r.price.text}</span>
                          <div className="pf-sub">{r.price.sub}</div>
                        </>
                      ) : r.price.kind === 'withheldPrice' ? (
                        <WithheldPrice reason={r.price.reason} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {load.status === 'ready' && rows.length === 0 ? <Empty title="No renewals in this horizon" body="Widen the horizon or include lapsed dates." /> : null}
      </section>
    </div>
  );
}
