import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasScope, type Session } from '@aramo/fe-foundation';

import { COMMERCIAL_PERMISSIONS, PaymentDueIndicator, Pill, WithheldAmount, paymentDueState } from '../../components';
import { supportExtensionApi, type SupportExtension } from '../support-extensions/support-extension-api';
import { subscriptionsApi } from '../subscriptions/subscriptions-api';

import { financeApi, type OutstandingReport } from './finance-api';
import { AMOUNT_NOT_YET, outstandingRows, shortRef } from './finance-model';
import { Empty, LoadFailed, LoadingRows, PageHead, SourceTag, TenantLink, loadErrorText, useJoins, type Load } from './finance-shared';

import '../commercial.css';
import './finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.2; v1.2 §17.2; Commercial Control Plane v1.2.dc.html
// `is.outstanding`) — Finance › Outstanding payments: past-due and incomplete subscriptions with
// their grace state (GET /platform/commercial/finance/outstanding-payments, CCP-C6,
// platform:billing:read). A support extension is an overlay that never moves billing dates.
//
// Amounts (CCP-A1 Amendment A1, LOCKED): a holder of platform:billing:amount:read gets
// `amount_due` (null in v1: invoice reads are not delivered, C3) and the "not yet available" banner;
// any other billing reader gets `amount_withheld`, the "Amounts withheld for your role" note and
// WithheldAmount in the cell. PaymentDueIndicator renders the server's FA-4 due booleans: the C6
// row does not carry them (MBC-V12-3), so they are read per listed tenant from the CCP-C3
// billing-status route, and shown only when that read is AVAILABLE (until C3 is delivered the
// booleans have no invoices behind them, so no due pill is shown rather than a false "Not due").

const INTRO = 'Past-due and incomplete subscriptions with their grace state. Support extensions are overlays: they add access time and never change billing dates.';

export interface OutstandingPaymentsViewProps {
  readonly session: Session;
}

export function OutstandingPaymentsView({ session }: OutstandingPaymentsViewProps) {
  const [load, setLoad] = useState<Load<OutstandingReport>>({ status: 'loading' });
  const [ext, setExt] = useState<ReadonlyMap<string, SupportExtension>>(new Map());
  const [due, setDue] = useState<ReadonlyMap<string, { payment_due: boolean; payment_overdue: boolean }>>(new Map());
  const joins = useJoins({ workbench: true });
  const amounts = hasScope(session, COMMERCIAL_PERMISSIONS.billingAmountRead);

  const fetchReport = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', value: await financeApi.outstanding() });
    } catch (err) {
      setLoad({ status: 'error', message: loadErrorText(err, 'outstanding payments') });
    }
  }, []);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  // The FA-4 due booleans of each listed tenant (CCP-C3 billing-status, AVAILABLE reads only).
  useEffect(() => {
    if (load.status !== 'ready') return;
    let cancelled = false;
    const tenants = [...new Set(load.value.items.map((i) => i.tenant_id))];
    void Promise.all(tenants.map((t) => subscriptionsApi.invoiceLink(t).then((b) => [t, b] as const, () => [t, null] as const))).then((pairs) => {
      if (cancelled) return;
      const m = new Map<string, { payment_due: boolean; payment_overdue: boolean }>();
      for (const [t, b] of pairs) if (b !== null && b.availability === 'AVAILABLE') m.set(t, { payment_due: b.payment_due, payment_overdue: b.payment_overdue });
      setDue(m);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // The live support-extension overlay of each listed tenant (CCP-B6 list read, per tenant).
  useEffect(() => {
    if (load.status !== 'ready') return;
    let cancelled = false;
    const tenants = [...new Set(load.value.items.map((i) => i.tenant_id))];
    void Promise.all(tenants.map((t) => supportExtensionApi.list(t).then((l) => [t, l.extensions] as const, () => [t, [] as SupportExtension[]] as const))).then((pairs) => {
      if (cancelled) return;
      const now = Date.parse(load.value.as_of);
      const m = new Map<string, SupportExtension>();
      for (const [t, list] of pairs) {
        const live = list.filter((e) => e.removed_at === null && (e.active ?? Date.parse(e.extends_until) > now)).sort((a, b) => Date.parse(b.applied_at) - Date.parse(a.applied_at))[0];
        if (live !== undefined) m.set(t, live);
      }
      setExt(m);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const rows = useMemo(() => (load.status === 'ready' ? outstandingRows(load.value.items, joins.workbench, joins.slugOf, new Date(load.value.as_of)) : []), [load, joins]);

  return (
    <div className="pc-page" data-testid="finance-outstanding">
      <PageHead title="Outstanding payments" intro={INTRO} />
      {!amounts ? (
        <div className="pf-note" role="note">
          <b>Amounts withheld for your role.</b> You can see whether each payment is due or overdue. Amounts need Finance access (amount-read).
        </div>
      ) : (
        <div className="pf-info" role="status">
          <b>Amount due not yet available.</b> Invoice reads are pending provider configuration: the Stripe portal settings aren’t verified yet. Amounts and invoice links appear here once they are.
        </div>
      )}
      <section className="pc-card" aria-label="Outstanding payments">
        {load.status === 'loading' ? <LoadingRows label="Loading outstanding payments…" /> : null}
        {load.status === 'error' ? <LoadFailed message={load.message} onRetry={() => void fetchReport()} /> : null}
        {load.status === 'ready' && rows.length > 0 ? (
          <div className="pc-scroll">
            <table className="pc-table pf-table pf-table--1080">
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Plan · version</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Grace until</th>
                  <th scope="col">Support extension</th>
                  <th scope="col">Amount due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const x = ext.get(r.item.tenant_id);
                  const flags = r.dueKnown ? r.item : due.get(r.item.tenant_id);
                  return (
                    <tr key={r.item.subscription_id} data-testid={`outstanding-${r.item.subscription_id}`}>
                      <td>
                        <TenantLink id={r.item.tenant_id}>{r.tenant}</TenantLink>
                        <div className="pf-slug">{r.slug}</div>
                      </td>
                      <td>{r.plan}</td>
                      <td>
                        <SourceTag badge={r.source} />
                      </td>
                      <td>
                        <Pill tone={r.status.tone}>{r.status.label}</Pill>
                      </td>
                      <td>
                        <span className="pf-nowrap">{r.grace}</span>
                        <div className="pf-sub">{r.graceSub}</div>
                      </td>
                      <td>
                        {x !== undefined ? (
                          <>
                            <Link className="pf-mono pf-mono--link" to={`/commercial/support-extensions?tenant=${encodeURIComponent(r.item.tenant_id)}`}>
                              EXT-{shortRef(x.id)} · +{x.days} days
                            </Link>
                            <div className="pf-sub">Overlay — billing dates unchanged</div>
                          </>
                        ) : (
                          <span className="pf-muted">None</span>
                        )}
                      </td>
                      <td data-testid="outstanding-amount">
                        {r.item.amount_withheld !== undefined ? <WithheldAmount reason={r.item.amount_withheld} size="cell" /> : <span className="pf-muted--sm">{AMOUNT_NOT_YET}</span>}
                        {flags !== undefined ? (
                          <div className="pf-due">
                            <PaymentDueIndicator state={paymentDueState(flags)} />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {load.status === 'ready' && rows.length === 0 ? <Empty title="Nothing outstanding" body="No subscription is past due or incomplete." /> : null}
      </section>
    </div>
  );
}
