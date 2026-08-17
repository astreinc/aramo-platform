import { useState, type FormEvent } from 'react';

import { useEntityCrumb } from '../shell/breadcrumb';
import { ErrorState, LoadingState, PageHeader } from '../ui';

import { getFillPerformance } from './fill-performance-api';
import type { FillPerformanceReport } from './types';

// T9-B1 — dedicated operational report surface (report:read), reached from its
// own nav entry — NOT part of the My Desk dashboard (D-7). Minimal by design:
// pick an absolute [from, to) window → fill rate + time-to-fill. No charting
// library (D-7 / §18); the numbers render as a plain definition list.
//
// The two datetime-local controls are converted to ABSOLUTE UTC instants via
// Date#toISOString() before the request (D-5: the API takes absolute instants
// carrying Z — never date-only). B1 does not invent date-only business-day
// semantics.
function toInstant(localValue: string): string | null {
  if (localValue === '') return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type Status = 'idle' | 'loading' | 'error';

export function FillPerformanceView(): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<FillPerformanceReport | null>(null);
  // T10-B1/F-002 — publish the sub-page identity so the breadcrumb reads
  // "Reports › Fill performance"; the section crumb links back to /reports.
  useEntityCrumb('Fill performance');

  async function run(e: FormEvent): Promise<void> {
    e.preventDefault();
    const fromIso = toInstant(from);
    const toIso = toInstant(to);
    if (fromIso === null || toIso === null) {
      setError('Choose an absolute start and end.');
      setStatus('error');
      return;
    }
    if (new Date(fromIso).getTime() >= new Date(toIso).getTime()) {
      setError('Start must be before end.');
      setStatus('error');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const r = await getFillPerformance(fromIso, toIso);
      setReport(r);
      setStatus('idle');
    } catch {
      setError('Could not load the report.');
      setStatus('error');
    }
  }

  return (
    <section>
      <PageHeader
        title="Fill performance"
        description="Fill rate and time-to-fill for requisitions created in the selected period."
      />
      <form onSubmit={run}>
        <label>
          From
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="fp-from"
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="fp-to"
          />
        </label>
        <button type="submit" data-testid="fp-run">
          Run report
        </button>
      </form>

      {status === 'loading' ? <LoadingState /> : null}
      {status === 'error' && error !== null ? (
        <ErrorState message={error} />
      ) : null}

      {report !== null && status === 'idle' ? (
        <dl data-testid="fp-results">
          <div>
            <dt>Fill rate</dt>
            <dd data-testid="fp-fill-rate">
              {report.fill_rate === null ? '—' : `${report.fill_rate}%`}
            </dd>
          </div>
          <div>
            <dt>Openings</dt>
            <dd>{report.openings}</dd>
          </div>
          <div>
            <dt>Filled openings</dt>
            <dd>{report.filled_openings}</dd>
          </div>
          <div>
            <dt>Fully filled requisitions</dt>
            <dd>{report.fully_filled_requisitions}</dd>
          </div>
          <div>
            <dt>Time-to-fill (fully filled)</dt>
            <dd>{report.time_to_fill.count}</dd>
          </div>
          <div>
            <dt>Avg time-to-fill (days)</dt>
            <dd data-testid="fp-ttf-avg">
              {report.time_to_fill.average_days === null
                ? '—'
                : report.time_to_fill.average_days}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
