import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ExceptionCountTile, Pill, WithheldAmount } from '../../components';
import { alertsApi } from '../alerts/alerts-api';

import { financeApi, type BillingCommand, type ReconciliationReport, type WebhookInboxEvent } from './finance-api';
import { commandRows, heldRows, hoursOf, inboxRows, mismatchRows, shortRef } from './finance-model';
import { Empty, LoadFailed, LoadingRows, PageHead, TenantLink, loadErrorText, requestHref, useJoins, type Load } from './finance-shared';

import '../commercial.css';
import './finance.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.3; v1.2 §17.1 D-2, §17.2; Commercial Control Plane
// v1.2.dc.html `is.recon`) — Finance › Billing reconciliation. READ-ONLY: every row links to its
// tenant (or its request), where the governed action lives (Conversion Rule C-9).
//   §1  subscriptions vs entitlements  — CCP-C6 reconciliation-report `subscriptions[].discrepancies`
//                                        and `entitled_without_subscription`
//   §2  held activations (C-8)         — the same report's `held_activations`
//   §3  Stripe commands and the inbox  — CCP-C1 billing-commands (FAILED; pending at the provider past
//                                        the configured threshold, TD-D3-2) and billing-webhook-inbox (FAILED)
// The Exceptions tile is the server's `counts.exceptions`, the only total on the page. The stuck
// threshold is read from configuration (GET /platform/commercial/metrics/billing `thresholds`).
// A command amount is shown as the server sent it: holders see it, others see WithheldAmount (R3).

const INTRO = 'Where commercial records, entitlements and Stripe disagree. Each row links to its tenant, where the governed action lives.';

interface Data {
  readonly report: ReconciliationReport;
  readonly failed: readonly BillingCommand[];
  readonly pending: readonly BillingCommand[];
  readonly inbox: readonly WebhookInboxEvent[];
  readonly stuckMinutes: number | null;
}

