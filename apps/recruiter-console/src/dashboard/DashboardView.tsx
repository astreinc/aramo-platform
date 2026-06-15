import { InlineAlert } from '@aramo/fe-foundation';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { listCompanies } from '../companies/companies-api';
import { listAllPipelines } from '../pipeline/pipeline-api';
import { rollupByRequisition, type ReqPipelineCount } from '../pipeline/rollup';
import { listRequisitions } from '../requisitions/requisitions-api';
import {
  isClosedStatus,
  type RequisitionStatus,
  type RequisitionView,
} from '../requisitions/types';
import { listMyTasks } from '../task/task-api';
import type { TaskOwnerType, TaskView } from '../task/types';
import {
  ActionItem,
  ActivityFeed,
  Card,
  CardHead,
  DataTable,
  Icons,
  MetricCard,
  StatusPill,
  TitleCell,
  type ActivityFeedItem,
  type PillTone,
  type TableColumn,
} from '../ui';

import { getDashboard } from './dashboard-api';
import { dashboardErrorMessage } from './error-messages';
import {
  ACTIVITY_TYPE_LABELS,
  REQUISITION_STATUS_LABELS,
  type DashboardView as DashboardViewModel,
} from './types';

// My Desk (2B) — the recruiter-home landing. Re-skinned to the Confident
// Blue "My desk" mockup, wired to REAL data with NO fabricated fields:
//   - GET /v1/dashboard      → talent count, pipeline total, placements,
//                              recent-activity feed (visibility-scoped server-side)
//   - GET /v1/requisitions   → "my open reqs" table + derived open/hot counts
//   - GET /v1/tasks?me       → "needs you today" action list (gap #7 aggregation)
//   - GET /v1/companies      → company-id → name resolution (gap #8; never a UUID)
//
// Gap dispositions held (DDR §11): metric cards carry NO deltas/goals and NO
// unmodelled windows (no "+8 this week", no Submittals·wk, no Placements·MTD).
// Per-req Pipeline/Submitted counts are backed by a single unfiltered
// /v1/pipelines call grouped by requisition_id (shared rollupByRequisition;
// no N+1). "Needs you today" aggregates the backed source (my open tasks);
// responded-engagements / overdue-follow-ups have no list endpoint → CARRY.
// The four fetches degrade independently (allSettled): a 403 on tasks/companies
// leaves the page coherent; only a dashboard failure is the page error.

const STATUS_TONE: Record<RequisitionStatus, PillTone> = {
  active: 'ok',
  lead: 'neutral',
  on_hold: 'warn',
  full: 'brand',
  closed: 'neutral',
  canceled: 'danger',
};

const OWNER_ROUTE: Record<TaskOwnerType, string | null> = {
  requisition: '/requisitions',
  talent_record: '/talent',
  company: '/companies',
  contact: null, // no recruiter contact-detail route yet (carried)
};

const OWNER_LABEL: Record<TaskOwnerType, string> = {
  requisition: 'Requisition',
  talent_record: 'Talent',
  company: 'Company',
  contact: 'Contact',
};

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function relativeTime(iso: string): string {
  const days = daysSince(iso);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return weeks < 5 ? `${weeks}w ago` : `${Math.floor(days / 30)}mo ago`;
}

function isOverdue(due: string | null): boolean {
  if (due === null) return false;
  const d = new Date(due).getTime();
  return !Number.isNaN(d) && d < Date.now();
}

