import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  Button,
  DataTable,
  InlineAlert,
  type TableColumn,
} from '@aramo/fe-foundation';

import { platformApi, type PlatformTenantSummary } from '../platform-api';

import { StatusBadge } from './status';

const STATUSES = ['', 'PROVISIONED', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED'];

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const COLUMNS: ReadonlyArray<TableColumn<PlatformTenantSummary>> = [
  {
    key: 'name',
    header: 'Tenant',
    render: (t) => (
      <Link className="rc-link-strong" to={`/tenants/${t.id}`}>
        <span className="rc-ent__nm">{t.name}</span>
      </Link>
    ),
  },
  {
    key: 'slug',
    header: 'Slug',
    render: (t) => <span className="mono">{t.slug ?? '—'}</span>,
  },
  { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
  { key: 'created_at', header: 'Created', render: (t) => fmtDate(t.created_at) },
  {
    key: 'changed',
    header: 'Last transition',
    render: (t) => fmtDate(t.status_changed_at),
  },
];

export function TenantsListView() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<PlatformTenantSummary[]>([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (statusFilter: string, query: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await platformApi.listTenants({
        status: statusFilter || undefined,
        q: query || undefined,
      });
      setTenants(res.tenants);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load tenants.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch when the status filter changes; the free-text search refetches on
  // submit (the form onSubmit), not per keystroke.
  useEffect(() => {
    void load(status, q);
  }, [status]);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Tenants</h1>
        <Button variant="primary" onClick={() => navigate('/tenants/new')}>
          Provision tenant
        </Button>
      </div>

      <form
        className="pw-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void load(status, q);
        }}
      >
        <select
          aria-label="Filter by status"
          className="tc-input"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ minWidth: 160 }}
        >
          {STATUSES.map((s) => (
            <option key={s || 'all'} value={s}>
              {s === '' ? 'All statuses' : s}
            </option>
          ))}
        </select>
        <input
          aria-label="Search name or slug"
          className="tc-input"
          placeholder="Search name or slug…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <Button variant="secondary" type="submit">
          Search
        </Button>
      </form>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <DataTable
        columns={COLUMNS}
        rows={tenants}
        rowKey={(t) => t.id}
        rowMuted={(t) => t.status === 'CLOSED' || t.status === 'OFFBOARDING'}
        onRowClick={(t) => navigate(`/tenants/${t.id}`)}
        emptyMessage={loading ? 'Loading…' : 'No tenants match.'}
      />
    </div>
  );
}