export function BillingReconciliationView({ now = () => new Date() }: { readonly now?: () => Date }) {
  const [load, setLoad] = useState<Load<Data>>({ status: 'loading' });
  const joins = useJoins({ workbench: true });

  const fetchAll = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      const [report, failed, pending, inbox, metrics] = await Promise.all([
        financeApi.reconciliation(),
        financeApi.commands('FAILED'),
        financeApi.commands('PENDING_PROVIDER'),
        financeApi.inbox('FAILED'),
        alertsApi.billingMetrics().catch(() => null),
      ]);
      setLoad({
        status: 'ready',
        value: { report, failed: failed.commands, pending: pending.commands, inbox: inbox.events, stuckMinutes: metrics?.thresholds.pending_provider_stuck_minutes ?? null },
      });
    } catch (err) {
      setLoad({ status: 'error', message: loadErrorText(err, 'the billing reconciliation') });
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const at = now();
  const v = load.status === 'ready' ? load.value : null;
  const mism = useMemo(() => (v === null ? [] : mismatchRows(v.report.subscriptions, v.report.entitled_without_subscription, at)), [v, at]);
  const held = useMemo(() => (v === null ? [] : heldRows(v.report.held_activations, joins.workbench)), [v, joins]);
  // Without the configured threshold no pending command is called stuck (fail closed: failed only).
  const cmds = useMemo(() => (v === null ? [] : commandRows(v.failed, v.stuckMinutes === null ? [] : v.pending, v.stuckMinutes ?? 0, at)), [v, at]);
  const inbox = useMemo(() => (v === null ? [] : inboxRows(v.inbox, [])), [v]);
  const stuckH = v?.stuckMinutes != null ? String(hoursOf(v.stuckMinutes)) : '—';
  const tenantOf = (id: string | null): string => (id === null ? '—' : (joins.nameOf(id) ?? shortRef(id)));

  return (
    <div className="pc-page" data-testid="finance-reconciliation">
      <PageHead title="Billing reconciliation" intro={INTRO} aside={v !== null ? <ExceptionCountTile count={v.report.counts.exceptions} /> : null} />
      {load.status === 'error' ? (
        <section className="pc-card">
          <LoadFailed message={load.message} onRetry={() => void fetchAll()} />
        </section>
      ) : null}
      <div className="pf-stack">
        <section className="pc-card" aria-labelledby="pf-rc-1">
          <div className="pf-card-head">
            <h2 id="pf-rc-1">Subscriptions, pinned versions and entitlements</h2>
            <p>Every open subscription should carry its product entitlement, and every active entitlement on a priced product should have an open subscription.</p>
          </div>
          {load.status === 'loading' ? <LoadingRows label="Loading the reconciliation…" /> : null}
          {v !== null && mism.length > 0 ? (
            <div className="pc-scroll">
              <table className="pc-table pf-table pf-table--980">
                <thead>
                  <tr>
                    <th scope="col">Tenant</th>
                    <th scope="col">Product</th>
                    <th scope="col">Subscription</th>
                    <th scope="col">Pinned version</th>
                    <th scope="col">Entitlement</th>
                    <th scope="col">Exception</th>
                  </tr>
                </thead>
                <tbody>
                  {mism.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <TenantLink id={r.tenantId}>{r.tenant}</TenantLink>
                      </td>
                      <td>{r.product}</td>
                      <td>{r.subscription}</td>
                      <td>
                        <span className="pf-mono12">{r.version}</span>
                      </td>
                      <td>{r.entitlement}</td>
                      <td>
                        <span className="pf-tag">{r.flag}</span>
                        <div className="pf-why">{r.why}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {v !== null && mism.length === 0 ? <Empty title="No mismatches" body="Subscriptions and entitlements agree." /> : null}
        </section>

        <section className="pc-card" aria-labelledby="pf-rc-2">
          <div className="pf-card-head">
            <h2 id="pf-rc-2">Held activations</h2>
            <p>A self-service checkout that would end a governed Manual subscription is held, never applied (conversion rule C-8).</p>
          </div>
          {v !== null && held.length > 0 ? (
            <div className="pc-scroll">
              <table className="pc-table pf-table pf-table--1000">
                <thead>
                  <tr>
                    <th scope="col">Tenant</th>
                    <th scope="col">Governed Manual row</th>
                    <th scope="col">Held self-service attempt</th>
                    <th scope="col">Held plan</th>
                    <th scope="col">Stripe command</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((h) => (
                    <tr key={h.key}>
                      <td>
                        <TenantLink id={h.tenantId}>{h.tenant}</TenantLink>
                      </td>
                      <td>{h.manual}</td>
                      <td>
                        {h.attempt}
                        <div className="pf-slug">{h.at}</div>
                      </td>
                      <td>{h.plan}</td>
                      <td>
                        <div className="pf-cmdstate">{h.cmd}</div>
                        <span className="pf-slug">{h.cmdSub}</span>{' '}
                        {h.crId !== null ? (
                          <Link className="pf-mono" to={requestHref(h.crId)}>
                            {shortRef(h.crId)}
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {v !== null && held.length === 0 ? <Empty title="No held activations" body="No self-service checkout is waiting behind a Manual subscription." /> : null}
        </section>

        <section className="pc-card" aria-labelledby="pf-rc-3">
          <div className="pf-card-head">
            <h2 id="pf-rc-3">Stripe command and webhook-inbox exceptions</h2>
            <p>Commands that failed, or stayed pending past the configured threshold ({stuckH} h), and inbox events that failed or stalled.</p>
          </div>
          <div className="pf-sublabel">Commands</div>
          {v !== null && cmds.length > 0 ? (
            <div className="pc-scroll">
              <table className="pc-table pf-table pf-table--900">
                <thead>
                  <tr>
                    <th scope="col">Command</th>
                    <th scope="col">Tenant</th>
                    <th scope="col">State</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Detail</th>
                    <th scope="col">Request</th>
                  </tr>
                </thead>
                <tbody>
                  {cmds.map((x) => (
                    <tr key={x.id} data-testid={`command-${x.id}`}>
                      <td>
                        <div className="pf-mono">{shortRef(x.id)}</div>
                        <div className="pf-sub">{x.kind}</div>
                        {x.amount?.kind === 'shown' ? <div className="pf-amt-line">{x.amount.text}</div> : null}
                        {x.amount?.kind === 'withheld' ? (
                          <div className="pf-amt-line">
                            <WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="cell" />
                          </div>
                        ) : null}
                      </td>
                      <td>{x.cmd.tenant_id !== null ? <TenantLink id={x.cmd.tenant_id}>{tenantOf(x.cmd.tenant_id)}</TenantLink> : '—'}</td>
                      <td>
                        <Pill tone={x.state.tone}>{x.state.label}</Pill>
                      </td>
                      <td>
                        <span className="pf-stamp">{x.at}</span>
                        <div className="pf-sub">{x.age}</div>
                      </td>
                      <td>
                        <span className="pf-ink2">{x.detail}</span>
                      </td>
                      <td>
                        {x.cmd.change_request_id !== null ? (
                          <Link className="pf-mono" to={requestHref(x.cmd.change_request_id)}>
                            {shortRef(x.cmd.change_request_id)}
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {v !== null && cmds.length === 0 ? <Empty title="No command exceptions" body="Every Stripe command confirmed in time." /> : null}
          <div className="pf-sublabel pf-sublabel--next">Webhook inbox</div>
          {v !== null && inbox.length > 0 ? (
            <div className="pc-scroll">
              <table className="pc-table pf-table pf-table--900">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Tenant</th>
                    <th scope="col">State</th>
                    <th scope="col">Received</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {inbox.map((x) => (
                    <tr key={x.ev.id}>
                      <td>
                        <div className="pf-mono">{x.ev.provider_event_id}</div>
                        <div className="pf-slug">{x.ev.event_type}</div>
                      </td>
                      <td>—</td>
                      <td>
                        <Pill tone={x.state.tone}>{x.state.label}</Pill>
                      </td>
                      <td>
                        <span className="pf-stamp">{x.at}</span>
                      </td>
                      <td>{x.attempts}</td>
                      <td>
                        <span className="pf-ink2">{x.detail}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {v !== null && inbox.length === 0 ? <Empty title="No inbox exceptions" body="Every webhook event processed." /> : null}
        </section>
      </div>
    </div>
  );
}
