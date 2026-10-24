import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, Select, hasScope, type Session } from '@aramo/fe-foundation';

import {
  EmptyState,
  PLATFORM_PERMISSIONS as P,
  Pill,
  SegmentedFilter,
  SkeletonPanel,
  TENANT_STATUS_PILL,
  formatDate,
  formatRelative,
  tenantStatusPill,
} from '../components';
import { platformApi, type PlatformTenantSummary } from '../platform-api';

import { reasonLabel } from './lifecycle-reasons';
import { kindLabel } from './tenant-labels';
import { WithSession } from './with-session';

import './tenants.css';

// PLATFORM-UX-1 F-4 (handoff §6.1) — the tenant estate list. Status, kind and
// search live in the URL (`?status&kind&q`), so a dashboard tile deep-links
// here. The estate is read once (GET /platform/tenants) and filtered, counted
// and sorted in the browser; server paging and sorting don't exist yet (R-13),
// so the pager reads "Showing 1–N of N" with Previous/Next disabled.

const STATUSES = Object.keys(TENANT_STATUS_PILL);
const KINDS = ['ALL', 'BUSINESS', 'PERSONAL'] as const;

export type SortKey = 'name' | 'kind' | 'slug' | 'status' | 'reason' | 'created' | 'last' | 'activated';
export interface SortState {
  readonly key: SortKey;
  /** 1 = ascending, -1 = descending. */
  readonly dir: 1 | -1;
}

const COLUMNS: readonly (readonly [SortKey, string])[] = [
  ['name', 'Tenant'],
  ['kind', 'Kind'],
  ['slug', 'Slug'],
  ['status', 'Status'],
  ['reason', 'Status reason'],
  ['created', 'Created'],
  ['last', 'Last transition'],
  ['activated', 'Activated'],
];

const SORT_VALUE: Readonly<Record<SortKey, (t: PlatformTenantSummary) => string | number>> = {
  name: (t) => t.name.toLowerCase(),
  kind: (t) => t.kind,
  slug: (t) => t.slug ?? '',
  status: (t) => STATUSES.indexOf(t.status),
  reason: (t) => t.status_reason_code ?? '',
  created: (t) => t.created_at,
  last: (t) => t.status_changed_at,
  activated: (t) => t.activated_at ?? '',
};

export interface TenantFilters {
  readonly status: string;
  readonly kind: string;
  readonly q: string;
}

/** Kind + search narrow the base set; the status segment counts are over that base. */
export function filterTenants(rows: readonly PlatformTenantSummary[], f: TenantFilters) {
  const q = f.q.trim().toLowerCase();
  const base = rows.filter(
    (t) =>
      (f.kind === 'ALL' || t.kind === f.kind) &&
      (q === '' || t.name.toLowerCase().includes(q) || (t.slug ?? '').includes(q)),
  );
  const visible = base.filter((t) => f.status === 'ALL' || t.status === f.status);
  const counts: Record<string, number> = { ALL: base.length };
  for (const s of STATUSES) counts[s] = base.filter((t) => t.status === s).length;
  return { visible, counts };
}

export function sortTenants(rows: readonly PlatformTenantSummary[], sort: SortState): PlatformTenantSummary[] {
  const value = SORT_VALUE[sort.key];
  return rows
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const A = value(a.t);
      const B = value(b.t);
      return (A < B ? -1 : A > B ? 1 : a.i - b.i) * (A === B ? 1 : sort.dir);
    })
    .map(({ t }) => t);
}

function readFilters(params: URLSearchParams): TenantFilters {
  const status = params.get('status') ?? 'ALL';
  const kind = params.get('kind') ?? 'ALL';
  return {
    status: status === 'ALL' || STATUSES.includes(status) ? status : 'ALL',
    kind: (KINDS as readonly string[]).includes(kind) ? kind : 'ALL',
    q: params.get('q') ?? '',
  };
}

export function TenantsListView({ session }: { readonly session?: Session } = {}) {
  return <WithSession session={session}>{(s) => <TenantsList session={s} />}</WithSession>;
}

