import { useEffect, useState } from 'react';

import { useEntityCrumb } from '../shell/breadcrumb';
import { ErrorState, LoadingState, PageHeader } from '../ui';

import { getAssignmentPipeline } from './assignment-pipeline-api';
import type { AssignmentPipelineReport } from './assignment-pipeline-types';

// T9-B3 — dedicated assignment-pipeline operational view (report:read), reached
// from the /reports landing. Current-snapshot counts only: Live Pipeline (the
// four live states), Upcoming Starts (UTC start-date buckets), and a BOUNDED
// Contract Assignment Coverage block explicitly labelled forward-materialized
// (§13). No charting library, no row-level drilldown, no financial fields.

const STATE_LABEL: Record<string, string> = {
  PRE_START: 'Pre-Start',
  BLOCKED: 'Blocked',
  READY_TO_START: 'Ready to Start',
  STARTED: 'Started',
};

type Status = 'loading' | 'ready' | 'error';

export function AssignmentPipelineView(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [report, setReport] = useState<AssignmentPipelineReport | null>(null);
  // T10-B2/F-017 — retry re-issues this idempotent snapshot read.
  const [refreshKey, setRefreshKey] = useState(0);
  // T10-B1/F-002 — sub-page identity for the "Reports › Assignment Pipeline" crumb.
  useEntityCrumb('Assignment Pipeline');

  useEffect(() => {
    let active = true;
    setStatus('loading');
    getAssignmentPipeline()
      .then((r) => {
        if (active) {
          setReport(r);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  return (
    <section>
      <PageHeader
        title="Assignment Pipeline"
        description="Current snapshot of placements in the assignment pipeline."
      />

      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? (
        <ErrorState
          message="Could not load the assignment pipeline."
          onRetry={() => setRefreshKey((k) => k + 1)}
        />
      ) : null}

      {status === 'ready' && report !== null ? (
        <div data-testid="ap-content">
          <section aria-label="Live Pipeline">
            <h2>Live Pipeline</h2>
            <dl data-testid="ap-live">
              {report.by_state.map((r) => (
                <div key={r.state}>
                  <dt>{STATE_LABEL[r.state] ?? r.state}</dt>
                  <dd data-testid={`ap-state-${r.state}`}>{r.count}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-label="Upcoming Starts">
            <h2>Upcoming Starts</h2>
            <dl data-testid="ap-upcoming">
              <div>
                <dt>Overdue</dt>
                <dd data-testid="ap-overdue">{report.start_date.overdue}</dd>
              </div>
              <div>
                <dt>Today</dt>
                <dd>{report.start_date.today}</dd>
              </div>
              <div>
                <dt>Next 7 Days</dt>
                <dd>{report.start_date.next_7_days}</dd>
              </div>
              <div>
                <dt>Later</dt>
                <dd>{report.start_date.later}</dd>
              </div>
              <div>
                <dt>Unspecified</dt>
                <dd data-testid="ap-unspecified">
                  {report.start_date.unspecified}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-label="Contract Assignment Coverage">
            <h2>Contract Assignment Coverage</h2>
            <dl>
              <div>
                <dt>Active</dt>
                <dd data-testid="ap-active">
                  {report.contract_assignments.active}
                </dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd data-testid="ap-ended">
                  {report.contract_assignments.ended}
                </dd>
              </div>
            </dl>
            <p data-testid="ap-coverage-note">
              Forward-materialized assignments only
            </p>
          </section>
        </div>
      ) : null}
    </section>
  );
}
