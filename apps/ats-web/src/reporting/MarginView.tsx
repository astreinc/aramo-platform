import { useEffect, useState } from 'react';
import { hasScope, type Session, useSession } from '@aramo/fe-foundation';

import { useEntityCrumb } from '../shell/breadcrumb';
import { ErrorState, LoadingState, PageHeader } from '../ui';

import { getMargin } from './margin-api';
import type { MarginReport } from './margin-types';

// T9-B4 — dedicated margin operational view, reached from the /reports landing.
// Governed by Aramo-T9-B4-Directive-v1_0-LOCKED (+ the field-masking amendment).
// CURRENT-SNAPSHOT, AGGREGATE-ONLY: one row per (currency, rate_period) group with
// the governed group_margin_percent (bill-rate-weighted; null → "—"), plus the
// forward-materialized coverage counts. Requires assignment:commercials:read — the
// surface is gated away (no fetch) without it (§26); the backend independently 403s
// on direct navigation (§14). No charting, no drilldown, NO pay/bill/spread/markup,
// NO person/assignment rows. The result is "current assignment rate margin" — NEVER
// booked / invoiced / realized / timesheet / revenue margin.

const PERIOD_LABEL: Record<string, string> = {
  HOURLY: 'Hourly',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  ANNUAL: 'Annual',
};

type Status = 'idle' | 'loading' | 'ready' | 'error';

export function MarginView({
  sessionOverride,
}: {
  readonly sessionOverride?: Session;
}): JSX.Element {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canRead =
    session !== null &&
    Array.isArray(session.scopes) &&
    hasScope(session, 'assignment:commercials:read');

  const [status, setStatus] = useState<Status>('idle');
  const [report, setReport] = useState<MarginReport | null>(null);
  // T10-B2/F-017 — retry re-issues this idempotent margin read.
  const [refreshKey, setRefreshKey] = useState(0);
  // T10-B1/F-002 — sub-page identity for the "Reports › Margin" crumb. Published
  // unconditionally (before the gated early-return) so the crumb is correct
  // whether or not the commercial-read scope is held.
  useEntityCrumb('Margin');

  useEffect(() => {
    // §26 — no fetch when the surface is gated away (missing the commercial scope).
    if (!canRead) return;
    let active = true;
    setStatus('loading');
    getMargin()
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
  }, [canRead, refreshKey]);

  // T10-B2 FIX_NOW-1 — the commercial-margin gate stays SCOPE-SILENT (the
  // boundary T10-B1 preserved): a legitimately-reached-but-denied actor gets a
  // safe denial that never names `assignment:commercials:read`. No fetch fired
  // (the effect returns early above); the Reports landing already hides the
  // Margin link without this scope. (ForbiddenState discloses the scope, so it
  // is deliberately NOT used here.)
  if (!canRead) {
    return (
      <section>
        <PageHeader title="Margin" />
        <p role="status" data-testid="margin-gated">
          You do not have access to commercial margin.
        </p>
      </section>
    );
  }

  return (
    <section>
      <PageHeader
        title="Margin"
        description="Current assignment rate margin. Coverage is forward-materialized."
      />

      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' ? (
        <ErrorState
          message="Could not load the margin report."
          onRetry={() => setRefreshKey((k) => k + 1)}
        />
      ) : null}

      {status === 'ready' && report !== null ? (
        <div data-testid="margin-content">
          <dl data-testid="margin-coverage">
            <div>
              <dt>Eligible assignments</dt>
              <dd data-testid="margin-eligible">{report.eligible_count}</dd>
            </div>
            <div>
              <dt>Commercialized</dt>
              <dd data-testid="margin-commercialized">
                {report.commercialized_count}
              </dd>
            </div>
            <div>
              <dt>Missing commercial data</dt>
              <dd data-testid="margin-missing">
                {report.missing_commercial_count}
              </dd>
            </div>
          </dl>
          <p data-testid="margin-coverage-note">
            Current assignment rate margin — forward-materialized coverage only.
          </p>

          {report.groups.length === 0 ? (
            <p data-testid="margin-empty">No commercialized assignments.</p>
          ) : (
            <table data-testid="margin-groups">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>Rate Period</th>
                  <th>Assignments</th>
                  <th>Margin %</th>
                </tr>
              </thead>
              <tbody>
                {report.groups.map((g) => (
                  <tr
                    key={`${g.currency}-${g.rate_period}`}
                    data-testid={`margin-group-${g.currency}-${g.rate_period}`}
                  >
                    <td>{g.currency}</td>
                    <td>{PERIOD_LABEL[g.rate_period] ?? g.rate_period}</td>
                    <td>{g.assignment_count}</td>
                    <td
                      data-testid={`margin-pct-${g.currency}-${g.rate_period}`}
                    >
                      {g.group_margin_percent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </section>
  );
}
