import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, Button, Checkbox, Select } from '@aramo/fe-foundation';

import { Pill, SkeletonPanel } from '../../components';
import { catalogApi, type Catalog } from '../catalog/catalog-api';
import { planTitle } from '../catalog/catalog-model';

import { PRODUCT_KEYS_SHOWN, subscriptionsApi, type Workbench, type WorkbenchRow } from './subscriptions-api';
import {
  NO_FILTER,
  STATUS_SEGMENTS,
  commitmentCell,
  passesFilter,
  periodText,
  productLabel,
  rowFlags,
  segmentCounts,
  sourceBadge,
  statusView,
  catalogVersionOptions,
  versionOptions,
  versionText,
  type WorkbenchFilter,
} from './subscriptions-model';

import '../commercial.css';
import './subscriptions.css';

// CCP-B3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B3; CCP-UI v1.0 handoff §5.3;
// Commercial Control Plane v1.0.dc.html :150-182, :835-856) — Commercial › Subscriptions, the
// workbench of every base subscription across tenants (the latest row per tenant × product).
// READ-ONLY: a row opens Tenant › Commercial, where every action is a change request. Route gate
// `platform:subscription:read` (App.tsx, B1's commercialGate). No money is shown (A1-4a); a held
// activation is surfaced to operators as a Reconciliation flag (Conversion Rule C-8).

export interface SubscriptionsViewProps {
  /** Test seam: the clock. */
  readonly now?: () => Date;
}

type Load = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly value: Workbench };

const INTRO = 'Every open base subscription across tenants. MANUAL rows are governed contracts; SELF-SERVICE rows are owned by Stripe and read-only here.';

function loadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Your account can’t read subscriptions.';
  return 'Subscriptions couldn’t be loaded. Try again.';
}

