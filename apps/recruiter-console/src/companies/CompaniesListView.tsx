import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  InlineAlert,
  PageHeader,
  Table,
  hasScope,
  useSession,
  type Session,
  type TableColumn,
} from '@aramo/fe-foundation';

import { listCompanies } from './companies-api';
import { listErrorMessage } from './error-messages';
import type { CompanyView } from './types';

// R2 — the companies LIST. D4b VISIBILITY-RESOLVED framing (ruling 1):
// the BE returns only the recruiter's visible clients (direct ∪
// transitive-reports[≤3] ∪ pod-clients ∪ [ALL if company:read:all]). The
// header / empty-state copy reflects that honestly. NO inline limitation
// note (ruling 3) — a visible-only LIST is correct behavior, NOT a
// workflow gap (unlike the S5c-3 picker).
//
// Large-table treatment (ruling 5): mirrors the Talent LIST cap banner.
// Cursor pagination is a backend-first carry.
//
// R3 — the primary-name cell renders a <Link> to /companies/:id. Ruling
// 5: row-nav is a column-content change (not a Table rowHref prop) so
// the frozen foundation Table stays untouched. The S5c-3 #1 discovery
// gap closes at the recruiter-tier company-detail (R3) — NOT cross-app
// into the admin-tier S5c-3 assignments editor.

// Mirrors the BE default cap (libs/company/src/lib/company.repository.ts
// listForActor()).
const DEFAULT_LIST_CAP = 50;

function location(c: CompanyView): string {
  const city = c.city?.trim() ?? '';
  const state = c.state?.trim() ?? '';
  if (city === '' && state === '') return '—';
  if (city === '') return state;
  if (state === '') return city;
  return `${city}, ${state}`;
}

function display(value: string | null): string {
  return value === null || value === '' ? '—' : value;
}

function truncate(value: string | null, max: number): string {
  if (value === null || value === '') return '—';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const columns: ReadonlyArray<TableColumn<CompanyView>> = [
  {
    key: 'name',
    header: 'Name',
    render: (c) => <Link to={`/companies/${c.id}`}>{c.name}</Link>,
  },
  {
    key: 'location',
    header: 'Location',
    render: (c) => location(c),
  },
  {
    key: 'key_technologies',
    header: 'Key technologies',
    render: (c) => (
      <span title={c.key_technologies ?? undefined}>
        {truncate(c.key_technologies, 60)}
      </span>
    ),
  },
  {
    key: 'phone',
    header: 'Phone',
    render: (c) => display(c.phone1),
  },
  {
    key: 'is_hot',
    header: 'Hot',
    width: '80px',
    render: (c) => (c.is_hot ? 'Yes' : ''),
  },
];

interface CompaniesListViewProps {
  // R4-style test seam — pass a fixed session so the "+ New company"
  // gate is exercisable in tests without mounting the real session hook.
  readonly sessionOverride?: Session;
}

export function CompaniesListView({ sessionOverride }: CompaniesListViewProps = {}) {
  const [items, setItems] = useState<readonly CompanyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  // Defensive: a global fetch mock for the LIST endpoint can leak into
  // the session probe in tests. Guard so an unparseable session can't
  // crash render (R4 RequisitionsListView precedent).
  const canCreate =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'company:create');

  useEffect(() => {
    let cancelled = false;
    listCompanies()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(listErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const truncated = items.length >= DEFAULT_LIST_CAP;

  return (
    <section>
      <PageHeader
        title="Companies"
        description="Your visible clients — the companies you can see through assignments, reports, or pod-client teams."
      />
      <div className="companies-list__toolbar">
        {canCreate ? (
          <Link to="/companies/new" className="companies-list__new-link">
            + New company
          </Link>
        ) : null}
      </div>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {loading ? (
        <p>Loading companies…</p>
      ) : (
        <>
          {truncated ? (
            <p role="status" data-testid="companies-cap-banner">
              Showing first {DEFAULT_LIST_CAP} companies. More may exist beyond
              this page; cursor pagination is on the roadmap.
            </p>
          ) : null}
          <Table<CompanyView>
            columns={columns}
            rows={items}
            rowKey={(c) => c.id}
            emptyMessage="No companies visible to you yet."
          />
        </>
      )}
    </section>
  );
}
