import { useEffect, useState } from 'react';
import {
  InlineAlert,
  PageHeader,
  Table,
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
// Rows are non-navigating (no detail in R2). The S5c-3 #1 discovery gap
// (ruling 4) closes at a FUTURE recruiter-tier company-detail PR, NOT
// cross-app into the admin-tier S5c-3 assignments editor (different app
// / scope / intent — the editor stays admin-tier + deep-link-only).

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
    render: (c) => c.name,
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

export function CompaniesListView() {
  const [items, setItems] = useState<readonly CompanyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