export function SubscriptionsView({ now = () => new Date() }: SubscriptionsViewProps) {
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [f, setF] = useState<WorkbenchFilter>(NO_FILTER);
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  useEffect(() => {
    // The Plan version filter lists the catalog's published and retired versions (design `verOpts`);
    // without the catalog it falls back to the versions on the rows.
    let cancelled = false;
    catalogApi.getCatalog().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchRows = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      setLoad({ status: 'ready', value: await subscriptionsApi.workbench() });
    } catch (err) {
      setLoad({ status: 'error', message: loadError(err) });
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const at = now();
  const rows: readonly WorkbenchRow[] = load.status === 'ready' ? load.value.rows : [];
  const counts = useMemo(() => segmentCounts(rows, f, at), [rows, f, at]);
  const filtered = useMemo(() => rows.filter((r) => passesFilter(r, f, at)), [rows, f, at]);
  const versions = useMemo(() => (catalog ? catalogVersionOptions(catalog) : versionOptions(rows)), [catalog, rows]);
  const set = <K extends keyof WorkbenchFilter>(k: K, v: WorkbenchFilter[K]): void => setF((x) => ({ ...x, [k]: v }));

  const open = (r: WorkbenchRow): void => {
    void navigate(`/tenants/${encodeURIComponent(r.tenant.id)}?tab=commercial`);
  };
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, r: WorkbenchRow): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(r);
    }
  };

  return (
    <div className="pc-page" data-testid="commercial-subscriptions">
      <div className="pc-head">
        <h1 className="pc-h1">Subscriptions</h1>
        <p className="pc-intro">{INTRO}</p>
      </div>

      <div className="cs-filters">
        <div role="group" aria-label="Status" className="cs-seg">
          {STATUS_SEGMENTS.map(([k, label]) => (
            <Button key={k} unstyled aria-pressed={f.status === k} className={f.status === k ? 'cs-seg__btn cs-seg__btn--on' : 'cs-seg__btn'} onClick={() => set('status', k)}>
              {label}
              <span className="cs-seg__count">{load.status === 'ready' ? counts[k] : '–'}</span>
            </Button>
          ))}
        </div>
        <Select unstyled aria-label="Product" className="cs-select" value={f.product} onChange={(e) => set('product', e.target.value)}>
          <option value="all">All products</option>
          {PRODUCT_KEYS_SHOWN.map((k) => (
            <option key={k} value={k}>
              {productLabel(k)}
            </option>
          ))}
        </Select>
        <Select unstyled aria-label="Source" className="cs-select" value={f.source} onChange={(e) => set('source', e.target.value as WorkbenchFilter['source'])}>
          <option value="all">All sources</option>
          <option value="MANUAL">Manual (contract)</option>
          <option value="SELF_SERVICE">Self-service (Stripe)</option>
        </Select>
        <Select unstyled aria-label="Plan version" className="cs-select" value={f.version} onChange={(e) => set('version', e.target.value)}>
          <option value="all">All plan versions</option>
          {versions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Select unstyled aria-label="Commitment ending" className="cs-select" value={f.commitment} onChange={(e) => set('commitment', e.target.value as WorkbenchFilter['commitment'])}>
          <option value="any">Any commitment end</option>
          <option value="30">Ending in 30 days</option>
          <option value="60">Ending in 60 days</option>
          <option value="90">Ending in 90 days</option>
        </Select>
        <label className="cs-check">
          <Checkbox unstyled className="cs-check__box" checked={f.flagged} onChange={(e) => set('flagged', e.target.checked)} />
          Has reconciliation flag
        </label>
        <span className="cs-count" data-testid="subscriptions-count">
          {load.status === 'ready' ? `${filtered.length} of ${rows.length}` : ''}
        </span>
      </div>

      <section className="pc-card" aria-label="Subscriptions">
        {load.status === 'loading' ? <SkeletonPanel label="Loading subscriptions…" lines={['40%', '85%', '70%']} /> : null}
        {load.status === 'error' ? (
          <div role="alert" className="pw-alert pw-alert--error pc-card__alert">
            <span>{load.message}</span>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30" onClick={() => void fetchRows()}>
              Try again
            </Button>
          </div>
        ) : null}
        {load.status === 'ready' && filtered.length > 0 ? (
          <div className="pc-scroll">
            <table className="pc-table cs-table">
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Product · plan</th>
                  <th scope="col">Version</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Period · grace</th>
                  <th scope="col">Commitment end</th>
                  <th scope="col">Flags</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const st = statusView(r, at);
                  const src = sourceBadge(r);
                  const cm = commitmentCell(r, at);
                  return (
                    <tr key={r.subscription_id} className="pc-row" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => onRowKey(e, r)} aria-label={`${r.tenant.name ?? r.tenant.id}, ${productLabel(r.product_key)}: open Tenant › Commercial`}>
                      <td>
                        <div className="cs-strong">{r.tenant.name ?? r.tenant.id}</div>
                        <div className="cs-slug">{r.tenant.slug ?? '—'}</div>
                      </td>
                      <td>
                        {productLabel(r.product_key)}
                        <div className="cs-plan">{planTitle(r.plan)}</div>
                      </td>
                      <td className="cs-mono12">{versionText(r)}</td>
                      <td className="pc-nowrap">
                        <span className={src.stripe ? 'cs-src cs-src--stripe' : 'cs-src'}>{src.label}</span>
                      </td>
                      <td>
                        <Pill tone={st.tone}>{st.label}</Pill>
                      </td>
                      <td className="pc-nowrap">
                        {periodText(r)}
                        <div className={st.tone === 'ok' ? 'cs-sub' : 'cs-sub cs-sub--warn'}>{st.line}</div>
                      </td>
                      <td className="pc-nowrap">
                        {cm.date}
                        <div className="cs-sub">{cm.rel}</div>
                      </td>
                      <td>
                        <div className="cs-flags">
                          {rowFlags(r).map((fl) => (
                            <span key={fl.label} className={`cs-flag cs-flag--${fl.kind}`}>
                              {fl.label}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {load.status === 'ready' && filtered.length === 0 ? (
          <div className="cs-empty">
            <b>No subscriptions match these filters</b>
            <div className="cs-empty__body">Change or clear a filter to see more.</div>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34 cs-empty__action" onClick={() => setF(NO_FILTER)}>
              Clear filters
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
