import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  DataTable,
  InlineAlert,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  portalApi,
  type PortalDisputeMutation,
  type PortalDisputeStatus,
} from '../portal-api';

// Portal P3c (§PR-3) — the talent's own disputes. A flat list (status +
// opened_at) linking to each dispute's detail. An empty list is a VALID state
// (nothing disputed), shown honestly — never fabricated density.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Talent-visible lifecycle labels (directive ruling 4). No internal queue
// state, no tenant/reviewer identity — the talent sees only their own outcome.
export const DISPUTE_STATUS_LABELS: Record<PortalDisputeStatus, string> = {
  OPEN: 'Open',
  UNDER_REVIEW: 'Under review',
  RESOLVED_CORRECTED: 'Resolved — corrected',
  RESOLVED_UPHELD: 'Resolved — unchanged',
  WITHDRAWN: 'Withdrawn',
};

const COLUMNS: ReadonlyArray<TableColumn<PortalDisputeMutation>> = [
  {
    key: 'status',
    header: 'Status',
    render: (d) => (
      <Link className="rc-link-strong" to={`/disputes/${d.dispute_id}`}>
        {DISPUTE_STATUS_LABELS[d.status] ?? d.status}
      </Link>
    ),
  },
  { key: 'opened', header: 'Opened', render: (d) => fmtDate(d.opened_at) },
];

export function DisputesListView() {
  const [disputes, setDisputes] = useState<PortalDisputeMutation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await portalApi.listDisputes();
      setDisputes(res.disputes);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load your disputes.',
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
        <h1 className="po-page__title">Your disputes</h1>
        <Link className="rc-link-strong" to="/verifications">
          Your verified identity →
        </Link>
      </div>
      <p className="po-page__lede">
        Disputes you have raised. A person reviews each one.
      </p>
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}
      <DataTable
        columns={COLUMNS}
        rows={disputes ?? []}
        rowKey={(d) => d.dispute_id}
        emptyMessage={
          loading ? 'Loading…' : 'You have not raised any disputes.'
        }
      />
    </div>
  );
}