export function DashboardView() {
  const [dash, setDash] = useState<DashboardViewModel | null>(null);
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<readonly TaskView[]>([]);
  const [pipelineCounts, setPipelineCounts] = useState<
    Record<string, ReqPipelineCount>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.allSettled([
      getDashboard(),
      listRequisitions(),
      listMyTasks('open'),
      listCompanies(),
      listAllPipelines(),
    ]).then(([dashRes, reqRes, taskRes, coRes, pipeRes]) => {
      if (cancelled) return;
      if (dashRes.status === 'fulfilled') {
        setDash(dashRes.value);
      } else {
        setError(dashboardErrorMessage(dashRes.reason));
      }
      if (reqRes.status === 'fulfilled') setReqs(reqRes.value.items);
      if (taskRes.status === 'fulfilled') setTasks(taskRes.value.items);
      if (coRes.status === 'fulfilled') {
        const map: Record<string, string> = {};
        for (const c of coRes.value.items) map[c.id] = c.name;
        setCompanyNames(map);
      }
      if (pipeRes.status === 'fulfilled') {
        setPipelineCounts(rollupByRequisition(pipeRes.value.items));
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="rc-muted-line">Loading your desk…</p>;
  }
  if (error !== null) {
    return <InlineAlert variant="error">{error}</InlineAlert>;
  }

  const openReqs = reqs.filter((r) => !isClosedStatus(r.status));
  const hotCount = openReqs.filter((r) => r.is_hot).length;

  const reqColumns: ReadonlyArray<TableColumn<RequisitionView>> = [
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
    {
      key: 'pipeline',
      header: 'Pipeline',
      align: 'right',
      render: (r) => <span className="num">{pipelineCounts[r.id]?.active ?? 0}</span>,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      align: 'right',
      render: (r) => (
        <span className="num">{pipelineCounts[r.id]?.submitted ?? 0}</span>
      ),
    },
    {
      key: 'days',
      header: 'Days open',
      align: 'right',
      render: (r) => <span className="num">{daysSince(r.created_at)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.is_hot ? (
          <StatusPill tone="hot">Hot</StatusPill>
        ) : (
          <StatusPill tone={STATUS_TONE[r.status]} dot>
            {REQUISITION_STATUS_LABELS[r.status]}
          </StatusPill>
        ),
    },
  ];

  const activityItems: readonly ActivityFeedItem[] = (
    dash?.recent_activity ?? []
  ).map((a) => ({
    id: a.id,
    text: a.notes ?? ACTIVITY_TYPE_LABELS[a.type] ?? a.type,
    when: relativeTime(a.created_at),
  }));

  return (
    <section>
      <div className="rc-viewhead">
        <h1 className="rc-h1">My desk</h1>
        <p className="rc-sub">{deskSummary(tasks.length, hotCount)}</p>
      </div>

      <div className="rc-metrics rc-metrics--spaced">
        <MetricCard
          icon={<Icons.IconRequisitions />}
          label="Open reqs"
          value={openReqs.length}
          hint={hotCount > 0 ? `${hotCount} hot` : undefined}
        />
        <MetricCard
          icon={<Icons.IconTalent />}
          label="Talent"
          value={dash?.tenant_counts.talent_records ?? 0}
        />
        <MetricCard
          icon={<Icons.IconActivity />}
          label="In pipeline"
          value={dash?.pipeline_rollup.total ?? 0}
        />
        <MetricCard
          icon={<Icons.IconTasks />}
          label="Placements"
          value={dash?.placement.placed_pipelines ?? 0}
          hint="in your view"
        />
      </div>

      <div className="rc-grid2">
        <div className="rc-stack">
          <Card flush>
            <CardHead title="Needs you today" />
            {tasks.length === 0 ? (
              <p className="rc-empty">Nothing needs you right now.</p>
            ) : (
              tasks.map((t) => (
                <ActionItem
                  key={t.id}
                  kind={isOverdue(t.due_date) ? 'overdue' : 'task'}
                  title={t.title}
                  context={OWNER_LABEL[t.owner_type]}
                  time={t.due_date !== null ? formatDue(t.due_date) : undefined}
                  action={taskAction(t)}
                />
              ))
            )}
          </Card>

          <Card flush>
            <CardHead
              title="My open reqs"
              actions={
                <Link to="/requisitions" className="rc-card__head-more">
                  All requisitions
                </Link>
              }
            />
            <DataTable<RequisitionView>
              columns={reqColumns}
              rows={openReqs}
              rowKey={(r) => r.id}
              emptyMessage="No open requisitions in your view."
            />
          </Card>
        </div>

        <aside>
          <Card>
            <CardHead title="Activity" />
            {activityItems.length === 0 ? (
              <p className="rc-empty">No recent activity.</p>
            ) : (
              <div className="rc-feed-wrap">
                <ActivityFeed items={activityItems} />
              </div>
            )}
          </Card>
        </aside>
      </div>
    </section>
  );
}

// --- presentational helpers ---

function companySubtitle(
  r: RequisitionView,
  names: Record<string, string>,
): string {
  const company = names[r.company_id];
  const code = r.external_req_id;
  if (company != null && code != null) return `${company} · ${code}`;
  if (company != null) return company;
  if (code != null) return code;
  return '';
}

function deskSummary(openTasks: number, hot: number): string {
  const parts: string[] = [
    openTasks === 1 ? '1 open task' : `${openTasks} open tasks`,
  ];
  if (hot > 0) {
    parts.push(hot === 1 ? '1 hot requisition' : `${hot} hot requisitions`);
  }
  return parts.join(' · ');
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return isOverdue(iso)
    ? 'Overdue'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function taskAction(t: TaskView) {
  const base = OWNER_ROUTE[t.owner_type];
  if (base === null) return undefined;
  return (
    <Link to={`${base}/${t.owner_id}`} className="rc-link-action">
      Open
    </Link>
  );
}
