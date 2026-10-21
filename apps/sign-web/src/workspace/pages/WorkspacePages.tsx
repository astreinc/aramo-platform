import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { errorMessage, senderApi, type ContactRow, type DocumentRow, type EnvelopeRow, type LedgerEvent, type Summary } from '../api';
import { Avatar, Btn, ErrorBox, Loading, Sel, TextIn, fmtBytes, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

import { Bars } from './Dashboard';
import { Timeline } from './EnvelopeDetail';

// ── Activity across all envelopes (the tenant's hash-chained ledger) ─────────
export function ActivityPage() {
  const [events, setEvents] = useState<LedgerEvent[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .activity(200)
      .then((r) => setEvents(r.items))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  return (
    <div className="sg-page sg-page--wide">
      <h1 className="sg-h1" style={{ marginBottom: 16 }}>
        Activity across all envelopes
      </h1>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {events === null && error === '' ? <Loading /> : null}
      {events !== null ? <Timeline events={events} envelopeLinks /> : null}
    </div>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────
function docState(status: string): [string, string, string] {
  if (status === 'COMPLETED') return ['Signed · frozen', 'var(--okbg)', 'var(--ok)'];
  if (status === 'DRAFT') return ['Draft', 'var(--bg)', 'var(--muted)'];
  if (status === 'SENT' || status === 'IN_PROGRESS') return ['In signing', 'var(--accent-soft)', 'var(--accent)'];
  return [status.charAt(0) + status.slice(1).toLowerCase(), 'var(--bg)', 'var(--muted)'];
}

export function DocumentsPage() {
  const { base } = useWorkspace();
  const [rows, setRows] = useState<DocumentRow[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .documents()
      .then((r) => setRows(r.items))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  const shown = useMemo(() => (rows ?? []).filter((d) => q.trim() === '' || `${d.title} ${d.envelope.subject}`.toLowerCase().includes(q.trim().toLowerCase())), [rows, q]);
  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Documents</h1>
        <TextIn aria-label="Search documents" placeholder="Search documents" style={{ maxWidth: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {rows === null && error === '' ? <Loading /> : null}
      {rows !== null ? (
        <section className="sg-card">
          <div className="sg-tablewrap">
            <table className="sg-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Envelope</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="sg-empty">No documents yet.</div>
                    </td>
                  </tr>
                ) : null}
                {shown.map((d) => {
                  const [label, bg, col] = docState(d.envelope.status);
                  return (
                    <tr key={d.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className="sg-docicon" aria-hidden="true" />
                          <div>
                            <div style={{ fontWeight: 600 }}>{d.title}</div>
                            <div className="sg-muted" style={{ fontSize: 12.5 }}>
                              PDF{d.byte_size !== null ? ` · ${fmtBytes(d.byte_size)}` : ''}
                              {d.source === 'ARAMO_DOCUMENT' ? ' · from Aramo ATS' : ''}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <Link to={`${base}/envelopes/${d.envelope.id}`}>{d.envelope.subject}</Link>
                      </td>
                      <td>
                        <span className="sg-pill" style={{ background: bg, color: col }}>
                          {label}
                        </span>
                      </td>
                      <td className="sg-muted">{fmtDate(d.uploaded_at)}</td>
                      <td className="sg-muted">{d.owner ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sg-table__foot">
            <span>Signed documents are frozen. Changing a completed document needs a new envelope.</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ── Contacts (derived from past recipients — no separate contact store) ──────
export function ContactsPage() {
  const { base, ctx } = useWorkspace();
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    senderApi
      .contacts()
      .then((r) => setRows(r.items))
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  const shown = (rows ?? []).filter((c) => q.trim() === '' || `${c.name} ${c.email}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Contacts</h1>
        <TextIn aria-label="Search contacts" placeholder="Search contacts" style={{ maxWidth: 220 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="sg-pagehead__end">
          <Btn variant="primary" disabled title="Saving contacts needs a contact store (proposed)">
            + Add contact · Proposed
          </Btn>
        </div>
      </div>
      <p className="sg-muted" style={{ marginTop: -8 }}>
        People you’ve sent envelopes to. A saved contact book is a proposed capability.
      </p>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {rows === null && error === '' ? <Loading /> : null}
      {rows !== null ? (
        <section className="sg-card">
          <div className="sg-tablewrap">
            <table className="sg-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Envelopes</th>
                  <th>Last sent</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="sg-empty">No contacts yet.</div>
                    </td>
                  </tr>
                ) : null}
                {shown.map((c) => (
                  <tr key={c.email}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={c.name} small />
                        <strong>{c.name}</strong>
                      </div>
                    </td>
                    <td className="sg-muted">{c.email}</td>
                    <td>
                      <Link to={`${base}/envelopes?q=${encodeURIComponent(c.email)}`}>{c.envelope_count} recent</Link>
                    </td>
                    <td className="sg-muted">{fmtDate(c.last_used_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {ctx.can_send ? (
                        <Link className="sg-btn sg-btn--sm" to={`${base}/envelopes/new`}>
                          Send to
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ── Reports (live data) ──────────────────────────────────────────────────────
export function ReportsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<EnvelopeRow[] | null>(null);
  const [status, setStatus] = useState('all');
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([senderApi.summary(), senderApi.list({ days: 186 })])
      .then(([s, l]) => {
        setSummary(s);
        setRows(l.items);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  const sent = summary?.months.reduce((a, m) => a + m.sent, 0) ?? 0;
  const completed = (rows ?? []).filter((r) => r.status === 'COMPLETED' && r.sent_at !== null && r.completed_at !== null);
  const avgDays =
    completed.length === 0 ? null : completed.reduce((a, r) => a + (new Date(r.completed_at ?? 0).getTime() - new Date(r.sent_at ?? 0).getTime()), 0) / completed.length / 86_400_000;
  const declined = summary?.counts.declined ?? 0;
  const statusRows: [string, string, number][] = summary === null
    ? []
    : [
        ['DRAFT', 'Draft', summary.counts.draft],
        ['IN_PROGRESS', 'In progress', summary.counts.sent + summary.counts.in_progress],
        ['COMPLETED', 'Completed', summary.counts.completed],
        ['DECLINED', 'Declined', summary.counts.declined],
        ['VOIDED', 'Voided', summary.counts.voided],
        ['EXPIRED', 'Expired', summary.counts.expired],
      ];
  const shownStatus = statusRows.filter(([k]) => status === 'all' || k === status);
  const maxStatus = Math.max(1, ...statusRows.map((r) => r[2]));
  const colors: Record<string, string> = { DRAFT: '#5B6473', IN_PROGRESS: 'var(--accent)', COMPLETED: 'var(--ok)', DECLINED: 'var(--bad)', VOIDED: '#8B94A3', EXPIRED: 'var(--warn)' };
  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Reports</h1>
        <div className="sg-pagehead__end">
          <Sel aria-label="Range" value="6" disabled onChange={() => undefined} style={{ width: 160 }}>
            <option value="6">Last 6 months</option>
          </Sel>
          <Sel aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }}>
            <option value="all">All statuses</option>
            {statusRows.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Sel>
        </div>
      </div>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {summary === null && error === '' ? <Loading /> : null}
      {summary !== null ? (
        <>
          <div className="sg-grid sg-grid--6">
            <Kpi label="Envelopes sent" value={String(sent)} sub="last 6 months" />
            <Kpi label="Completion rate" value={summary.completion_rate === null ? '—' : `${summary.completion_rate}%`} sub="of envelopes sent" />
            <Kpi label="Avg. time to sign" value={avgDays === null ? '—' : `${avgDays.toFixed(1)}d`} sub="send → last signature" />
            <Kpi label="Outstanding" value={String(summary.awaiting_signatures)} sub="awaiting signers" />
            <Kpi label="Decline rate" value={sent === 0 ? '—' : `${Math.round((declined / Math.max(1, sent)) * 100)}%`} sub="declined" color="var(--bad)" />
            <Kpi label="Expired" value={String(summary.counts.expired)} sub="all time" color="var(--warn)" />
          </div>
          <div className="sg-grid sg-grid--main" style={{ marginTop: 14 }}>
            <section className="sg-card">
              <div className="sg-card__head">Envelope volume by month</div>
              <div className="sg-card__body">
                <Bars months={summary.months} />
                <div className="sg-muted" style={{ display: 'flex', gap: 14, fontSize: 12, marginTop: 10 }}>
                  <span>
                    <span className="sg-swatch" style={{ background: 'var(--accent)', display: 'inline-block', marginRight: 4 }} />
                    Completed
                  </span>
                  <span>
                    <span className="sg-swatch" style={{ background: '#A9B8F1', display: 'inline-block', marginRight: 4 }} />
                    In progress / other
                  </span>
                  <span>
                    <span className="sg-swatch" style={{ background: '#F6D9D6', display: 'inline-block', marginRight: 4 }} />
                    Declined / expired
                  </span>
                </div>
              </div>
            </section>
            <section className="sg-card">
              <div className="sg-card__head">By status</div>
              <div className="sg-card__body">
                {shownStatus.map(([k, l, n]) => (
                  <div key={k} className="sg-hbar">
                    <span>{l}</span>
                    <span className="sg-hbar__track">
                      <span style={{ display: 'block', height: '100%', width: `${(n / maxStatus) * 100}%`, background: colors[k] }} />
                    </span>
                    <strong style={{ textAlign: 'right' }}>{n}</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="sg-card sg-stat">
      <div className="sg-stat__l">{label}</div>
      <div className="sg-stat__n">{value}</div>
      <div className="sg-stat__s" style={color !== undefined ? { color } : undefined}>
        {sub}
      </div>
    </div>
  );
}

// DOC-TEMPLATE-LIB-1 T-5 — the Templates page moved to ./Templates.tsx (no longer a future capability).

