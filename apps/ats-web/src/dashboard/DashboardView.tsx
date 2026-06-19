import { InlineAlert, type Session } from '@aramo/fe-foundation';
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
import type { TaskOwnerType, TaskPriority, TaskType, TaskView } from '../task/types';
import {
  ActionItem,
  ActivityFeed,
  Card,
  CardHead,
  DataTable,
  Icons,
  KpiCard,
  MetricCard,
  StatusPill,
  TitleCell,
  funnelBucket,
  FUNNEL_BUCKETS,
  type ActionKind,
  type ActivityFeedItem,
  type FunnelBucketKey,
  type PillTone,
  type TableColumn,
} from '../ui';

import { getDashboard, getRecruiterMetrics } from './dashboard-api';
import { dashboardErrorMessage } from './error-messages';
import { KPI_ORDER, toKpiDisplay } from './kpi';
import {
  ACTIVITY_TYPE_LABELS,
  CALENDAR_EVENT_TYPE_LABELS,
  REQUISITION_STATUS_LABELS,
  type CalendarEventView,
  type DashboardView as DashboardViewModel,
  type PipelineRollupItem,
  type RecruiterMetricView,
} from './types';

// My Desk — the ats-web home, rebuilt to the enterprise mockup.
// EVERYTHING is principal-scoped server-side (it is "my" desk: there is no
// all-users view and no persona/role toggle — the shape comes from the
// principal's token, not a switcher). Wired to REAL data with NO fabricated
// fields, per the Go-Live Hardening Charter §7.2:
//   - GET /v1/dashboard      → pipeline funnel rollup, placement count,
//                              recent-activity feed, today's agenda (visibility-
//                              scoped server-side; "my" agenda = owner === me)
//   - GET /v1/requisitions   → "my open reqs" (server-scoped to assigned reqs,
//                              NOT a client visibility filter) + derived counts
//   - GET /v1/tasks?me       → "Needs you" (assignee=me, server-scoped) + the
//                              deterministic facts briefing
//   - GET /v1/companies      → company-id → name resolution (never a UUID)
//   - GET /v1/pipelines      → per-req Pipeline/Submitted counts (one call)
//
// REMOVED (charter §3): the "Viewing as" persona switcher + its explainer; the
// "AI-assisted · you decide" briefing badge + prescriptive "Suggested focus";
// any fit/match verdict on a person (R10/Core). The briefing is a FACTS-ONLY
// deterministic rollup — counts only, no verdict, no "AI" framing.
//
// VERIFY-THEN-HALT (KPI cards): the mockup's Submittals·wk / Interviews set /
// Placements·MTD / Avg-time-to-submit carry sparklines, goal-progress and
// trend deltas. NONE of time-windowing (·wk / MTD), a goal/target config, a
// time-series, or a trend delta is backed (KNOWN_SETTINGS has no goal key; the
// reporting lib computes no per-recruiter windowed metric). So those are
// HALTED: the desk renders only the backed, visibility-scoped current-state
// counts as plain MetricCards (no sparkline, no goal bar, no "+2 vs last wk").

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
  contact: null, // no recruiter contact-detail deep-link for tasks yet (carried)
};

const OWNER_LABEL: Record<TaskOwnerType, string> = {
  requisition: 'Requisition',
  talent_record: 'Talent',
  company: 'Company',
  contact: 'Contact',
};

// task.type → the action-row icon kind. Presentation only — the kind is a
// projection of the BE task.type field, never a computed verdict.
const TYPE_KIND: Record<TaskType, ActionKind> = {
  follow_up: 'followup',
  interview: 'interview',
  screen: 'interview',
  consent: 'consent',
  call: 'reply',
  email: 'reply',
  admin: 'task',
};

// task.type → the row's single affordance label. The link target is the task's
// owner entity (server-immutable owner_type/owner_id).
const TYPE_ACTION: Record<TaskType, string> = {
  follow_up: 'Nudge',
  interview: 'Prep',
  screen: 'Prep',
  consent: 'Refresh', // Refresh = the consent-refresh task type (charter §7.2)
  call: 'Reply',
  email: 'Reply',
  admin: 'Open',
};

const PRIORITY_ORDINAL: Record<TaskPriority, number> = { high: 0, med: 1, low: 2 };

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

type DueClass = 'overdue' | 'today' | 'future' | 'none';

function dueClass(due: string | null): DueClass {
  if (due === null) return 'none';
  const ms = Date.parse(due);
  if (Number.isNaN(ms)) return 'none';
  const day = startOfDay(ms);
  const today = startOfDay(Date.now());
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'future';
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / DAY_MS));
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

