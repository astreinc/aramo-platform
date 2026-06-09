import { useEffect, useState } from 'react';
import {
  Card,
  InlineAlert,
  PageHeader,
  Table,
  type TableColumn,
} from '@aramo/fe-foundation';

import { PIPELINE_STATUS_LABELS } from '../pipeline/types';

import { RollupList } from './components/RollupList';
import { StatCard } from './components/StatCard';
import { getDashboard } from './dashboard-api';
import { dashboardErrorMessage } from './error-messages';
import {
  ACTIVITY_TYPE_LABELS,
  CALENDAR_EVENT_TYPE_LABELS,
  REQUISITION_STATUS_LABELS,
  type ActivityView,
  type CalendarEventView,
  type DashboardView as DashboardViewModel,
} from './types';

// DashboardView — the recruiter-home landing surface. Consumes the
// single-payload GET /v1/dashboard (the ATS-internal composition the
// Reporting-Scope-Seed unblocked). Renders the 6 sections per the
// directive's Ruling A (placement.includes_core_submittal_placements is
// NOT rendered — informational T5 seam, not UX) and Ruling B (render
// the lists as-arrived; server caps at 10 — confirmed at Gate-5).
//
// Visibility is server-side: recruiter sees own-assigned rollups;
// requisition:read:all holders see tenant-wide. The FE renders what it
// gets — NO client-side filtering, NO limitation banner. The rollup
// numbers ARE the visibility-scoped truth (R2 Companies LIST posture).

const calendarColumns: ReadonlyArray<TableColumn<CalendarEventView>> = [
  {
    key: 'starts_at',
    header: 'When',
    render: (row) => formatDateTime(row.starts_at),
    width: '14rem',
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => CALENDAR_EVENT_TYPE_LABELS[row.type],
    width: '8rem',
  },
  {
    key: 'title',
    header: 'Title',
    render: (row) => row.title,
  },
];

const activityColumns: ReadonlyArray<TableColumn<ActivityView>> = [
  {
    key: 'created_at',
    header: 'When',
    render: (row) => formatDateTime(row.created_at),
    width: '14rem',
  },
  {
    key: 'type',
    header: 'Type',
    render: (row) => ACTIVITY_TYPE_LABELS[row.type] ?? row.type,
    width: '12rem',
  },
  {
    key: 'notes',
    header: 'Notes',
    render: (row) => row.notes ?? '—',
  },
];

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function DashboardView() {
  const [data, setData] = useState<DashboardViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDashboard()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(dashboardErrorMessage(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <PageHeader
        title="Dashboard"
        description="A snapshot of what you can see today."
      />
      {loading && <p>Loading dashboard…</p>}
      {error !== null && <InlineAlert variant="error">{error}</InlineAlert>}
      {data !== null && (
        <>
          <h2 style={{ marginTop: '1.5rem', fontSize: '1rem' }}>
            Tenant activity
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
              gap: '0.75rem',
              marginTop: '0.5rem',
            }}
          >
            <StatCard label="Companies" value={data.tenant_counts.companies} />
            <StatCard label="Contacts" value={data.tenant_counts.contacts} />
            <StatCard
              label="Talent records"
              value={data.tenant_counts.talent_records}
            />
            <StatCard
              label="Saved lists"
              value={data.tenant_counts.saved_lists}
            />
            <StatCard
              label="Calendar events"
              value={data.tenant_counts.calendar_events}
            />
            <StatCard label="Activities" value={data.tenant_counts.activities} />
          </div>

          <h2 style={{ marginTop: '1.5rem', fontSize: '1rem' }}>Your work</h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(16rem, 1fr))',
              gap: '0.75rem',
              marginTop: '0.5rem',
            }}
          >
            <Card
              title="Requisitions"
              description="Your visible requisitions by status."
            >
              <RollupList
                total={data.requisition_rollup.total}
                items={data.requisition_rollup.by_status.map((b) => ({
                  key: b.status,
                  label: REQUISITION_STATUS_LABELS[b.status],
                  count: b.count,
                }))}
                emptyMessage="No requisitions in your view yet."
              />
            </Card>
            <Card
              title="Pipelines"
              description="Talent in your visible requisitions, by stage."
            >
              <RollupList
                total={data.pipeline_rollup.total}
                items={data.pipeline_rollup.by_status.map((b) => ({
                  key: b.status,
                  label: PIPELINE_STATUS_LABELS[b.status],
                  count: b.count,
                }))}
                emptyMessage="No pipeline activity in your view yet."
              />
            </Card>
            {/* Ruling A — render placed_pipelines ALONE. The dto carries
                placement.includes_core_submittal_placements:false as a
                T5 seam annotation (informational only per the dto
                docstring); it is NOT rendered as UX (no asterisk, no
                "excludes Core" footnote — the seam belongs in the DDR,
                not the recruiter's UI). */}
            <StatCard
              label="Placements"
              value={data.placement.placed_pipelines}
              hint="Pipelines in placed status, in your view."
            />
          </div>

          <h2 style={{ marginTop: '1.5rem', fontSize: '1rem' }}>
            Upcoming events
          </h2>
          <Card>
            <Table<CalendarEventView>
              caption="Your upcoming calendar events"
              columns={calendarColumns}
              rows={data.upcoming_events}
              rowKey={(row) => row.id}
              emptyMessage="No upcoming events."
            />
          </Card>

          <h2 style={{ marginTop: '1.5rem', fontSize: '1rem' }}>
            Recent activity
          </h2>
          <Card>
            <Table<ActivityView>
              caption="Recent activity in your view"
              columns={activityColumns}
              rows={data.recent_activity}
              rowKey={(row) => row.id}
              emptyMessage="No recent activity."
            />
          </Card>
        </>
      )}
    </section>
  );
}
