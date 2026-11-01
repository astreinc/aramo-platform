import { useEffect, useState } from 'react';

import { downloadCsv, errorMessage, reportsApi, type ReportExportKind, type ReportPeriod, type ReportQuery, type ReportStats, type ReportsOverview } from '../api';
import { Btn, ErrorBox, Loading, Sel, TextIn } from '../ui';
import { useWorkspace } from '../workspace';

import { ReportsPage } from './WorkspacePages';

// Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED) §1.13 — organization REPORTS
// (basic): volume by period, turnaround, completion rate, by sender and by template, CSV
// exports and the envelope audit export. Shown ONLY while the backend reports the
// `sign.reports` capability available AND the session holds sign:report:read; otherwise the
// existing Reports page (dashboard summary) is shown unchanged. The backend decides every
// figure and refuses every route while the capability is not available.

export function ReportsRoute() {
  const { ctx } = useWorkspace();
  return ctx.features?.reports === true && ctx.permissions.reports === true ? <OrganizationReports /> : <ReportsPage />;
}

type Preset = '30' | '90' | '180' | '365' | 'custom';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function presetRange(preset: Exclude<Preset, 'custom'>, now: Date = new Date()): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - (Number(preset) - 1) * 86_400_000);
  return { from: isoDay(from), to: isoDay(to) };
}

