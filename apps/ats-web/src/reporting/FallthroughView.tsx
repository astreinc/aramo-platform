import { useState, type FormEvent } from 'react';

import { getFallthrough } from './fallthrough-api';
import type { FallthroughReport } from './fallthrough-types';

// T9-B2 — dedicated operational report surface (report:read), reached from the
// Reporting area — a distinct page from Fill Performance (§13). Minimal by
// design: pick an absolute [from, to) window → fallthrough rate + reason
// breakdown. No charting library. Datetime-local controls convert to ABSOLUTE
// UTC instants (carry Z) before the request; B2 does not invent date-only
// business-day semantics.
function toInstant(localValue: string): string | null {
  if (localValue === '') return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type Status = 'idle' | 'loading' | 'error';

export function FallthroughView(): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<FallthroughReport | null>(null);

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
      const r = await getFallthrough(fromIso, toIso);
      setReport(r);
      setStatus('idle');
    } catch {
      setError('Could not load the report.');
      setStatus('error');
    }
  }

  return (
    <section aria-labelledby="fallthrough-heading">
      <h1 id="fallthrough-heading">Fallthrough</h1>
      <p>
        Rate and reasons for accepted placements that fall through before start,
        for attempts first accepted in the selected period.
      </p>
      <form onSubmit={run}>
        <label>
          From
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="ft-from"
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="ft-to"
          />
        </label>
        <button type="submit" data-testid="ft-run">
          Run report
        </button>
      </form>

      {status === 'loading' ? <p role="status">Loading…</p> : null}
      {status === 'error' && error !== null ? (
        <p role="alert">{error}</p>
      ) : null}

      {report !== null && status === 'idle' ? (
        <div data-testid="ft-results">
          <dl>
            <div>
              <dt>Fallthrough rate</dt>
              <dd data-testid="ft-rate">
                {report.fallthrough_rate === null
                  ? '—'
                  : `${report.fallthrough_rate}%`}
              </dd>
            </div>
            <div>
              <dt>Accepted attempts</dt>
              <dd>{report.accepted_attempts}</dd>
            </div>
            <div>
              <dt>Fallthrough attempts</dt>
              <dd>{report.fallthrough_attempts}</dd>
            </div>
          </dl>
          {report.reasons.length > 0 ? (
            <table data-testid="ft-reasons">
              <thead>
                <tr>
                  <th scope="col">Reason</th>
                  <th scope="col">Count</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {report.reasons.map((r) => (
                  <tr key={r.reason_code ?? 'unspecified'}>
                    <td>{r.reason_label}</td>
                    <td>{r.count}</td>
                    <td>{r.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p data-testid="ft-no-reasons">No fallthrough in this period.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
