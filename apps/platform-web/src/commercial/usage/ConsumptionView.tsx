import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Select } from '@aramo/fe-foundation';

import { Pill, UsageReconBanner } from '../../components';
import { Empty, LoadFailed, LoadingRows, PageHead, TenantLink, loadErrorText, useJoins, type Load } from '../finance/finance-shared';
import { shortRef } from '../finance/finance-model';

import { usageApi, type UsagePeriods, type UsageReconciliation } from './usage-api';
import { bannerStatus, lastRunAt, mismatchCount, periodOptions, usageRows } from './usage-model';

import '../commercial.css';
import '../finance/finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.4; Commercial Control Plane v1.2.dc.html `is.usage`) — Usage ›
// Consumption: Sign envelope usage per tenant and billing period, rolled up from Sign records
// (CCP-D1, platform:subscription:read). Counts only. The status banner always shows; when the live
// reconciliation is NOT_RECONCILED the period table is REPLACED by the refused card (the periods
// read is refused 409 USAGE_ROLLUP_NOT_RECONCILED; the card names that real code, DV-V12-11). Nothing here is editable and there is no manual
// run trigger. The Roll-up runs card is not built: no route lists the runs (MBC-V12-7, DV-V12-8).

const INTRO = 'Sign envelope usage per tenant and period, rolled up from Sign records. Counts only: no money, and no ordering by volume.';

type Periods = { readonly kind: 'rows'; readonly value: UsagePeriods } | { readonly kind: 'refused' };

export function ConsumptionView() {
  const [recon, setRecon] = useState<Load<UsageReconciliation>>({ status: 'loading' });
  const [periods, setPeriods] = useState<Periods | null>(null);
  const [period, setPeriod] = useState('all');
  const joins = useJoins({ workbench: false });

  const fetchAll = useCallback(async (): Promise<void> => {
    setRecon({ status: 'loading' });
    setPeriods(null);
    try {
      const r = await usageApi.reconciliation();
      setRecon({ status: 'ready', value: r });
      if (r.status === 'NOT_RECONCILED') {
        setPeriods({ kind: 'refused' });
        return;
      }
      try {
        setPeriods({ kind: 'rows', value: await usageApi.periods() });
      } catch (err) {
        // The server's own refusal (a run finished in between): the same designed refused state.
        if (err instanceof ApiError && err.status === 409) setPeriods({ kind: 'refused' });
        else throw err;
      }
    } catch (err) {
      setRecon({ status: 'error', message: loadErrorText(err, 'usage') });
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const r = recon.status === 'ready' ? recon.value : null;
  const list = useMemo(() => (periods?.kind === 'rows' ? periods.value.periods : []), [periods]);
  const rows = useMemo(() => usageRows(list, period, (id) => joins.nameOf(id) ?? shortRef(id)), [list, period, joins]);
  const options = useMemo(() => periodOptions(list), [list]);
  const status = r === null ? null : periods?.kind === 'refused' ? 'NOT_RECONCILED' : bannerStatus(r);
  const at = r === null ? null : lastRunAt(r);

  return (
    <div className="pc-page" data-testid="usage-consumption">
      <PageHead title="Consumption" intro={INTRO} />
      {r !== null && status !== null ? <UsageReconBanner status={status} mismatches={mismatchCount(r)} lastRun={at === null ? null : { at }} /> : null}
      {recon.status === 'error' ? (
        <section className="pc-card">
          <LoadFailed message={recon.message} onRetry={() => void fetchAll()} />
        </section>
      ) : null}
      {periods?.kind === 'refused' ? (
        <section className="pc-card pf-card--gap" data-testid="usage-refused">
          <div className="pf-refused">
            <b>Usage analytics unavailable</b>
            <p>
              The usage API refuses analytics until roll-ups reconcile (<span className="pf-code">409 USAGE_ROLLUP_NOT_RECONCILED</span>). Nothing here is editable; the next run retries automatically.
            </p>
            <Link to="/commercial/alerts">See the open alert →</Link>
          </div>
        </section>
      ) : (
        <>
          <div className="pf-toolbar">
            <Select unstyled aria-label="Period" className="pf-select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="all">All periods</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <span className="pf-metric">Metric: Sign envelopes</span>
          </div>
          <section className="pc-card pf-card--gap" aria-label="Usage periods">
            {recon.status === 'loading' || (r !== null && periods === null) ? <LoadingRows label="Loading usage…" /> : null}
            {periods?.kind === 'rows' && rows.length > 0 ? (
              <div className="pc-scroll">
                <table className="pc-table pf-table pf-table--980">
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Period</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Historical</th>
                      <th scope="col">Reserved</th>
                      <th scope="col">Plan allowance</th>
                      <th scope="col">Alignment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={`${u.period.tenant_id}:${u.period.period_start}`}>
                        <td>
                          <TenantLink id={u.period.tenant_id}>{u.tenant}</TenantLink>
                        </td>
                        <td>
                          {u.label}
                          <div className="pf-sub">{u.range}</div>
                        </td>
                        <td>
                          <span className="pf-strong">{u.sent}</span>
                        </td>
                        <td>{u.historical}</td>
                        <td>{u.reserved}</td>
                        <td>{u.allowance}</td>
                        <td>
                          <Pill tone={u.aligned ? 'ok' : 'warn'}>{u.aligned ? 'Aligned' : 'Unaligned'}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {periods?.kind === 'rows' && rows.length === 0 ? <Empty title="No usage periods" body="Periods appear once a subscription has been open for a day." /> : null}
          </section>
        </>
      )}
    </div>
  );
}
