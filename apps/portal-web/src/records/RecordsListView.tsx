import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  DataTable,
  InlineAlert,
  type TableColumn,
} from '@aramo/fe-foundation';

import { portalApi, type PortalRecordProfile } from '../portal-api';

// Portal P1 PR-3 — the records list (engagement surface, P-R5). The talent's own
// records across every tenant that holds them. This is also the link-consumed
// landing (the backend consume redirects here authenticated). An empty list is a
// VALID state (a portal user with no live records), shown as an honest empty
// message — never fabricated density.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// tenant_name is deferred (PR-2a, P2 ledger) — the envelope carries tenant_id
// only, so the counterparty is shown as its id until the name lands.
const COLUMNS: ReadonlyArray<TableColumn<PortalRecordProfile>> = [
  {
    key: 'organization',
    header: 'Organization',
    render: (r) => (
      <Link className="rc-link-strong" to={`/records/${r.talent_id}`}>
        <span className="po-mono">{r.tenant_id}</span>
      </Link>
    ),
  },
  { key: 'status', header: 'Status', render: (r) => r.tenant_status },
  { key: 'channel', header: 'How you joined', render: (r) => r.source_channel },
  { key: 'since', header: 'Since', render: (r) => fmtDate(r.created_at) },
];

export function RecordsListView() {
  const [records, setRecords] = useState<PortalRecordProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await portalApi.listRecords();
      setRecords(res.records);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load your records.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="po-page">
      <div className="po-page__head">
        <h1 className="po-page__title">Your records</h1>
      </div>
      <p className="po-page__lede">
        The organizations that hold a record for you on Aramo.
      </p>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}
      <DataTable
        columns={COLUMNS}
        rows={records ?? []}
        rowKey={(r) => `${r.tenant_id}:${r.talent_id}`}
        emptyMessage={
          loading ? 'Loading…' : 'You have no records on Aramo yet.'
        }
      />
    </div>
  );
}
