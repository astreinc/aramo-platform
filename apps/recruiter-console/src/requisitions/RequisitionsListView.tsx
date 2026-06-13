import {
  Button,
  InlineAlert,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listCompanies } from '../companies/companies-api';
import {
  Card,
  DataTable,
  FilterChip,
  ScopedSearch,
  StatusPill,
  TitleCell,
  Toolbar,
  type PillTone,
  type TableColumn,
} from '../ui';

import { listRequisitions } from './requisitions-api';
import { listErrorMessage } from './error-messages';
import {
  isClosedStatus,
  type RequisitionStatus,
  type RequisitionView,
} from './types';

// Requisitions LIST (2C) — re-skinned to the Confident Blue mockup. The
// recruiter's visible reqs (D4b server-side; invisible→404 on detail).
// Active-filtered by default with chips (All / Only mine / Only hot), a
// "Show closed" toggle, and a client-side scoped search. The approved
// DataTable carries an in-cell <Link> (a11y nav) + mouse-only row-click.
//
// Gap dispositions (DDR §11): per-req Pipeline/Submitted counts are NOT in
// the list response → omitted (CARRY). Recruiter-name needs a non-admin
// roster → omitted (CARRY). company_id resolved to a name (gap #8) — never
// a UUID. No fabricated fields.

const STATUS_LABEL: Record<RequisitionStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  full: 'Full',
  closed: 'Closed',
  canceled: 'Canceled',
  lead: 'Intake',
};

const STATUS_TONE: Record<RequisitionStatus, PillTone> = {
  active: 'ok',
  lead: 'neutral',
  on_hold: 'warn',
  full: 'brand',
  closed: 'neutral',
  canceled: 'danger',
};

type FilterMode = 'all' | 'mine' | 'hot';

interface RequisitionsListViewProps {
  readonly sessionOverride?: Session;
}

export function RequisitionsListView({
  sessionOverride,
}: RequisitionsListViewProps = {}) {
  const [items, setItems] = useState<readonly RequisitionView[]>([]);
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [mode, setMode] = useState<FilterMode>('all');
  const [query, setQuery] = useState('');

  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'requisition:create');
  const myId = session?.sub ?? null;

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listRequisitions(), listCompanies()]).then(
      ([reqRes, coRes]) => {
        if (cancelled) return;
        if (reqRes.status === 'fulfilled') {
          setItems(reqRes.value.items);
        } else {
          setError(listErrorMessage(reqRes.reason));
        }
        if (coRes.status === 'fulfilled') {
          const map: Record<string, string> = {};
          for (const c of coRes.value.items) map[c.id] = c.name;
          setCompanyNames(map);
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((r) => {
      if (!showClosed && isClosedStatus(r.status)) return false;
      if (mode === 'hot' && !r.is_hot) return false;
      if (mode === 'mine' && r.recruiter_id !== myId && r.owner_id !== myId) {
        return false;
      }
      if (q !== '') {
        const hay = `${r.title} ${companyNames[r.company_id] ?? ''} ${
          r.external_req_id ?? ''
        }`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, showClosed, mode, query, myId, companyNames]);

  const openCount = items.filter((r) => !isClosedStatus(r.status)).length;

  const columns: ReadonlyArray<TableColumn<RequisitionView>> = [
    {
      key: 'title',
      header: 'Requisition',
      render: (r) => (
        <Link to={`/requisitions/${r.id}`} className="rc-link-strong">
          <TitleCell
            name={r.title}
            subtitle={companySubtitle(r, companyNames)}
            hot={r.is_hot}
          />
        </Link>
      ),
    },
    { key: 'type', header: 'Type', render: (r) => r.type ?? '—' },
    { key: 'location', header: 'Location', render: (r) => locationOf(r) },
    {
      key: 'openings',
      header: 'Openings',
      align: 'right',
      render: (r) => (
        <span className="num">
          {r.openings - r.openings_available}/{r.openings}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.is_hot ? (
          <StatusPill tone="hot">Hot</StatusPill>
        ) : (
          <StatusPill tone={STATUS_TONE[r.status]} dot>
            {STATUS_LABEL[r.status]}
          </StatusPill>
        ),
    },
  ];

  return (
    <section>
      <div className="rc-viewhead">
        <div>
          <h1 className="rc-h1">Requisitions</h1>
          <p className="rc-sub">
            {openCount} open · {items.length} visible
          </p>
        </div>
        {canCreate ? (
          <div className="rc-viewhead__actions">
            <Link to="/requisitions/new">
              <Button variant="primary">New requisition</Button>
            </Link>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : null}

      <Card flush className="rc-mt-16">
        <Toolbar>
          <FilterChip active={mode === 'all'} onClick={() => setMode('all')}>
            All
          </FilterChip>
          <FilterChip active={mode === 'mine'} onClick={() => setMode('mine')}>
            Only mine
          </FilterChip>
          <FilterChip active={mode === 'hot'} onClick={() => setMode('hot')}>
            Only hot
          </FilterChip>
          <FilterChip
            active={showClosed}
            onClick={() => setShowClosed((s) => !s)}
          >
            Show closed
          </FilterChip>
          <ScopedSearch
            placeholder="Search requisitions"
            value={query}
            onChange={setQuery}
          />
        </Toolbar>
        {loading ? (
          <p className="rc-empty">Loading requisitions…</p>
        ) : (
          <DataTable<RequisitionView>
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.id}
            emptyMessage={
              items.length === 0
                ? 'No requisitions visible to you yet.'
                : 'No requisitions match these filters.'
            }
          />
        )}
      </Card>
    </section>
  );
}

function companySubtitle(
  r: RequisitionView,
  names: Record<string, string>,
): string {
  const company = names[r.company_id];
  const code = r.external_req_id;
  if (company != null && code != null) return `${company} · ${code}`;
  return company ?? code ?? '';
}

function locationOf(r: RequisitionView): string {
  const place = [r.city, r.state].filter(Boolean).join(', ');
  const remote =
    r.work_arrangement === 'remote'
      ? 'Remote'
      : r.work_arrangement === 'hybrid'
        ? 'Hybrid'
        : null;
  if (place && remote) return `${place} · ${remote}`;
  return place || remote || '—';
}