const hrs = (h: number | null): string => (h === null ? '—' : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
const pct = (p: number | null): string => (p === null ? '—' : `${p}%`);

function OrganizationReports() {
  const [preset, setPreset] = useState<Preset>('90');
  const [custom, setCustom] = useState(() => presetRange('90'));
  const [period, setPeriod] = useState<ReportPeriod>('week');
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const range = preset === 'custom' ? custom : presetRange(preset);
  const query: ReportQuery = { ...range, period };

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    reportsApi
      .overview(query)
      .then((o) => {
        if (live) setData(o);
      })
      .catch((e: unknown) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [preset, custom.from, custom.to, period]);

  const exportCsv = async (kind: ReportExportKind | 'audit') => {
    setBusy(kind);
    setError('');
    try {
      if (kind === 'audit') await downloadCsv(reportsApi.auditUrl(query), 'aramo-sign-envelope-audit.csv');
      else await downloadCsv(reportsApi.exportUrl(kind, query), `aramo-sign-${kind}.csv`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sg-page sg-page--wide" data-testid="org-reports">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Reports</h1>
        <div className="sg-pagehead__end" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Sel aria-label="Range" value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={{ width: 160 }}>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="180">Last 6 months</option>
            <option value="365">Last 12 months</option>
            <option value="custom">Custom range</option>
          </Sel>
          {preset === 'custom' ? (
            <>
              <TextIn type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} style={{ width: 150 }} />
              <TextIn type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} style={{ width: 150 }} />
            </>
          ) : null}
          <Sel aria-label="Group by" value={period} onChange={(e) => setPeriod(e.target.value as ReportPeriod)} style={{ width: 130 }}>
            <option value="day">By day</option>
            <option value="week">By week</option>
            <option value="month">By month</option>
          </Sel>
        </div>
      </div>
      <p className="sg-muted" style={{ marginTop: -8 }}>
        Figures cover envelopes sent in the range (dates in UTC). The volume chart counts each send, completion, decline and void in the period it happened.
      </p>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {data === null && error === '' ? <Loading /> : null}
      {data !== null ? (
        <>
          <div className="sg-grid sg-grid--6">
            <Kpi label="Envelopes sent" value={String(data.totals.sent)} sub={`${data.range.from} to ${data.range.to}`} />
            <Kpi label="Completion rate" value={pct(data.totals.completion_rate)} sub="of envelopes sent" />
            <Kpi label="Median time to complete" value={hrs(data.totals.turnaround_median_hours)} sub="sent → completed" />
            <Kpi label="Average time to complete" value={hrs(data.totals.turnaround_average_hours)} sub={`90% within ${hrs(data.totals.turnaround_p90_hours)}`} />
            <Kpi label="Awaiting signers" value={String(data.totals.in_flight)} sub="sent, not finished" />
            <Kpi label="Declined / voided / expired" value={`${data.totals.declined} / ${data.totals.voided} / ${data.totals.expired}`} sub="of envelopes sent" />
          </div>

          <section className="sg-card" style={{ marginTop: 14 }}>
            <div className="sg-card__head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Envelope volume</span>
              <Btn size="sm" onClick={() => void exportCsv('volume')} disabled={busy !== null} data-testid="export-volume">
                Export CSV
              </Btn>
            </div>
            <div className="sg-card__body">
              <VolumeBars volume={data.volume} />
            </div>
          </section>

          <StatsTable
            title="By sender"
            testId="by-sender"
            rows={data.by_sender.map((s) => ({ key: s.sender_id, label: s.sender_name ?? 'Former member', stats: s }))}
            onExport={() => void exportCsv('senders')}
            busy={busy !== null}
          />
          <StatsTable
            title="By template"
            testId="by-template"
            rows={data.by_template.map((t) => ({
              key: t.template_ref ?? 'none',
              label: t.template_ref === null ? 'Not from a template' : (t.template_name ?? `Template ${t.template_ref.slice(0, 8)}`),
              stats: t,
            }))}
            onExport={() => void exportCsv('templates')}
            busy={busy !== null}
          />

          <section className="sg-card" style={{ marginTop: 14 }}>
            <div className="sg-card__head">Exports</div>
            <div className="sg-card__body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Btn onClick={() => void exportCsv('summary')} disabled={busy !== null} data-testid="export-summary">
                Summary (CSV)
              </Btn>
              <Btn onClick={() => void exportCsv('audit')} disabled={busy !== null} data-testid="export-audit">
                Envelope audit export (CSV)
              </Btn>
              <span className="sg-muted" style={{ fontSize: 12 }}>
                The audit export lists envelopes created in the range with their status and dates. It never includes document contents or recipients’ details.
              </span>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="sg-card sg-stat">
      <div className="sg-stat__l">{label}</div>
      <div className="sg-stat__n">{value}</div>
      <div className="sg-stat__s">{sub}</div>
    </div>
  );
}

function VolumeBars({ volume }: { volume: ReportsOverview['volume'] }) {
  const max = Math.max(1, ...volume.map((v) => Math.max(v.sent, v.completed)));
  const labelEvery = Math.max(1, Math.ceil(volume.length / 12));
  return (
    <div data-testid="volume">
      <div className="sg-bars" style={{ height: 150 }}>
        {volume.map((v) => (
          <div key={v.period_start} className="sg-bars__col" title={`${v.period_start}: ${v.sent} sent, ${v.completed} completed, ${v.declined} declined, ${v.voided} voided`}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: '100%' }}>
              <div style={{ flex: 1, height: `${(v.sent / max) * 100}%`, background: '#A9B8F1', borderRadius: '3px 3px 0 0' }} />
              <div style={{ flex: 1, height: `${(v.completed / max) * 100}%`, background: 'var(--accent)', borderRadius: '3px 3px 0 0' }} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {volume.map((v, i) => (
          <div key={v.period_start} className="sg-bars__lab" style={{ flex: 1 }}>
            {i % labelEvery === 0 ? v.period_start.slice(5) : ''}
          </div>
        ))}
      </div>
      <div className="sg-muted" style={{ display: 'flex', gap: 14, fontSize: 12, marginTop: 10 }}>
        <span>
          <span className="sg-swatch" style={{ background: '#A9B8F1', display: 'inline-block', marginRight: 4 }} />
          Sent
        </span>
        <span>
          <span className="sg-swatch" style={{ background: 'var(--accent)', display: 'inline-block', marginRight: 4 }} />
          Completed
        </span>
      </div>
    </div>
  );
}

function StatsTable({
  title,
  testId,
  rows,
  onExport,
  busy,
}: {
  title: string;
  testId: string;
  rows: { key: string; label: string; stats: ReportStats }[];
  onExport: () => void;
  busy: boolean;
}) {
  return (
    <section className="sg-card" style={{ marginTop: 14 }} data-testid={testId}>
      <div className="sg-card__head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{title}</span>
        <Btn size="sm" onClick={onExport} disabled={busy}>
          Export CSV
        </Btn>
      </div>
      <div className="sg-tablewrap">
        <table className="sg-table">
          <thead>
            <tr>
              <th>{title === 'By sender' ? 'Sender' : 'Template'}</th>
              <th>Sent</th>
              <th>Completed</th>
              <th>Completion rate</th>
              <th>Median time</th>
              <th>Declined</th>
              <th>Awaiting</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="sg-empty">No envelopes were sent in this range.</div>
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <strong>{r.label}</strong>
                </td>
                <td>{r.stats.sent}</td>
                <td>{r.stats.completed}</td>
                <td>{pct(r.stats.completion_rate)}</td>
                <td>{hrs(r.stats.turnaround_median_hours)}</td>
                <td>{r.stats.declined}</td>
                <td>{r.stats.in_flight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
