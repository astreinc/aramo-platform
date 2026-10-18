import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { errorMessage, senderApi, type EnvelopeList as EnvelopeListData, type EnvelopeStatus } from '../api';
import { Check, ErrorBox, Loading, Sel, StatusPill, TextIn, fmtDate, rel } from '../ui';
import { useWorkspace } from '../workspace';

// Envelopes — tabs All / Drafts / Waiting for others / Completed / Declined /
// Voided / Expired (prototype), with a subject/recipient filter, a date range and
// a sort. Draft rows open the wizard; everything else opens the read-only detail.

const TABS: { key: string; label: string; statuses: EnvelopeStatus[] | null }[] = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'drafts', label: 'Drafts', statuses: ['DRAFT'] },
  { key: 'waiting', label: 'Waiting for others', statuses: ['SENT', 'IN_PROGRESS'] },
  { key: 'completed', label: 'Completed', statuses: ['COMPLETED'] },
  { key: 'declined', label: 'Declined', statuses: ['DECLINED'] },
  { key: 'voided', label: 'Voided', statuses: ['VOIDED'] },
  { key: 'expired', label: 'Expired', statuses: ['EXPIRED'] },
];

export function EnvelopeList() {
  const { ctx, base } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? (params.get('tab') as string) : 'all';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [days, setDays] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<'recent' | 'subject' | 'status'>('recent');
  const [data, setData] = useState<EnvelopeListData | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setQ(params.get('q') ?? '');
  }, [params]);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      senderApi
        .list({ tab, q, ...(days !== undefined ? { days } : {}) })
        .then((d) => {
          if (live) {
            setData(d);
            setError('');
          }
        })
        .catch((e: unknown) => {
          if (live) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, q, days]);

  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    if (sort === 'subject') items.sort((a, b) => a.subject.localeCompare(b.subject));
    if (sort === 'status') items.sort((a, b) => a.status.localeCompare(b.status));
    return items;
  }, [data, sort]);

  const count = (statuses: EnvelopeStatus[] | null): number => {
    const c = data?.counts ?? {};
    if (statuses === null) return Object.values(c).reduce((a, b) => a + (b ?? 0), 0);
    return statuses.reduce((a, s) => a + (c[s] ?? 0), 0);
  };
  const selected = Object.values(sel).filter(Boolean).length;

  return (
    <div className="sg-page sg-page--wide">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Envelopes</h1>
        {ctx.can_send ? (
          <div className="sg-pagehead__end">
            <Link className="sg-btn sg-btn--primary" to={`${base}/envelopes/new`}>
              + New envelope
            </Link>
          </div>
        ) : null}
      </div>
      <nav className="sg-tabs" aria-label="Envelope status">
        {TABS.map((t) => (
          <Link
            key={t.key}
            className={t.key === tab ? 'sg-tab sg-tab--on' : 'sg-tab'}
            aria-current={t.key === tab ? 'page' : undefined}
            to={`${base}/envelopes${t.key === 'all' ? '' : `?tab=${t.key}`}`}
            onClick={() => setSel({})}
          >
            {t.label}
            <span className="sg-tab__n">{data === null ? '' : count(t.statuses)}</span>
          </Link>
        ))}
      </nav>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <TextIn
          aria-label="Filter by subject or recipient"
          placeholder="Filter by subject or recipient"
          style={{ maxWidth: 260 }}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            const next = new URLSearchParams(params);
            if (e.target.value === '') next.delete('q');
            else next.set('q', e.target.value);
            setParams(next, { replace: true });
          }}
        />
        <Sel aria-label="Date range" style={{ maxWidth: 140 }} value={days === undefined ? 'all' : String(days)} onChange={(e) => setDays(e.target.value === 'all' ? undefined : Number(e.target.value))}>
          <option value="all">Any date</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Sel>
        <Sel aria-label="Sort" style={{ maxWidth: 160 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="recent">Most recent</option>
          <option value="subject">Subject A–Z</option>
          <option value="status">Status</option>
        </Sel>
        {selected > 0 ? <span className="sg-muted" style={{ alignSelf: 'center' }}>{selected} selected</span> : null}
      </div>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      {data === null && error === '' ? <Loading /> : null}
      {data !== null ? (
        <section className="sg-card">
          <div className="sg-tablewrap">
            <table className="sg-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} aria-label="Select" />
                  <th>Subject</th>
                  <th>Recipients</th>
                  <th>Status</th>
                  <th>Last activity</th>
                  <th>Sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="sg-empty">
                        <div className="sg-empty__t">No envelopes here</div>
                        {q !== '' ? 'Try a different filter.' : null}
                      </div>
                    </td>
                  </tr>
                ) : null}
                {rows.map((e) => (
                  <tr key={e.id} data-testid={`envelope-row-${e.id}`}>
                    <td>
                      <Check aria-label={`Select ${e.subject}`} checked={sel[e.id] === true} onChange={(ev) => setSel((s) => ({ ...s, [e.id]: ev.target.checked }))} />
                    </td>
                    <td>
                      <Link to={`${base}/envelopes/${e.id}${e.status === 'DRAFT' && ctx.can_send ? '/edit?step=1' : ''}`} style={{ color: 'var(--ink)', fontWeight: 600 }}>
                        {e.subject}
                      </Link>
                      <div className="sg-mono sg-faint" style={{ fontSize: 11.5 }}>
                        {e.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="sg-muted">{e.recipients.map((r) => r.name).join(', ') || '—'}</td>
                    <td>
                      <StatusPill status={e.status} />
                    </td>
                    <td className="sg-muted">{rel(e.last_activity_at)}</td>
                    <td className="sg-muted">{e.sent_at === null ? '—' : fmtDate(e.sent_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sg-table__foot">
            <span>
              {rows.length} of {count(TABS.find((t) => t.key === tab)?.statuses ?? null)} envelopes
            </span>
            <span>Page 1 of 1</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}
