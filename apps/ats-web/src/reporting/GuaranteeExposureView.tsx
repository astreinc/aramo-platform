import { useState, type FormEvent } from 'react';

import { useEntityCrumb } from '../shell/breadcrumb';
import { PageHeader } from '../ui';

import { getGuaranteeExposure } from './guarantee-exposure-api';
import type { GuaranteeExposureReport } from './guarantee-exposure-types';

// Track 7 / T7-P5 §5.6 — the guarantee-exposure report surface (report:read), in the existing
// Reports IA. Pick an absolute [from, to) window (datetime-local → absolute UTC instants via
// toISOString, the reporting convention) → a SUMMARY of permanent-placement guarantee exposure.
// Money is shown PER CURRENCY only (semantic tables) — never summed across currencies, never
// FX-converted; there is NO cross-currency monetary total. Obligation amounts are OBLIGATIONS,
// not payments. No row-level placement data. Empty state for a zero cohort. No charting library.
function toInstant(localValue: string): string | null {
  if (localValue === '') return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

type Status = 'idle' | 'loading' | 'error';

export function GuaranteeExposureView(): JSX.Element {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<GuaranteeExposureReport | null>(null);
  // T10-B1/F-002 — sub-page identity for the "Reports › Guarantee exposure" crumb.
  useEntityCrumb('Guarantee exposure');

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
      const r = await getGuaranteeExposure(fromIso, toIso);
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
        title="Guarantee exposure"
        description="Permanent-placement guarantee exposure for placements that started in the selected period. Monetary values are shown per currency and are never combined across currencies."
      />
      <form onSubmit={run}>
        <label>
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="ge-from" />
        </label>
        <label>
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} data-testid="ge-to" />
        </label>
        <button type="submit" data-testid="ge-run">
          Run report
        </button>
      </form>

      {status === 'loading' ? <p role="status">Loading…</p> : null}
      {status === 'error' && error !== null ? <p role="alert">{error}</p> : null}

      {report !== null && status === 'idle' ? (
        report.cohort_count === 0 ? (
          <p data-testid="ge-empty">No permanent placements started in this period.</p>
        ) : (
          <div data-testid="ge-results">
            <dl>
              <div>
                <dt>Placements entering guarantee</dt>
                <dd data-testid="ge-cohort-count">{report.cohort_count}</dd>
              </div>
              <div>
                <dt>Falloff rate</dt>
                <dd data-testid="ge-falloff-rate">{report.falloff_rate}%</dd>
              </div>
            </dl>

            <h2>Exposure by currency</h2>
            <table className="rc-table" data-testid="ge-exposure-table">
              <thead>
                <tr>
                  <th scope="col">Currency</th>
                  <th scope="col">Total</th>
                  <th scope="col">Active / at-risk</th>
                  <th scope="col">Satisfied</th>
                  <th scope="col">Fell off</th>
                </tr>
              </thead>
              <tbody>
                {report.exposure_by_currency.map((b) => (
                  <tr key={b.currency} data-testid={`ge-exposure-row-${b.currency}`}>
                    <td>{b.currency}</td>
                    <td className="num">{b.total} {b.currency}</td>
                    <td className="num">{b.at_risk} {b.currency}</td>
                    <td className="num">{b.satisfied} {b.currency}</td>
                    <td className="num">{b.fell_off} {b.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>Remedy obligations by currency</h2>
            {report.remedy_obligation_by_currency.length === 0 ? (
              <p className="rc-muted-line" data-testid="ge-obligations-empty">No remedy obligations in this period.</p>
            ) : (
              <table className="rc-table" data-testid="ge-obligation-table">
                <thead>
                  <tr>
                    <th scope="col">Currency</th>
                    <th scope="col">Refund obligation</th>
                    <th scope="col">Prorated credit obligation</th>
                  </tr>
                </thead>
                <tbody>
                  {report.remedy_obligation_by_currency.map((b) => (
                    <tr key={b.currency} data-testid={`ge-obligation-row-${b.currency}`}>
                      <td>{b.currency}</td>
                      <td className="num">{b.refund_total} {b.currency}</td>
                      <td className="num">{b.prorated_credit_total} {b.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="rc-muted-line">Obligation amounts are amounts owed under the guarantee — not payments.</p>

            <h2>Lifecycle summary</h2>
            <dl data-testid="ge-states">
              <div>
                <dt>Active</dt>
                <dd>{report.states.active}</dd>
              </div>
              <div>
                <dt>Satisfied</dt>
                <dd>{report.states.satisfied}</dd>
              </div>
              <div>
                <dt>Fell off</dt>
                <dd>{report.states.fell_off}</dd>
              </div>
              <div>
                <dt>Replacement due</dt>
                <dd>{report.states.remedy_due.replacement}</dd>
              </div>
              <div>
                <dt>Refund due</dt>
                <dd>{report.states.remedy_due.refund}</dd>
              </div>
              <div>
                <dt>Prorated credit due</dt>
                <dd>{report.states.remedy_due.prorated_credit}</dd>
              </div>
              <div>
                <dt>Remedy completed</dt>
                <dd>{report.states.remedy_completed}</dd>
              </div>
            </dl>
          </div>
        )
      ) : null}
    </section>
  );
}