function TenantsList({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const [rows, setRows] = useState<PlatformTenantSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'created', dir: -1 });
  const canProvision = hasScope(session, P.tenantProvision);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    setRows(null);
    try {
      const res = await platformApi.listTenants();
      setRows(res.tenants);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setFilter = (key: keyof TenantFilters, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '' || value === 'ALL') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const { visible, counts } = filterTenants(rows ?? [], filters);
  const sorted = sortTenants(visible, sort);

  const open = (t: PlatformTenantSummary): void => {
    void navigate(`/tenants/${t.id}`);
  };
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, t: PlatformTenantSummary): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(t);
    }
  };

  const n = sorted.length;
  return (
    <div className="pw-page">
      <div className="pt-head">
        <div>
          <h1 className="pt-h1">Tenants</h1>
          <p className="pt-intro">Every client organization on the platform, with its lifecycle status.</p>
        </div>
        {canProvision ? (
          <Button unstyled className="pw-btn pw-btn--normal" onClick={() => navigate('/tenants/new')}>
            + Provision tenant
          </Button>
        ) : null}
      </div>

      <div className="pw-filterbar">
        <SegmentedFilter
          label="Status"
          value={filters.status}
          onChange={(v) => setFilter('status', v)}
          options={[
            { value: 'ALL', label: 'All', count: counts['ALL'] },
            ...STATUSES.map((s) => ({ value: s, label: tenantStatusPill(s).label, count: counts[s] })),
          ]}
        />
        <Select
          unstyled
          aria-label="Kind"
          className="pt-select"
          value={filters.kind}
          onChange={(e) => setFilter('kind', e.target.value)}
        >
          <option value="ALL">All kinds</option>
          <option value="BUSINESS">Business</option>
          <option value="PERSONAL">Personal</option>
        </Select>
        <Input
          unstyled
          aria-label="Search name or slug"
          className="pt-search"
          placeholder="Search name or slug"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
        />
        <span className="pw-filterbar__count" role="status">
          {rows === null ? '' : `${n} ${n === 1 ? 'tenant' : 'tenants'}`}
        </span>
      </div>

      <div className="pt-card pt-card--clip">
        {failed ? (
          <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
            <span>
              <b>Couldn’t load tenants.</b>
            </span>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : null}
        {rows === null && !failed ? <SkeletonPanel lines={['100%', '92%', '96%', '88%']} /> : null}
        {rows !== null ? (
          <>
            <div className="pt-scroll">
              <table className="pt-table pt-list-table">
                <thead>
                  <tr>
                    {COLUMNS.map(([key, label]) => {
                      const on = sort.key === key;
                      return (
                        <th
                          key={key}
                          className="pt-sort-th"
                          aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}
                        >
                          <Button
                            unstyled
                            className={on ? 'pt-sort pt-sort--on' : 'pt-sort'}
                            onClick={() => setSort({ key, dir: on ? (sort.dir > 0 ? -1 : 1) : 1 })}
                          >
                            {label}
                            <span className="pt-sort__arrow" aria-hidden="true">
                              {on ? (sort.dir > 0 ? '↑' : '↓') : ''}
                            </span>
                          </Button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => {
                    const muted = t.status === 'CLOSED' || t.status === 'OFFBOARDING';
                    const pill = tenantStatusPill(t.status);
                    return (
                      <tr
                        key={t.id}
                        className={muted ? 'pt-row pt-row--muted' : 'pt-row'}
                        tabIndex={0}
                        aria-label={`Open ${t.name}`}
                        onClick={() => open(t)}
                        onKeyDown={(e) => onRowKey(e, t)}
                      >
                        <td className="pt-cell pt-cell--name">{t.name}</td>
                        <td className="pt-cell">{kindLabel(t.kind)}</td>
                        <td className="pt-cell pt-cell--slug">{t.slug ?? '—'}</td>
                        <td className="pt-cell">
                          <Pill tone={pill.tone}>{pill.label}</Pill>
                        </td>
                        <td className="pt-cell">{t.status_reason_code ? reasonLabel(t.status_reason_code) : '—'}</td>
                        <td className="pt-cell pt-nowrap">
                          {formatDate(t.created_at)}
                          <div className="pt-sub">{formatRelative(t.created_at)}</div>
                        </td>
                        <td className="pt-cell pt-nowrap">
                          {formatDate(t.status_changed_at)}
                          <div className="pt-sub">{formatRelative(t.status_changed_at)}</div>
                        </td>
                        <td className="pt-cell pt-nowrap">{formatDate(t.activated_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {n === 0 ? (
              <EmptyState
                size="lg"
                title="No tenants match these filters"
                action={
                  <Button
                    unstyled
                    className="pw-btn pw-btn--secondary pt-btn-32"
                    onClick={() => setParams(new URLSearchParams(), { replace: true })}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : null}
          </>
        ) : null}
        <div className="pt-pager">
          <span>{n > 0 ? `Showing 1–${n} of ${n}` : 'Showing 0 of 0'}</span>
          <span className="pt-pager__btns">
            <Button unstyled className="pt-pager__btn" disabled>
              Previous
            </Button>
            <Button unstyled className="pt-pager__btn" disabled>
              Next
            </Button>
          </span>
        </div>
      </div>
      <p className="pt-foot">Closed and offboarding tenants are shown muted. Sorting is applied in the browser.</p>
    </div>
  );
}
