import type { Session } from '@aramo/fe-foundation';
import { Link, useNavigate } from 'react-router-dom';

import { PIPELINE_STATUS_VALUES } from '../pipeline/types';
import { RecruiterShell } from '../shell/RecruiterShell';

import {
  Card,
  CardHead,
  DataTable,
  EntityCell,
  ProgressMini,
  StagePill,
  StatusPill,
  type TableColumn,
} from './index';

// ShellPreview — DEV-only 2A harness. Mounts the REAL RecruiterShell (the
// app-layer chrome that replaced the frozen Shell) with a fabricated session
// and a sample requisition list, so the shell swap can be reviewed without the
// auth backend. Not shipped to production (DEV-gated route in App.tsx).

const PREVIEW_SESSION: Session = {
  sub: 'preview-user',
  consumer_type: 'recruiter',
  tenant_id: 'preview-tenant',
  scopes: [
    'dashboard:read',
    'requisition:read',
    'talent:read',
    'company:read',
    'task:read',
  ],
  iat: 0,
  exp: 0,
};

interface ReqRow {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly code: string;
  readonly inPipeline: number;
  readonly submitted: number;
  readonly openingsFilled: number;
  readonly openings: number;
  readonly hot: boolean;
  readonly stage: (typeof PIPELINE_STATUS_VALUES)[number];
}

const ROWS: readonly ReqRow[] = [
  { id: '2041', title: 'Senior Rust Engineer', company: 'Northwind Robotics', code: 'REQ-2041', inPipeline: 14, submitted: 3, openingsFilled: 1, openings: 3, hot: true, stage: 'interviewing' },
  { id: '2038', title: 'Data Platform Lead', company: 'Cobalt Health', code: 'REQ-2038', inPipeline: 9, submitted: 2, openingsFilled: 0, openings: 1, hot: false, stage: 'submitted' },
  { id: '2049', title: 'Staff Frontend Engineer', company: 'Lumen Pay', code: 'REQ-2049', inPipeline: 4, submitted: 0, openingsFilled: 0, openings: 1, hot: false, stage: 'qualifying' },
];

export function ShellPreview() {
  const navigate = useNavigate();

  const columns: ReadonlyArray<TableColumn<ReqRow>> = [
    {
      key: 'title',
      header: 'Requisition',
      render: (r) => (
        // The primary cell carries the real focusable anchor (a11y nav path).
        <Link to={`/requisitions/${r.id}`} className="rc-link-strong">
          <EntityCell name={r.title} subtitle={`${r.company} · ${r.code}`} hot={r.hot} />
        </Link>
      ),
    },
    {
      key: 'pipeline',
      header: 'Pipeline',
      render: (r) => <ProgressMini value={r.inPipeline} max={20} count={r.inPipeline} ariaLabel="Pipeline size" />,
    },
    { key: 'stage', header: 'Stage', render: (r) => <StagePill status={r.stage} /> },
    { key: 'submitted', header: 'Submitted', align: 'right', render: (r) => r.submitted },
    {
      key: 'openings',
      header: 'Openings',
      align: 'right',
      render: (r) => `${r.openingsFilled}/${r.openings}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.hot ? (
          <StatusPill tone="hot">Hot</StatusPill>
        ) : (
          <StatusPill tone="ok" dot>
            Open
          </StatusPill>
        ),
    },
  ];

  return (
    <RecruiterShell session={PREVIEW_SESSION}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>
        Requisitions
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 18 }}>
        2A preview — the real app shell (scope-gated rail, breadcrumb, logout)
        with the app-layer DataTable (linked rows + mouse row-click).
      </p>
      <Card flush>
        <CardHead title="My open requisitions" />
        <DataTable<ReqRow>
          columns={columns}
          rows={ROWS}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/requisitions/${r.id}`)}
          emptyMessage="No open requisitions."
        />
      </Card>
    </RecruiterShell>
  );
}
