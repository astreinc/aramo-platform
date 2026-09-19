import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, DataTable, InlineAlert, type TableColumn } from '@aramo/fe-foundation';

import { skillsApi, type Proposal, type ProposalStatus } from './skills-api';
import { ProposalStatusBadge } from './ProposalStatusBadge';

// NOTE: no `session` prop — the proposal list has no scope-gated controls; the
// accept/reject decisions (platform:skill:manage) live on the detail page.

const STATUSES: Array<'' | ProposalStatus> = ['', 'PENDING', 'ACCEPTED', 'REJECTED'];

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

const COLUMNS: ReadonlyArray<TableColumn<Proposal>> = [
  {
    key: 'proposal_type',
    header: 'Type',
    render: (p) => (
      <Link className="rc-link-strong" to={`/skills/proposals/${p.id}`}>
        <span className="rc-ent__nm">{p.proposal_type}</span>
      </Link>
    ),
  },
  { key: 'source', header: 'Source', render: (p) => p.source },
  { key: 'status', header: 'Status', render: (p) => <ProposalStatusBadge status={p.status} /> },
  { key: 'proposed_at', header: 'Proposed', render: (p) => fmt(p.proposed_at) },
];

// SKILL-TAX-1F-C2 — the AI proposal work-list. Read surface (platform:skill:read);
// decisions live on the detail page and require platform:skill:manage. A proposal is
// never canonical truth until a human accepts it.
export function ProposalsListView() {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [status, setStatus] = useState<'' | ProposalStatus>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (s: '' | ProposalStatus) => {
    setLoading(true);
    setError(null);
    try {
      const res = await skillsApi.listProposals({ status: s || undefined, limit: 100 });
      setProposals(res.proposals);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load proposals.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Proposals</h1>
      </div>

      <div className="pw-toolbar">
        <select
          aria-label="Filter by status"
          className="tc-input"
          value={status}
          onChange={(e) => setStatus(e.target.value as '' | ProposalStatus)}
          style={{ minWidth: 160 }}
        >
          {STATUSES.map((s) => (
            <option key={s || 'all'} value={s}>
              {s === '' ? 'All statuses' : s}
            </option>
          ))}
        </select>
      </div>

      {error ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <DataTable
        columns={COLUMNS}
        rows={proposals}
        rowKey={(p) => p.id}
        rowMuted={(p) => p.status !== 'PENDING'}
        onRowClick={(p) => navigate(`/skills/proposals/${p.id}`)}
        emptyMessage={loading ? 'Loading…' : 'No proposals match.'}
      />
    </div>
  );
}