// Bucket the BE pipeline rollup ({status, count}[]) into the 6 funnel cells.
// Reuses the shared funnelBucket projection so the desk ribbon can never drift
// from the requisition-detail ribbon.
function funnelFromRollup(
  byStatus: readonly PipelineRollupItem[],
): readonly { key: FunnelBucketKey; label: string; count: number }[] {
  const tally = new Map<FunnelBucketKey, number>();
  for (const { status, count } of byStatus) {
    const b = funnelBucket(status);
    tally.set(b, (tally.get(b) ?? 0) + count);
  }
  return FUNNEL_BUCKETS.map((b) => ({
    key: b.key,
    label: b.label,
    count: tally.get(b.key) ?? 0,
  }));
}

interface DashboardViewProps {
  readonly session: Session;
}

export function DashboardView({ session }: DashboardViewProps) {
  const [dash, setDash] = useState<DashboardViewModel | null>(null);
  const [reqs, setReqs] = useState<readonly RequisitionView[]>([]);
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<readonly TaskView[]>([]);
  const [pipelineCounts, setPipelineCounts] = useState<
    Record<string, ReqPipelineCount>
  >({});
  const [metrics, setMetrics] = useState<readonly RecruiterMetricView[] | null>(
    null,
  );
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
      getRecruiterMetrics(),
    ]).then(([dashRes, reqRes, taskRes, coRes, pipeRes, metricRes]) => {
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
      // Metrics degrade independently — a 403/500 here leaves the rest of the
      // desk coherent (the KPI strip falls back to the backed plain counts).
      if (metricRes.status === 'fulfilled') setMetrics(metricRes.value.items);
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

  // Priority sort = the task ordinal (high → med → low → none), then earliest
  // due, then oldest. R10-safe (the task ordinal, not a computed verdict).
  const queue = [...tasks].sort((a, b) => {
    const pa = a.priority != null ? PRIORITY_ORDINAL[a.priority] : 3;
    const pb = b.priority != null ? PRIORITY_ORDINAL[b.priority] : 3;
    if (pa !== pb) return pa - pb;
    const da = a.due_date != null ? Date.parse(a.due_date) : Infinity;
    const db = b.due_date != null ? Date.parse(b.due_date) : Infinity;
    if (da !== db) return da - db;
    return Date.parse(a.created_at) - Date.parse(b.created_at);
  });

  // FACTS-ONLY briefing — deterministic counts from the principal's real
  // tasks/reqs. No verdict, no "AI", no suggested-focus.
  const dueToday = tasks.filter((t) => dueClass(t.due_date) === 'today').length;
  const overdue = tasks.filter((t) => dueClass(t.due_date) === 'overdue').length;
  const followupsOverdue = tasks.filter(
    (t) => t.type === 'follow_up' && dueClass(t.due_date) === 'overdue',
  ).length;
  const facts: readonly { n: number; label: string }[] = [
    dueToday > 0
      ? { n: dueToday, label: dueToday === 1 ? 'task due today' : 'tasks due today' }
      : null,
    overdue > 0
      ? { n: overdue, label: overdue === 1 ? 'task overdue' : 'tasks overdue' }
      : null,
    followupsOverdue > 0
      ? { n: followupsOverdue, label: 'follow-ups overdue' }
      : null,
    hotCount > 0
      ? {
          n: hotCount,
          label: hotCount === 1 ? 'hot requisition' : 'hot requisitions',
        }
      : null,
  ].filter((f): f is { n: number; label: string } => f !== null);

  // "Today" agenda — my scheduled items for today, by time. The dashboard
  // bundles upcoming calendar events (tenant/site-scoped); the principal slice
  // is owner === me. (Carry: a server-side ?owner_id=me filter on the calendar
  // list would make this server-scoped rather than a client owner-filter.)
  const today = startOfDay(Date.now());
  const agenda = (dash?.upcoming_events ?? [])
    .filter(
      (e) =>
        e.owner_id === session.sub &&
        startOfDay(Date.parse(e.starts_at)) === today,
    )
    .slice()
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));

  const funnelCells = funnelFromRollup(dash?.pipeline_rollup.by_status ?? []);
  const pipelineTotal = dash?.pipeline_rollup.total ?? 0;

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

  // KPI strip — the 4 mockup cards from REAL per-recruiter metrics (ordered).
  // When the metrics call is unavailable, fall back to the backed plain counts.
  const kpiByKey = new Map((metrics ?? []).map((m) => [m.key, m]));
  const kpiDisplays =
    metrics !== null
      ? KPI_ORDER.map((k) => kpiByKey.get(k))
          .filter((m): m is RecruiterMetricView => m !== undefined)
          .map(toKpiDisplay)
      : [];

  return (
    <section>
      <div className="rc-viewhead">
        <h1 className="rc-h1">My desk</h1>
        <p className="rc-sub">{deskSummary(tasks.length, hotCount)}</p>
      </div>

      <div className="rc-brief rc-mt-16">
        <div className="rc-brief__ic" aria-hidden="true">
          <Icons.IconBolt />
        </div>
        {facts.length === 0 ? (
          <span className="rc-brief__none">
            You're all caught up — nothing is due today.
          </span>
        ) : (
          <div className="rc-brief__facts">
            {facts.map((f) => (
              <span key={f.label} className="rc-fact">
                <b>{f.n}</b> {f.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {kpiDisplays.length > 0 ? (
        <div className="rc-metrics rc-metrics--spaced">
          {kpiDisplays.map((k) => (
            <KpiCard
              key={k.key}
              label={k.label}
              value={k.value}
              unit={k.unit}
              delta={k.delta}
              series={k.series}
              seriesTone={k.seriesTone}
              pace={k.pace}
            />
          ))}
        </div>
      ) : (
        // Fallback — backed plain counts when /recruiter-metrics is unavailable.
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
            value={pipelineTotal}
          />
          <MetricCard
            icon={<Icons.IconTasks />}
            label="Placements"
            value={dash?.placement.placed_pipelines ?? 0}
            hint="in your view"
          />
        </div>
      )}

      <div className="rc-grid2">
        <div className="rc-stack">
          <Card flush>
            <CardHead
              title="Needs you"
              actions={
                <Link to="/tasks" className="rc-card__head-more">
                  All tasks
                </Link>
              }
            />
            {queue.length === 0 ? (
              <p className="rc-empty">Nothing needs you right now.</p>
            ) : (
              queue.map((t) => (
                <ActionItem
                  key={t.id}
                  kind={taskKind(t)}
                  title={t.title}
                  priority={t.priority ?? undefined}
                  badges={taskBadges(t)}
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

        <aside className="rc-stack">
          <Card flush>
            <CardHead title="Today" />
            {agenda.length === 0 ? (
              <p className="rc-empty">Nothing scheduled today.</p>
            ) : (
              <div className="rc-agenda">
                {agenda.map((e) => (
                  <div key={e.id} className="rc-agenda__row">
                    <div className="rc-agenda__time">{eventTime(e)}</div>
                    <div className="rc-agenda__body">
                      <div className="rc-agenda__t">{e.title}</div>
                      <div className="rc-agenda__s">
                        {CALENDAR_EVENT_TYPE_LABELS[e.type]}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card flush>
            <CardHead title="My active pipeline" />
            <div className="rc-feed-wrap">
              <div className="rc-funnel">
                {funnelCells.map((c) => (
                  <div
                    key={c.key}
                    className={`rc-fstage${
                      c.count > 0 ? ' rc-fstage--has' : ' rc-fstage--dim'
                    }`}
                  >
                    <div className="rc-fstage__bar" />
                    <div className="rc-fstage__n num">{c.count}</div>
                    <div className="rc-fstage__l">{c.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

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

function taskKind(t: TaskView): ActionKind {
  if (t.type != null) return TYPE_KIND[t.type];
  return dueClass(t.due_date) === 'overdue' ? 'overdue' : 'task';
}

function taskBadges(t: TaskView) {
  const cls = dueClass(t.due_date);
  return (
    <>
      {t.type === 'consent' ? (
        <StatusPill tone="ok" dot>
          Consent
        </StatusPill>
      ) : null}
      {cls === 'today' ? (
        <StatusPill tone="hot" dot>
          Due today
        </StatusPill>
      ) : null}
    </>
  );
}

function taskAction(t: TaskView) {
  const base = OWNER_ROUTE[t.owner_type];
  if (base === null) return undefined;
  const label = t.type != null ? TYPE_ACTION[t.type] : 'Open';
  return (
    <Link to={`${base}/${t.owner_id}`} className="rc-link-action">
      {label}
    </Link>
  );
}

function eventTime(e: CalendarEventView): string {
  if (e.all_day) return 'All day';
  const d = new Date(e.starts_at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

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
