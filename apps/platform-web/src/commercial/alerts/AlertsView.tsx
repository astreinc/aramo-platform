import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@aramo/fe-foundation';

import { Pill } from '../../components';
import { Empty, LoadFailed, LoadingRows, PageHead, loadErrorText, requestHref, useJoins, type Load } from '../finance/finance-shared';

import { alertsApi, type CommercialAlert } from './alerts-api';
import { ALERT_FILTERS, alertRow, mergeAlerts, passes, type AlertFilter, type AlertRowView } from './alerts-model';

import '../commercial.css';
import '../finance/finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.6; v1.2 §17.1 D-2, §17.2; Commercial Control Plane
// v1.2.dc.html `is.alerts`) — Operations › Alerts: the operational alert register (CCP-D3, both
// families: billing, platform:billing:read; approvals, platform:approval:read). Alerts open and
// resolve automatically when their condition changes. NO actions (PLATFORM-UX-1 A1-2): no
// acknowledge, retry or resolve; follow the subject to where the governed action lives.
// D3 alert payloads carry no amount (FA-6), so nothing here is ever a money figure.

const INTRO =
  'Operational alerts raised from commercial records. They open and resolve automatically when the underlying condition changes. There are no actions here: follow the subject to where the governed action lives.';

/**
 * DV-V12-10 (PLATFORM-UX-1 R-18): the design's footer uses two words that scripts/verify-vocabulary.sh
 * bans; the nearest compliant wording keeps its meaning.
 */
export const ALERTS_FOOT = 'Severity is operational only. Alerts never grade, rate or order tenants or people.';

function Subject({ r }: { readonly r: AlertRowView }) {
  if (r.link === null) return <span>{r.subject}</span>;
  const to = r.link.kind === 'request' ? requestHref(r.link.id) : r.link.kind === 'tenant' ? `/tenants/${encodeURIComponent(r.link.id)}?tab=commercial` : r.link.to;
  return (
    <Link className="pf-strong" to={to}>
      {r.subject}
    </Link>
  );
}

export function AlertsView() {
  const [filter, setFilter] = useState<AlertFilter>('open');
  const [load, setLoad] = useState<Load<readonly CommercialAlert[]>>({ status: 'loading' });
  const joins = useJoins({ workbench: false });

  const fetchAll = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      const [billing, approvals] = await Promise.all([alertsApi.billing(), alertsApi.approvals()]);
      setLoad({ status: 'ready', value: mergeAlerts(billing.alerts, approvals.alerts) });
    } catch (err) {
      setLoad({ status: 'error', message: loadErrorText(err, 'alerts') });
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const all = load.status === 'ready' ? load.value : [];
  const rows = useMemo(() => all.filter((a) => passes(a, filter)).map((a) => alertRow(a, joins.nameOf)), [all, filter, joins]);

  return (
    <div className="pc-page" data-testid="commercial-alerts">
      <PageHead title="Alerts" intro={INTRO} />
      <div className="pf-toolbar">
        <div role="group" aria-label="Alert status" className="pf-seg">
          {ALERT_FILTERS.map(([k, label]) => (
            <Button key={k} unstyled aria-pressed={filter === k} className={filter === k ? 'pf-seg__btn pf-seg__btn--on' : 'pf-seg__btn'} onClick={() => setFilter(k)}>
              {label}
              <span className="pf-seg__count">{load.status === 'ready' ? all.filter((a) => passes(a, k)).length : '–'}</span>
            </Button>
          ))}
        </div>
      </div>
      <section className="pc-card" aria-label="Alerts">
        {load.status === 'loading' ? <LoadingRows label="Loading alerts…" /> : null}
        {load.status === 'error' ? <LoadFailed message={load.message} onRetry={() => void fetchAll()} /> : null}
        {load.status === 'ready' && rows.length > 0 ? (
          <div className="pc-scroll">
            <table className="pc-table pf-table pf-table--1040">
              <thead>
                <tr>
                  <th scope="col">Alert</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Opened</th>
                  <th scope="col">Status</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.alert.id} data-testid={`alert-${r.alert.id}`}>
                    <td>
                      <div className="pf-strong">{r.type}</div>
                      <div className="pf-slug">{r.ref}</div>
                    </td>
                    <td>
                      <Pill tone={r.severity.tone}>{r.severity.label}</Pill>
                    </td>
                    <td>
                      <Subject r={r} />
                    </td>
                    <td>
                      <span className="pf-stamp">{r.opened}</span>
                    </td>
                    <td>
                      <Pill tone={r.status.tone}>{r.status.label}</Pill>
                    </td>
                    <td>
                      <span className="pf-ink2">{r.detail}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {load.status === 'ready' && rows.length === 0 ? <Empty title={filter === 'resolved' ? 'No resolved alerts' : 'No open alerts'} body="Alerts appear here when a condition needs attention." /> : null}
        <div className="pf-foot">{ALERTS_FOOT}</div>
      </section>
    </div>
  );
}
